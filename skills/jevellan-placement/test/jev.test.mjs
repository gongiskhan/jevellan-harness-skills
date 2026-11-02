// The Jev client and its command line (scripts/jev.mjs). Where the key may go: JH_JEV_URL exists for test servers and
// is accepted only for http on the loopback interface; anything else is refused when the client is made, before the
// key is read or a request is sent. And `jev.mjs decide`, the public way for another skill to ask Jev: stdin {state,
// questions}, one call with providers.json's Jev model, {jevModel, answeredBy, answers, usage, latencyMs} printed,
// every failure exit 2 "Jev: <message>". Requests go to fakes: a recording fetch, and an http server on 127.0.0.1 that
// counts every connection it gets. Runs with only this skill present.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR, runNode, startJev, tempDir, writeJson } from './helpers/fixture.mjs';
import { JEV_API, JevClient, JevError, STATE_LIMIT, jevBase, jevClient, jevMessage } from '../scripts/jev.mjs';

const JEV_CLI = path.join(SKILL_DIR, 'scripts', 'jev.mjs');
// A fixture value, never a real key.
const KEY = `fixture-jev-key-${crypto.randomBytes(8).toString('hex')}`;
const RULE = 'must be an http URL on 127.0.0.1, localhost or [::1] (it exists for tests, and the Jev key may only go to the real API or this machine)';

// A fetch that records every call and answers GET /models.
function recordingFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers.Authorization });
    return new Response(JSON.stringify({ models: [{ name: 'jev-test', description: '', release_date: '2026-10-22' }] }), { status: 200 });
  };
  return { calls, fetchImpl };
}

function keyCounter() {
  const counter = { reads: 0 };
  counter.key = () => {
    counter.reads += 1;
    return KEY;
  };
  return counter;
}

function withEnv(value, fn) {
  const had = Object.hasOwn(process.env, 'JH_JEV_URL');
  const old = process.env.JH_JEV_URL;
  if (value === undefined) delete process.env.JH_JEV_URL;
  else process.env.JH_JEV_URL = value;
  try {
    return fn();
  } finally {
    if (had) process.env.JH_JEV_URL = old;
    else delete process.env.JH_JEV_URL;
  }
}

let jev;
before(async () => {
  jev = await startJev({ key: KEY, prefix: '/v1' });
});
after(async () => {
  await jev.close();
});

// A harness home whose providers.json names the Jev key file (left out with key: false) and the model jev-test.
function harnessHome({ key = true } = {}) {
  const home = tempDir('jh-jev-home-');
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true, mode: 0o700 });
  const keyFile = path.join(home, 'secrets', 'jev.key');
  if (key) fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  writeJson(path.join(home, 'providers.json'), {
    jev: { keyFile, model: 'jev-test', timeoutMs: 4000 },
    providers: [{ name: 'claude-main', kind: 'claude-subscription', models: [{ id: 'claude-test', label: 'Test', efforts: ['low'] }] }],
  });
  return home;
}

const runCli = (args, env, input) => runNode(JEV_CLI, args, { cwd: SKILL_DIR, env, input });

// ---- the base URL ----------------------------------------------------------------------------------------------

