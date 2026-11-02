#!/usr/bin/env node
// The Jev client, ported from the skills repo's jev/client.ts and jev/contract.ts (themselves ported from
// Jevellan's packages/decisions): POST https://api.typesafe.ai/v1/systemone with a Bearer key, two attempts on 429
// and 5xx with a one second pause, a timeout from providers.json, error bodies never read. zod is replaced by hand
// validation with the same rules. The key is read from the file providers.json names (jev.keyFile) at the moment of
// each call and never cached, printed or logged.
//
// JH_JEV_URL overrides the API base, for tests with a fake server.
//
//   node jev.mjs models [--json]     lists the models the key can use (a check that Jev answers)

import fs from 'node:fs';

export const JEV_API = 'https://api.typesafe.ai/v1';

const MESSAGES = {
  'no-key': 'no key configured',
  auth: 'authentication failed',
  'rate-limited': 'rate limited',
  unavailable: 'service unavailable',
  timeout: 'request timed out',
  network: 'connection failed',
  'invalid-request': 'invalid request',
  'invalid-response': 'invalid response',
  cancelled: 'decision cancelled',
  'state-too-large': 'decision context exceeds the size limit',
};

export class JevError extends Error {
  constructor(kind) {
    super(MESSAGES[kind] ?? kind);
    this.name = 'JevError';
    this.kind = kind;
    this.exitCode = 2;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const isProbability = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const QUESTION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

function validQuestion(q) {
  if (!isObject(q) || !isText(q.instructions)) return false;
  const keys = Object.keys(q);
  if (q.type === 'choice') {
    if (keys.some((k) => !['type', 'instructions', 'criteria'].includes(k))) return false;
    if (!isObject(q.criteria)) return false;
    const entries = Object.entries(q.criteria);
    return entries.length >= 2 && entries.length <= 255 && entries.every(([k, v]) => isText(k) && isText(v));
  }
  if (q.type === 'score') {
    if (keys.some((k) => !['type', 'instructions', 'criteria'].includes(k))) return false;
    return Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10 && q.criteria.every(isText);
  }
  if (q.type === 'noul') {
    if (keys.some((k) => !['type', 'instructions', 'criteria'].includes(k))) return false;
    return isObject(q.criteria) && Object.keys(q.criteria).length === 2 && isText(q.criteria.true) && isText(q.criteria.false);
  }
  return false;
}

export function buildJevRequest({ model, state, questions }) {
  if (!isText(model) || typeof state !== 'string' || !isObject(questions)) throw new JevError('invalid-request');
  try {
    JSON.parse(state);
  } catch {
    throw new JevError('invalid-request');
  }
  const ids = Object.keys(questions);
  if (ids.length === 0 || !ids.every((id) => QUESTION_ID.test(id) && validQuestion(questions[id]))) throw new JevError('invalid-request');
  return { model, state, questions };
}

function sameKeys(actual, keys) {
  return isObject(actual) && Object.keys(actual).length === keys.length && keys.every((k) => Object.hasOwn(actual, k));
}

function distribution(value, keys) {
  if (!sameKeys(value, keys) || !Object.values(value).every(isProbability)) return false;
  return Math.abs(Object.values(value).reduce((sum, p) => sum + p, 0) - 1) <= 0.02 + Number.EPSILON;
}

function validAnswer(answer, question) {
  if (!isObject(answer) || answer.type !== question.type) return false;
  if (answer.type === 'choice') {
    if (Object.keys(answer).some((k) => !['type', 'choice', 'probabilities', 'confidence'].includes(k))) return false;
    if (!isText(answer.choice) || !isProbability(answer.confidence)) return false;
    const keys = Object.keys(question.criteria);
    if (!Object.hasOwn(question.criteria, answer.choice) || !distribution(answer.probabilities, keys)) return false;
    return answer.probabilities[answer.choice] >= Math.max(...Object.values(answer.probabilities)) - 0.011;
  }
  if (answer.type === 'score') {
    if (Object.keys(answer).some((k) => !['type', 'score', 'legend', 'probabilities', 'confidence'].includes(k))) return false;
    const keys = question.criteria.map((_, i) => String(i));
    return typeof answer.score === 'number' && isProbability(answer.confidence) && distribution(answer.probabilities, keys)
      && sameKeys(answer.legend, keys) && answer.score >= 0 && answer.score <= keys.length - 1;
  }
  if (answer.type === 'noul') {
    return Object.keys(answer).every((k) => ['type', 'noul'].includes(k)) && isProbability(answer.noul);
  }
  return false;
}

export function parseJevResponse(body, questions) {
  let wire;
  try {
    wire = JSON.parse(body);
  } catch {
    throw new JevError('invalid-response');
  }
  if (!isObject(wire) || !isText(wire.model) || !isObject(wire.answers) || !isObject(wire.usage)) throw new JevError('invalid-response');
  if (Object.keys(wire).some((k) => !['model', 'answers', 'usage'].includes(k))) throw new JevError('invalid-response');
  const { input_tokens: input, output_tokens: output } = wire.usage;
  if (!Number.isInteger(input) || input < 0 || !Number.isInteger(output) || output < 0) throw new JevError('invalid-response');
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(wire.answers, id) ? wire.answers[id] : undefined;
    if (!validAnswer(answer, question)) throw new JevError('invalid-response');
    answers[id] = answer;
  }
  return { schema: 'jev-response-v1', model: wire.model, answers, usage: { input_tokens: input, output_tokens: output } };
}

export function parseJevModels(body) {
  let wire;
  try {
    wire = JSON.parse(body);
  } catch {
    throw new JevError('invalid-response');
  }
  if (!isObject(wire) || !Array.isArray(wire.models)) throw new JevError('invalid-response');
  for (const m of wire.models) {
    if (!isObject(m) || !isText(m.name) || typeof m.description !== 'string' || !isText(m.release_date)) throw new JevError('invalid-response');
  }
  return { schema: 'jev-models-v1', models: wire.models };
}

function expandHome(file, home) {
  if (typeof file !== 'string') return file;
  return file.startsWith('~/') ? `${home}/${file.slice(2)}` : file;
}

export function readKey(keyFile, home) {
  if (!keyFile) return undefined;
  try {
    const value = fs.readFileSync(expandHome(keyFile, home), 'utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new JevError('cancelled'));
  }, { once: true });
});

