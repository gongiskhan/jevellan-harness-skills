// The placement skill's Jev client (skills/jevellan-router/scripts/jev.mjs): where the key may go. JH_JEV_URL exists
// for test servers and is accepted only for http on the loopback interface; anything else is refused when the client
// is made, before the key is read or a request is sent. Requests go to fakes: a recording fetch, and an http server
// on 127.0.0.1 that counts every connection it gets.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { NODE, REPO, childEnv, tempDir, writeJson } from './helpers/ledger-fixture.mjs';
import { JEV_API, JevClient, JevError, jevBase, jevClient, jevMessage } from '../skills/jevellan-router/scripts/jev.mjs';

const JEV_CLI = path.join(REPO, 'skills', 'jevellan-router', 'scripts', 'jev.mjs');
// A fixture value, never a real key.
const KEY = `fixture-jev-key-${crypto.randomBytes(8).toString('hex')}`;
const RULE = 'must be an http URL on 127.0.0.1, localhost or [::1] (it exists for tests, and the Jev key may only go to the real API or this machine)';

delete process.env.JH_JEV_URL;

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

// ---- the fake Jev on 127.0.0.1 ---------------------------------------------------------------------------------

const server = { connections: 0, requests: [] };
const httpServer = http.createServer((req, res) => {
  // The key is compared and never stored.
  server.requests.push({ method: req.method, url: req.url, authorized: req.headers.authorization === `Bearer ${KEY}` });
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'jev-test', description: '', release_date: '2026-10-22' }] }));
    return;
  }
  res.writeHead(404).end();
});
httpServer.on('connection', () => {
  server.connections += 1;
});
let PORT = 0;
before(async () => {
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  PORT = httpServer.address().port;
});
after(() => {
  httpServer.closeAllConnections();
  httpServer.close();
});

function harnessHome() {
  const home = tempDir('jh-jev-home-');
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true, mode: 0o700 });
  const keyFile = path.join(home, 'secrets', 'jev.key');
  fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  writeJson(path.join(home, 'providers.json'), {
    jev: { keyFile, model: 'jev-test', timeoutMs: 4000 },
    providers: [{ name: 'claude-main', kind: 'claude-subscription', models: [{ id: 'claude-test', label: 'Test', efforts: ['low'] }] }],
  });
  return home;
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [JEV_CLI, ...args], { cwd: REPO, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) }));
  });
}

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
    const home = harnessHome();
    const before = server.connections;
    // 0.0.0.0 reaches the fake on this machine, so a request sent anyway would be counted.
    const refused = await runCli(['models', '--json'], { JH_HARNESS_HOME: home, JH_JEV_URL: `http://0.0.0.0:${PORT}/v1` });
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(refused.stderr, `Jev: JH_JEV_URL ${RULE}\n`);
    assert.deepEqual(refused.json(), { ok: false, error: `Jev: JH_JEV_URL ${RULE}`, exitCode: 2 });
    assert.equal(server.connections, before, 'no connection reached the server');
    assert.equal(refused.stdout.includes(KEY) || refused.stderr.includes(KEY), false);

    // The same server named on 127.0.0.1 answers, with the key.
    const requests = server.requests.length;
    const ok = await runCli(['models', '--json'], { JH_HARNESS_HOME: home, JH_JEV_URL: `http://127.0.0.1:${PORT}/v1` });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(ok.json(), { ok: true, model: 'jev-test', models: ['jev-test'] });
    assert.deepEqual(server.requests.slice(requests), [{ method: 'GET', url: '/v1/models', authorized: true }]);
  });
});