describe('JH_JEV_URL', () => {
  test('unset or empty is the real API; http on 127.0.0.1, localhost or [::1] is accepted without its trailing slashes', () => {
    assert.equal(jevBase(undefined, {}), JEV_API);
    assert.equal(jevBase(undefined, { JH_JEV_URL: '' }), JEV_API);
    assert.equal(jevBase(undefined, { JH_JEV_URL: 'http://127.0.0.1:4100/v1/' }), 'http://127.0.0.1:4100/v1');
    assert.equal(jevBase(undefined, { JH_JEV_URL: 'http://localhost:4100/v1' }), 'http://localhost:4100/v1');
    assert.equal(jevBase(undefined, { JH_JEV_URL: 'http://[::1]:4100' }), 'http://[::1]:4100');
    assert.equal(jevBase('http://127.0.0.1:9/v1', { JH_JEV_URL: 'https://example.com' }), 'http://127.0.0.1:9/v1', 'an explicit baseUrl wins');
  });

  test('anything else is a JevError naming JH_JEV_URL', () => {
    for (const value of [
      'https://example.com/v1',
      'http://example.com/v1',
      'http://127.0.0.1.example.com:4100/v1',
      'https://127.0.0.1:4100/v1',
      'http://0.0.0.0:4100/v1',
      'http://10.0.0.1/v1',
      'http://localhost.example.com/v1',
      'file:///etc/hosts',
    ]) {
      assert.throws(() => jevBase(undefined, { JH_JEV_URL: value }), (error) => {
        assert.ok(error instanceof JevError, value);
        assert.equal(error.kind, 'base-url');
        assert.equal(error.exitCode, 2);
        assert.equal(error.message, `JH_JEV_URL ${RULE}`, value);
        return true;
      });
    }
    assert.throws(() => jevBase(undefined, { JH_JEV_URL: 'not a url' }), { name: 'JevError', message: `JH_JEV_URL is not a URL; it ${RULE}` });
    assert.throws(() => jevBase('https://example.com/v1', {}), { name: 'JevError', message: `the Jev baseUrl ${RULE}` });
    assert.equal(jevMessage(new JevError('base-url', `JH_JEV_URL ${RULE}`)), `Jev: JH_JEV_URL ${RULE}`);
  });

  test('a client is refused before its key is read or a request is made', async () => {
    const fake = recordingFetch();
    const counter = keyCounter();
    withEnv('https://example.com/v1', () => {
      assert.throws(() => new JevClient({ key: counter.key, timeoutMs: 1000, fetch: fake.fetchImpl }), { name: 'JevError', message: `JH_JEV_URL ${RULE}` });
      assert.throws(() => jevClient({ keyFile: '/nonexistent/jev.key', model: 'jev-test' }, { fetch: fake.fetchImpl }), { name: 'JevError' });
    });
    assert.equal(counter.reads, 0);
    assert.deepEqual(fake.calls, []);

    // On the loopback interface the request goes there, with the key.
    const client = withEnv('http://127.0.0.1:4100/v1/', () => new JevClient({ key: counter.key, timeoutMs: 1000, fetch: fake.fetchImpl }));
    await client.models();
    assert.equal(counter.reads, 1);
    assert.deepEqual(fake.calls, [{ url: 'http://127.0.0.1:4100/v1/models', authorization: `Bearer ${KEY}` }]);
  });

  test('jev.mjs models: a non-loopback JH_JEV_URL is exit 2 naming it, and no connection is made', async () => {
    jev.reset();
    const home = harnessHome();
    jev.models = ['jev-test'];
    const before = jev.connections;
    // 0.0.0.0 reaches the fake on this machine, so a request sent anyway would be counted.
    const refused = await runCli(['models', '--json'], { JH_HARNESS_HOME: home, JH_JEV_URL: `http://0.0.0.0:${jev.port}/v1` });
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(refused.stderr, `Jev: JH_JEV_URL ${RULE}\n`);
    assert.deepEqual(refused.json(), { ok: false, error: `Jev: JH_JEV_URL ${RULE}`, exitCode: 2 });
    assert.equal(jev.connections, before, 'no connection reached the server');
    assert.equal(refused.stdout.includes(KEY) || refused.stderr.includes(KEY), false);

    // The same server named on 127.0.0.1 answers, with the key.
    const ok = await runCli(['models', '--json'], { JH_HARNESS_HOME: home, JH_JEV_URL: jev.url });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(ok.json(), { ok: true, model: 'jev-test', models: ['jev-test'] });
    assert.deepEqual(jev.requests.map((r) => ({ method: r.method, url: r.path, authorized: r.authorized })), [{ method: 'GET', url: '/v1/models', authorized: true }]);
  });

  test('jev.mjs models: the configured model not listed is exit 2; an unusable providers.json is exit 2 with its message', async () => {
    jev.reset();
    const home = harnessHome();
    const unlisted = await runCli(['models', '--json'], { JH_HARNESS_HOME: home, JH_JEV_URL: jev.url });
    assert.equal(unlisted.status, 2);
    assert.deepEqual(unlisted.json(), { ok: false, model: 'jev-test', models: ['jev-latest', 'jev-preview'], error: 'Jev: the configured model jev-test is not listed', exitCode: 2 });
    const nothing = tempDir('jh-jev-empty-');
    const missing = await runCli(['models', '--json'], { JH_HARNESS_HOME: nothing, JH_JEV_URL: jev.url });
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr, `cannot read ${path.join(nothing, 'providers.json')}: ENOENT\n`);
    assert.deepEqual(missing.json(), { ok: false, error: `cannot read ${path.join(nothing, 'providers.json')}: ENOENT`, exitCode: 2 });
    const usage = await runCli(['nonsense'], { JH_HARNESS_HOME: home });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /^usage: node jev\.mjs models \[--json\]\n {7}node jev\.mjs decide \[--json\]/);
  });
});

