// The live check of a claude-endpoint provider (H-044): does it answer the Anthropic Messages requests Claude Code
// sends, in the shapes Claude Code 2.1.323 was seen sending (docs/findings.md)? probe.mjs runs it. Each check is one
// or two requests; none sends anything of a project.
//
// - models: GET /v1/models lists the provider's model;
// - text: a streamed answer with Anthropic's named SSE events (event: + data:), which Claude Code's client needs;
// - tools: a tool loop without thinking (tool_use, then the tool_result answered);
// - tools-thinking: the same loop with thinking {type: adaptive}, the assistant's blocks (thinking included) sent back
//   as returned, which is where a gateway translating to another format breaks first;
// - count-tokens: POST /v1/messages/count_tokens.
//
// The key goes only into the Authorization header; redirects are not followed (a credential never goes elsewhere);
// what is reported never holds the key.

import { RuntimeError, expandHome, readSecret } from './env.mjs';

export const PROBE_BETAS = 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24';
const TIMEOUT_MS = 180_000;
const TOOL = {
  name: 'lookup',
  description: 'Looks up the value stored under a key. Always use it when asked for a stored value.',
  input_schema: { type: 'object', properties: { key: { type: 'string', description: 'The key to look up.' } }, required: ['key'] },
};
const TOOL_PROMPT = 'Use the lookup tool with the key "alpha". Then reply with the value it returned and nothing else.';
const TOOL_VALUE = 'ZEBRA-42';