export class JevClient {
  #key;
  #fetch;
  #timeoutMs;
  #base;
  constructor({ key, timeoutMs, fetch: fetchImpl, baseUrl }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new JevError('invalid-request');
    this.#key = key;
    this.#fetch = fetchImpl ?? fetch;
    this.#timeoutMs = timeoutMs;
    this.#base = (baseUrl ?? process.env.JH_JEV_URL ?? JEV_API).replace(/\/+$/, '');
  }

  async decide(input, signal) {
    const request = buildJevRequest(input);
    return parseJevResponse(await this.#request('systemone', JSON.stringify(request), signal), request.questions);
  }

  async models(signal) {
    return parseJevModels(await this.#request('models', undefined, signal));
  }

  async #request(route, body, signal) {
    if (signal?.aborted) throw new JevError('cancelled');
    let key;
    try {
      key = await this.#key();
    } catch {
      throw new JevError('no-key');
    }
    if (!key?.trim()) throw new JevError('no-key');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) throw new JevError('cancelled');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let retry = false;
      try {
        const response = await this.#fetch(`${this.#base}/${route}`, {
          method: body === undefined ? 'GET' : 'POST',
          redirect: 'error',
          signal: combined,
          headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body }),
        });
        if (response.ok) return await response.text();
        const status = response.status;
        // Error bodies can echo inputs or authentication; they are never read or stored.
        await response.body?.cancel();
        retry = attempt === 0 && (status === 429 || status >= 500);
        if (!retry) throw new JevError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limited' : status >= 500 ? 'unavailable' : 'invalid-request');
      } catch (error) {
        if (signal?.aborted) throw new JevError('cancelled');
        if (controller.signal.aborted) throw new JevError('timeout');
        if (error instanceof JevError) throw error;
        throw new JevError('network');
      } finally {
        clearTimeout(timer);
      }
      if (retry) await pause(1000, signal);
    }
    throw new JevError('unavailable');
  }
}

// A client for providers.json's jev settings {keyFile, model, timeoutMs}; the key file is read on every request.
export function jevClient(jev, { home, fetch: fetchImpl, timeoutMs, baseUrl } = {}) {
  return new JevClient({
    key: () => readKey(jev?.keyFile, home ?? process.env.HOME),
    timeoutMs: timeoutMs ?? jev?.timeoutMs ?? 4000,
    fetch: fetchImpl,
    baseUrl,
  });
}

// "Jev: <message>", the form every script prints when Jev refuses.
export function jevMessage(error) {
  return error instanceof JevError ? `Jev: ${error.message}` : `Jev: ${error?.message ?? error}`;
}

async function main(argv) {
  const json = argv.includes('--json');
  if (argv[0] !== 'models') {
    process.stderr.write('usage: node jev.mjs models [--json]\n');
    return 2;
  }
  const { loadProviders } = await import('./lib/providers-file.mjs');
  const config = loadProviders();
  try {
    const models = await jevClient(config.jev, { home: config.ownerHome }).models();
    const listed = models.models.map((m) => m.name);
    const out = { ok: listed.includes(config.jev.model), model: config.jev.model, models: listed };
    if (!out.ok) Object.assign(out, { error: `Jev: the configured model ${config.jev.model} is not listed`, exitCode: 2 });
    process.stdout.write(json ? `${JSON.stringify(out)}\n` : `Jev answered; models: ${listed.join(', ')}; configured: ${config.jev.model}${out.ok ? '' : ' (NOT LISTED)'}\n`);
    return out.ok ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${jevMessage(error)}\n`);
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: jevMessage(error), exitCode: 2 })}\n`);
    return 2;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