// ---- decide ------------------------------------------------------------------------------------------------------

const STATE = JSON.stringify({ task: { id: 'T4K2M9Q', title: 'Land the README section' }, files: ['README.md'] });
const QUESTIONS = {
  landing_route: {
    type: 'choice',
    instructions: 'Choose how this task lands.',
    criteria: { land: 'Small and tested: land it.', 'verify-then-land': 'Run a verify step first.', 'ask-owner': 'Ask the owner.' },
  },
  risky: { type: 'noul', instructions: 'Does it touch a risky path?', criteria: { true: 'It does.', false: 'It does not.' } },
};

describe('jev.mjs decide', () => {
  test('asks Jev the questions on stdin with the configured model and prints the answers, the usage and the latency', async () => {
    jev.reset();
    const home = harnessHome();
    jev.picks = { landing_route: 'verify-then-land', risky: 0.2 };
    const r = await runCli(['decide', '--json'], { JH_HARNESS_HOME: home, JH_JEV_URL: jev.url }, { state: STATE, questions: QUESTIONS });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const out = r.json();
    assert.deepEqual(Object.keys(out), ['jevModel', 'answeredBy', 'answers', 'usage', 'latencyMs']);
    assert.equal(out.jevModel, 'jev-test');
    assert.equal(out.answeredBy, 'jev-test-1');
    assert.deepEqual(out.answers.landing_route, { type: 'choice', choice: 'verify-then-land', probabilities: { land: 0.15, 'verify-then-land': 0.7, 'ask-owner': 0.15 }, confidence: 0.8 });
    assert.deepEqual(out.answers.risky, { type: 'noul', noul: 0.2 });
    assert.deepEqual(out.usage, { input_tokens: 120, output_tokens: 8 });
    assert.ok(Number.isInteger(out.latencyMs) && out.latencyMs >= 0);
    // One POST, with the key, carrying exactly the state and questions given.
    assert.equal(jev.requests.length, 1);
    assert.equal(jev.requests[0].method, 'POST');
    assert.equal(jev.requests[0].path, '/v1/systemone');
    assert.equal(jev.requests[0].authorized, true);
    assert.deepEqual(jev.requests[0].body, { model: 'jev-test', state: STATE, questions: QUESTIONS });
    assert.equal(r.stdout.includes(KEY), false);

    // Without --json the answer is the same JSON.
    jev.reset();
    const plain = await runCli(['decide'], { JH_HARNESS_HOME: home, JH_JEV_URL: jev.url }, { state: STATE, questions: QUESTIONS });
    assert.equal(plain.status, 0, plain.stderr);
    assert.deepEqual(Object.keys(plain.json()), ['jevModel', 'answeredBy', 'answers', 'usage', 'latencyMs']);
  });

  test('every Jev failure is exit 2 with "Jev: <message>" on stderr and {error, exitCode} on stdout; the key never shows', async () => {
    const home = harnessHome();
    const env = { JH_HARNESS_HOME: home, JH_JEV_URL: jev.url };
    const cases = [
      ['no key', { env: { JH_HARNESS_HOME: harnessHome({ key: false }), JH_JEV_URL: jev.url } }, 'Jev: no key configured', 0],
      ['401', { queue: [401] }, 'Jev: authentication failed', 1],
      ['500 twice', { queue: [500, 500] }, 'Jev: service unavailable', 2],
      ['an invalid answer', { queue: [(body, send) => send(200, { model: 'jev-test-1', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } })] }, 'Jev: invalid response', 1],
      ['not JSON from Jev', { queue: [(body, send) => send(200, 'not json')] }, 'Jev: invalid response', 1],
      ['stdin not JSON', { input: '{nope' }, 'Jev: invalid request (stdin must be one JSON object {"state": "<JSON text>", "questions": {...}})', 0],
      ['no questions', { input: { state: STATE } }, 'Jev: invalid request (stdin must be one JSON object {"state": "<JSON text>", "questions": {...}})', 0],
      ['a state that is not JSON text', { input: { state: 'plain words', questions: QUESTIONS } }, 'Jev: invalid request', 0],
      ['a choice with one option', { input: { state: STATE, questions: { q: { type: 'choice', instructions: 'i', criteria: { only: 'the one' } } } } }, 'Jev: invalid request', 0],
      ['a state over the limit', { input: { state: JSON.stringify({ text: 'x'.repeat(STATE_LIMIT) }), questions: QUESTIONS } }, 'Jev: decision context exceeds the size limit', 0],
      ['a JH_JEV_URL off the loopback interface', { env: { ...env, JH_JEV_URL: `http://0.0.0.0:${jev.port}/v1` } }, `Jev: JH_JEV_URL ${RULE}`, 0],
    ];
    for (const [name, { env: caseEnv = env, queue = [], input = { state: STATE, questions: QUESTIONS } }, message, requests] of cases) {
      jev.reset();
      jev.queue.push(...queue);
      const connections = jev.connections;
      const r = await runCli(['decide', '--json'], caseEnv, input);
      assert.equal(r.status, 2, `${name}: ${r.stderr}`);
      assert.equal(r.stderr, `${message}\n`, name);
      assert.deepEqual(r.json(), { error: message, exitCode: 2 }, name);
      assert.equal(jev.requests.length, requests, name);
      if (requests === 0) assert.equal(jev.connections, connections, `${name}: no connection`);
      assert.equal(r.stdout.includes(KEY) || r.stderr.includes(KEY), false, name);
    }

    // Without --json a failure is the message on stderr only.
    jev.reset();
    jev.queue.push(401);
    const plain = await runCli(['decide'], env, { state: STATE, questions: QUESTIONS });
    assert.equal(plain.status, 2);
    assert.equal(plain.stdout, '');
    assert.equal(plain.stderr, 'Jev: authentication failed\n');
  });

  test('an unusable providers.json is exit 2 with its own message, before Jev is reached', async () => {
    jev.reset();
    const home = tempDir('jh-jev-bad-');
    writeJson(path.join(home, 'providers.json'), { jev: { model: 'jev-test' }, providers: [] });
    const r = await runCli(['decide', '--json'], { JH_HARNESS_HOME: home, JH_JEV_URL: jev.url }, { state: STATE, questions: QUESTIONS });
    assert.equal(r.status, 2);
    assert.deepEqual(r.json(), { error: 'providers.json: jev.keyFile is required', exitCode: 2 });
    assert.equal(r.stderr, 'providers.json: jev.keyFile is required\n');
    assert.equal(jev.requests.length, 0);
  });
});