// Splits an SSE body into events and rebuilds the message's content blocks as Claude Code's client would.
export function parseSse(text) {
  const events = [];
  let named = true;
  for (const chunk of String(text).split(/\r?\n\r?\n/)) {
    if (!chunk.trim()) continue;
    let name = null;
    const data = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;
    if (!name) named = false;
    try {
      events.push({ name, data: JSON.parse(data.join('\n')) });
    } catch {
      events.push({ name, data: null });
    }
  }
  const content = [];
  const partial = new Map();
  let stopReason = null;
  let error = null;
  for (const { data } of events) {
    if (!data) continue;
    if (data.type === 'content_block_start') {
      content[data.index] = { ...data.content_block };
      if (data.content_block?.type === 'tool_use') partial.set(data.index, '');
    } else if (data.type === 'content_block_delta') {
      const block = content[data.index];
      const d = data.delta ?? {};
      if (!block) continue;
      if (d.type === 'text_delta') block.text = (block.text ?? '') + d.text;
      else if (d.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + d.thinking;
      else if (d.type === 'signature_delta') block.signature = (block.signature ?? '') + d.signature;
      else if (d.type === 'input_json_delta') partial.set(data.index, (partial.get(data.index) ?? '') + d.partial_json);
    } else if (data.type === 'content_block_stop' && partial.has(data.index)) {
      const raw = partial.get(data.index);
      try {
        content[data.index].input = raw ? JSON.parse(raw) : {};
      } catch {
        content[data.index].input = { unparsed: raw };
      }
    } else if (data.type === 'message_delta') stopReason = data.delta?.stop_reason ?? stopReason;
    else if (data.type === 'error') error = data.error?.message ?? 'error event';
  }
  return { events: events.map((e) => e.name ?? e.data?.type ?? '?'), named, content: content.filter(Boolean), stopReason, error };
}

function scrub(text, key) {
  const value = String(text ?? '');
  return (key ? value.split(key).join('[key]') : value).replace(/\s+/g, ' ').slice(0, 300);
}

export function probeTarget(provider) {
  if (provider.kind !== 'claude-endpoint') throw new RuntimeError(`provider ${provider.name} is ${provider.kind}; the probe checks claude-endpoint providers`);
  if (!provider.baseUrl || !/^https?:\/\//.test(provider.baseUrl)) throw new RuntimeError(`provider ${provider.name} has no http(s) baseUrl`);
  const base = provider.baseUrl.replace(/\/+$/, '');
  if (/\/v1$/.test(base)) throw new RuntimeError(`provider ${provider.name}: baseUrl must be the origin without /v1 (Claude Code adds /v1/messages itself), not ${provider.baseUrl}`);
  const key = readSecret(expandHome(provider.keyFile));
  if (!key) throw new RuntimeError(`provider ${provider.name}: key file ${provider.keyFile ?? '(none named)'} is missing or empty`);
  return { base, key, model: provider.models[0]?.id };
}

async function call(target, method, route, body, fetchImpl) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${target.base}${route}`, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${target.key}`,
        'anthropic-version': '2023-06-01',
        ...(body ? { 'content-type': 'application/json', 'anthropic-beta': PROBE_BETAS } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, type: response.headers.get('content-type') ?? '', text, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, type: '', text: error.name === 'AbortError' ? `no answer in ${TIMEOUT_MS / 1000} s` : error.message, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const messagesBody = (model, messages, extra = {}) => ({ model, max_tokens: 2048, stream: true, messages, ...extra });

async function toolLoop(target, fetchImpl, thinking) {
  const extra = { tools: [TOOL], output_config: { effort: 'medium' }, ...(thinking ? { thinking: { type: 'adaptive' } } : {}) };
  const first = [{ role: 'user', content: TOOL_PROMPT }];
  const a = await call(target, 'POST', '/v1/messages?beta=true', messagesBody(target.model, first, extra), fetchImpl);
  if (a.status !== 200) return { ok: false, status: a.status, ms: a.ms, detail: `first turn: HTTP ${a.status} ${scrub(a.text, target.key)}` };
  const one = parseSse(a.text);
  const use = one.content.find((b) => b.type === 'tool_use');
  if (!use) return { ok: false, status: a.status, ms: a.ms, detail: `first turn: no tool_use (stop ${one.stopReason}, blocks ${one.content.map((b) => b.type).join(',') || 'none'}${one.error ? `, error ${scrub(one.error, target.key)}` : ''})` };
  const thoughts = one.content.filter((b) => b.type === 'thinking').length;
  const second = [...first, { role: 'assistant', content: one.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: TOOL_VALUE }] }];
  const b = await call(target, 'POST', '/v1/messages?beta=true', messagesBody(target.model, second, extra), fetchImpl);
  const ms = a.ms + b.ms;
  if (b.status !== 200) return { ok: false, status: b.status, ms, detail: `tool_result turn: HTTP ${b.status} ${scrub(b.text, target.key)}` };
  const two = parseSse(b.text);
  const answer = two.content.filter((x) => x.type === 'text').map((x) => x.text).join('');
  const ok = answer.includes(TOOL_VALUE) && !two.error;
  return { ok, status: b.status, ms, detail: `tool_use ${use.name}(${JSON.stringify(use.input)}), ${thoughts} thinking block(s) sent back; answer ${JSON.stringify(scrub(answer, target.key))}${two.error ? `; error ${scrub(two.error, target.key)}` : ''}` };
}

// Runs every check; returns {provider, model, base, checks: [{name, ok, status, ms, detail}], ok, thinking}, where
// `thinking` says whether the provider's sessions can keep thinking on in tool loops.
export async function probe(provider, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const target = probeTarget(provider);
  const checks = [];
  const models = await call(target, 'GET', '/v1/models', null, fetchImpl);
  let listed = false;
  try {
    listed = (JSON.parse(models.text).data ?? []).some((m) => m.id === target.model);
  } catch {}
  checks.push({ name: 'models', ok: models.status === 200 && listed, status: models.status, ms: models.ms, detail: models.status === 200 ? (listed ? `${target.model} listed` : `${target.model} not listed`) : scrub(models.text, target.key) });

  const text = await call(target, 'POST', '/v1/messages?beta=true', messagesBody(target.model, [{ role: 'user', content: 'Reply with the single word PONG.' }]), fetchImpl);
  const parsed = text.status === 200 ? parseSse(text.text) : null;
  const said = parsed ? parsed.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
  checks.push({
    name: 'text',
    ok: Boolean(parsed && parsed.named && /pong/i.test(said) && /event-stream/.test(text.type)),
    status: text.status,
    ms: text.ms,
    detail: parsed ? `${parsed.named ? 'named' : 'UNNAMED'} SSE events (${[...new Set(parsed.events)].join(', ')}), ${text.type}; answer ${JSON.stringify(scrub(said, target.key))}` : scrub(text.text, target.key),
  });

  checks.push({ name: 'tools', ...(await toolLoop(target, fetchImpl, false)) });
  checks.push({ name: 'tools-thinking', ...(await toolLoop(target, fetchImpl, true)) });

  const count = await call(target, 'POST', '/v1/messages/count_tokens?beta=true', { model: target.model, messages: [{ role: 'user', content: 'Count these tokens.' }] }, fetchImpl);
  let counted = null;
  try {
    counted = JSON.parse(count.text).input_tokens;
  } catch {}
  checks.push({ name: 'count-tokens', ok: count.status === 200 && Number.isInteger(counted), status: count.status, ms: count.ms, detail: count.status === 200 ? `input_tokens ${counted}` : scrub(count.text, target.key) });

  const need = ['text', 'tools'];
  const ok = checks.filter((c) => need.includes(c.name)).every((c) => c.ok);
  const thinking = checks.find((c) => c.name === 'tools-thinking').ok;
  return { provider: provider.name, model: target.model, base: target.base, checks, ok, thinking };
}
