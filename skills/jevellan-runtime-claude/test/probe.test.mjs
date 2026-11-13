// The live check (lib/probe.mjs, probe.mjs) against a loopback Messages server, alone: every check passing, a gateway
// that refuses thinking in tool loops, one that streams without named events, the refusals, and the key never shown.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HARNESS_HOME, NODE, SKILL_DIR, tempDir, writeProviders } from './helpers/fakes.mjs';
import { parseSse, probe, probeTarget } from '../scripts/lib/probe.mjs';

const KEY = 'fake-probe-key-0123456789';
const MODEL = 'probe-model';
let server;
let base;
let mode = 'good';
const seen = [];

function sse(res, blocks, { named = true } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (name, data) => res.write(`${named ? `event: ${name}\n` : ''}data: ${JSON.stringify({ type: name, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [], usage: { input_tokens: 5, output_tokens: 0 } } });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'thinking') {
      ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
      ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig-1' } });
    } else {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: 'toolu_1', name: block.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: '{"key":' } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: '"alpha"}' } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 3 } });
  ev('message_stop', {});
  res.end();
}

before(async () => {
  const { secrets } = writeProviders();
  fs.writeFileSync(path.join(secrets, 'probe.key'), `${KEY}\n`, { mode: 0o600 });
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, beta: req.headers['anthropic-beta'], body });
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Authentication Error', type: 'auth_error' } }));
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: MODEL }] }));
      }
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"input_tokens":11}');
      }
      if (mode === 'no-thinking' && body.thinking) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `reasoning_content must be passed back; key ${KEY}`, type: 'invalid_request_error' } }));
      }
      const last = body.messages.at(-1);
      const result = Array.isArray(last.content) ? last.content.find((c) => c.type === 'tool_result') : null;
      const thinking = body.thinking ? [{ type: 'thinking', thinking: 'I should look it up.' }] : [];
      if (result) return sse(res, [{ type: 'text', text: result.content }]);
      if (body.tools) return sse(res, [...thinking, { type: 'tool_use', name: 'lookup' }]);
      return sse(res, [{ type: 'text', text: 'PONG' }], { named: mode !== 'unnamed' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(HARNESS_HOME, 'providers.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const probeProvider = { name: 'probe-test', kind: 'claude-endpoint', baseUrl: base, keyFile: path.join(secrets, 'probe.key'), placement: false, projects: ['/nowhere'], models: [{ id: MODEL, efforts: ['low'] }] };
  config.providers.push(probeProvider, { ...probeProvider, name: 'v1-test', baseUrl: `${base}/v1` });
  fs.writeFileSync(file, JSON.stringify(config));
});

after(() => server?.close());

const provider = (over = {}) => ({ name: 'probe-test', kind: 'claude-endpoint', baseUrl: base, keyFile: path.join(HARNESS_HOME, 'secrets', 'probe.key'), models: [{ id: MODEL, efforts: ['low'] }], ...over });

describe('the live check', () => {
  test('every check passes on a server that speaks Messages; the thinking blocks go back as they came', async () => {
    mode = 'good';
    seen.length = 0;
    const out = await probe(provider());
    assert.deepEqual(out.checks.map((c) => [c.name, c.ok]), [['models', true], ['text', true], ['tools', true], ['tools-thinking', true], ['count-tokens', true]]);
    assert.equal(out.ok, true);
    assert.equal(out.thinking, true);
    assert.ok(seen.every((r) => r.auth === `Bearer ${KEY}`));
    const posts = seen.filter((r) => r.method === 'POST' && r.url.startsWith('/v1/messages?beta=true'));
    assert.ok(posts.every((r) => r.body.stream === true && r.beta.includes('claude-code-20250219')));
    const back = posts.find((r) => r.body.thinking && r.body.messages.length === 3);
    assert.deepEqual(back.body.messages[1].content.map((b) => b.type), ['thinking', 'tool_use']);
    assert.equal(back.body.messages[1].content[0].signature, 'sig-1');
    assert.deepEqual(back.body.messages[1].content[1].input, { key: 'alpha' });
    assert.match(out.checks.find((c) => c.name === 'tools').detail, /tool_use lookup\(\{"key":"alpha"\}\).*ZEBRA-42/);
  });

  test('a gateway that refuses thinking in tool loops: ok, thinking false, the error shown without the key', async () => {
    mode = 'no-thinking';
    const out = await probe(provider());
    assert.equal(out.ok, true);
    assert.equal(out.thinking, false);
    const check = out.checks.find((c) => c.name === 'tools-thinking');
    assert.equal(check.status, 400);
    assert.match(check.detail, /reasoning_content must be passed back; key \[key\]/);
    assert.ok(!JSON.stringify(out).includes(KEY));
  });

  test('a stream without named events fails the text check (Claude Code\'s client needs them); a wrong key fails everything', async () => {
    mode = 'unnamed';
    let out = await probe(provider());
    assert.equal(out.checks.find((c) => c.name === 'text').ok, false);
    assert.match(out.checks.find((c) => c.name === 'text').detail, /UNNAMED SSE events/);
    assert.equal(out.ok, false);
    mode = 'good';
    const wrong = path.join(tempDir('jh-probe-'), 'wrong.key');
    fs.writeFileSync(wrong, 'not-the-key\n', { mode: 0o600 });
    out = await probe(provider({ keyFile: wrong }));
    assert.ok(out.checks.every((c) => !c.ok && c.status === 401));
  });

  test('refused: another kind, no key, a baseUrl ending in /v1', () => {
    assert.throws(() => probeTarget(provider({ kind: 'claude-subscription' })), /the probe checks claude-endpoint providers/);
    assert.throws(() => probeTarget(provider({ keyFile: '/nonexistent/key' })), /is missing or empty/);
    assert.throws(() => probeTarget(provider({ baseUrl: `${base}/v1/` })), /baseUrl must be the origin without \/v1/);
  });

  test('parseSse rebuilds text, thinking with its signature and a tool call split across deltas', () => {
    const body = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"s"}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t","name":"x","input":{}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
    ].join('\n\n');
    const out = parseSse(body);
    assert.deepEqual(out.content, [{ type: 'thinking', thinking: 'hm', signature: 's' }, { type: 'tool_use', id: 't', name: 'x', input: { a: 1 } }]);
    assert.equal(out.stopReason, 'tool_use');
    assert.equal(out.named, true);
  });
});

describe('probe.mjs', () => {
  const run = (args) => new Promise((resolve) => {
    const child = spawn(NODE, [path.join(SKILL_DIR, 'scripts', 'probe.mjs'), ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, JH_HARNESS_HOME: HARNESS_HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });

  test('prints the checks, exit 0; refusals exit 2 and an unknown provider 3; the key never printed', async () => {
    mode = 'good';
    let r = await run(['--provider', 'probe-test']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^ok {3}models/m);
    assert.match(r.stdout, /probe-test answers Claude Code's requests; thinking in tool loops: works/);
    assert.ok(!r.stdout.includes(KEY));
    r = await run(['--provider', 'probe-test', '--json']);
    assert.equal(JSON.parse(r.stdout).ok, true);
    r = await run(['--provider', 'v1-test', '--json']);
    assert.equal(r.code, 2);
    assert.match(JSON.parse(r.stdout).error, /without \/v1/);
    r = await run(['--provider', 'nobody', '--json']);
    assert.equal(r.code, 3);
    r = await run(['--provider', 'claude-test', '--json']);
    assert.equal(r.code, 2);
    assert.match(JSON.parse(r.stdout).error, /the probe checks claude-endpoint providers/);
  });
});
