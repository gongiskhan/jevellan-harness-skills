// The ledger's write side: concurrent appends keep seq contiguous, oversized lines and unknown kinds are refused,
// the lock survives a dead holder and waits for a live one, secrets are masked, and verify finds gaps.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  HARNESS_HOME,
  LEDGER_CLI,
  NODE,
  childEnv,
  cli,
  deadPid,
  ledgerFile,
  ledgerText,
  libUrl,
  livePid,
  makeRepo,
  readLedger,
  tempDir,
  writeJson,
} from './helpers/ledger-fixture.mjs';
import { LedgerError, MAX_LINE, appendEvent, verifyLedger } from '../skills/jevellan-ledger/scripts/lib/ledger.mjs';
import { LockTimeout, acquire } from '../skills/jevellan-ledger/scripts/lib/lock.mjs';

const WRITERS = 10;
const LINES = 50;

function runChild(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, args, { env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (status) => resolve({ status, stderr }));
  });
}

function assertContiguous(root, writers, lines) {
  const events = readLedger(root);
  assert.equal(events.length, writers * lines);
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: writers * lines }, (_, i) => i + 1));
  // Every writer's lines are all there, in the order that writer appended them.
  for (let w = 0; w < writers; w += 1) {
    const mine = events.filter((e) => e.data.text.startsWith(`writer ${w} `)).map((e) => Number(e.data.text.split(' ')[3]));
    assert.deepEqual(mine, Array.from({ length: lines }, (_, i) => i + 1), `writer ${w}`);
  }
  const verify = cli(root, ['verify']);
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, new RegExp(`ok: ${writers * lines} lines, seq contiguous`));
}

describe('concurrent appends', () => {
  test(`${WRITERS} processes appending ${LINES} lines each through appendEvent keep seq contiguous`, async (t) => {
    const root = makeRepo();
    const script = `
      const { appendEvent } = await import(${JSON.stringify(libUrl('ledger'))});
      const [root, writer, count] = process.argv.slice(1);
      for (let i = 1; i <= Number(count); i += 1) {
        appendEvent(root, { kind: 'note', data: { text: 'writer ' + writer + ' line ' + i } });
      }
    `;
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, w) => runChild(['--input-type=module', '-e', script, root, String(w), String(LINES)])),
    );
    const ms = performance.now() - start;
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    assertContiguous(root, WRITERS, LINES);
    t.diagnostic(`${WRITERS * LINES} library appends from ${WRITERS} processes in ${ms.toFixed(0)} ms`);
  });

  test(`${WRITERS} processes appending ${LINES} lines each through "ledger.mjs append note" keep seq contiguous`, async (t) => {
    const root = makeRepo();
    // Each writer runs the command line once per line, the way hooks and sessions append.
    const script = `
      const { spawnSync } = require('node:child_process');
      const [node, cli, root, writer, count] = process.argv.slice(1);
      for (let i = 1; i <= Number(count); i += 1) {
        const r = spawnSync(node, [cli, 'append', 'note', '--data', JSON.stringify({ text: 'writer ' + writer + ' line ' + i })], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
        if (r.status !== 0) process.exit(r.status || 1);
      }
    `;
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, w) => runChild(['-e', script, NODE, LEDGER_CLI, root, String(w), String(LINES)])),
    );
    const ms = performance.now() - start;
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    assertContiguous(root, WRITERS, LINES);
    t.diagnostic(`${WRITERS * LINES} command-line appends from ${WRITERS} processes in ${ms.toFixed(0)} ms`);
  });
});

describe('refusals', () => {
  test('a line over 64 KB is refused with exit 2 and nothing is written', () => {
    const root = makeRepo();
    assert.equal(cli(root, ['append', 'note', '--data', JSON.stringify({ text: 'small' })]).status, 0);
    const before = ledgerText(root);
    const big = cli(root, ['append', 'note', '--data', JSON.stringify({ text: 'x'.repeat(MAX_LINE + 10) })]);
    assert.equal(big.status, 2, big.stderr);
    assert.match(big.stderr, /over 64 KB; refused/);
    assert.equal(ledgerText(root), before);
    // The library refuses the same way, with the refusal exit code.
    assert.throws(
      () => appendEvent(root, { kind: 'note', data: { text: 'y'.repeat(MAX_LINE) } }),
      (error) => error instanceof LedgerError && error.exitCode === 2 && /over 64 KB/.test(error.message),
    );
    assert.equal(ledgerText(root), before);
    // A line just under the limit is accepted.
    const event = appendEvent(root, { kind: 'note', data: { text: 'z'.repeat(MAX_LINE - 200) } });
    assert.equal(event.seq, 2);
  });

  test('an unknown kind is refused by the command line and by the library', () => {
    const root = makeRepo();
    const r = cli(root, ['append', 'task.exploded', '--task', 'T000000', '--data', '{}']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown event kind "task\.exploded"/);
    assert.throws(() => appendEvent(root, { kind: 'step.reported', data: {} }), (e) => e instanceof LedgerError && e.exitCode === 2 && /unknown event kind/.test(e.message));
    assert.equal(fs.existsSync(ledgerFile(root)), false);
  });

  test('the library refuses data that is not an object and steps that are not positive integers', () => {
    const root = makeRepo();
    assert.throws(() => appendEvent(root, { kind: 'note', data: ['a'] }), /data must be a JSON object/);
    assert.throws(() => appendEvent(root, { kind: 'note', data: 'text' }), /data must be a JSON object/);
    assert.throws(() => appendEvent(root, { kind: 'step.done', task: 'T000000', step: 0, data: {} }), /step must be a positive integer/);
    assert.throws(() => appendEvent(root, { kind: 'step.done', task: 'T000000', step: 1.5, data: {} }), /step must be a positive integer/);
    assert.equal(fs.existsSync(ledgerFile(root)), false);
  });

  test('every line has seq, an ISO time with milliseconds, the kind and data; task, step and session only when given', () => {
    const root = makeRepo();
    const a = appendEvent(root, { kind: 'note', data: { text: 'one' } });
    const b = appendEvent(root, { kind: 'step.done', task: 'T000000', step: 2, session: 's-1', data: { ordinal: 2 } });
    const [la, lb] = readLedger(root);
    assert.deepEqual(la, a);
    assert.deepEqual(lb, b);
    assert.deepEqual(Object.keys(la), ['seq', 't', 'kind', 'data']);
    assert.deepEqual(Object.keys(lb), ['seq', 't', 'kind', 'task', 'step', 'session', 'data']);
    assert.match(la.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(fs.statSync(ledgerFile(root)).mode & 0o777, 0o600);
  });

  test('a last line without its newline does not glue the next line to it', () => {
    const root = makeRepo();
    fs.writeFileSync(ledgerFile(root), JSON.stringify({ seq: 1, t: new Date().toISOString(), kind: 'note', data: { text: 'by hand' } }));
    const event = appendEvent(root, { kind: 'note', data: { text: 'after' } });
    assert.equal(event.seq, 2);
    assert.deepEqual(readLedger(root).map((e) => e.seq), [1, 2]);
    assert.equal(verifyLedger(root).ok, true);
  });

  test('a ledger whose last line does not parse refuses further appends', () => {
    const root = makeRepo();
    fs.writeFileSync(ledgerFile(root), `${JSON.stringify({ seq: 1, t: new Date().toISOString(), kind: 'note', data: {} })}\n{"seq": 2, "t"\n`);
    const r = cli(root, ['append', 'note', '--data', '{"text":"x"}']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /last line does not parse; run ledger\.mjs verify/);
  });
});

describe('the ledger lock', () => {
  test('a lock file held by a dead pid is taken over at once', (t) => {
    const dir = tempDir('jh-lock-');
    const file = path.join(dir, 'ledger.lock');
    const pid = deadPid();
    fs.writeFileSync(file, `${pid} ${Date.now()}`);
    const start = performance.now();
    const release = acquire(file, { timeoutMs: 2000 });
    const ms = performance.now() - start;
    assert.equal(fs.readFileSync(file, 'utf8').split(' ')[0], String(process.pid));
    release();
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(`${file}.break`), false);
    assert.ok(ms < 200, `took ${ms} ms`);
    t.diagnostic(`dead holder's lock taken over in ${ms.toFixed(1)} ms`);
  });

  test('an append goes through when the ledger lock was left by a dead process', () => {
    const root = makeRepo();
    const lock = path.join(root, '.jevellan', 'locks', 'ledger.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${deadPid()} ${Date.now()}`);
    const r = cli(root, ['append', 'note', '--data', '{"text":"after a crash"}']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.ms < 1000, `took ${r.ms} ms`);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(readLedger(root)[0].data.text, 'after a crash');
  });

  test('a fresh lock held by a live pid makes acquire time out and leaves the lock alone', () => {
    const dir = tempDir('jh-lock-');
    const file = path.join(dir, 'ledger.lock');
    const holder = livePid();
    try {
      const text = `${holder.pid} ${Date.now()}`;
      fs.writeFileSync(file, text);
      const start = performance.now();
      assert.throws(() => acquire(file, { timeoutMs: 150 }), (error) => error instanceof LockTimeout && error.code === 'LOCK_TIMEOUT');
      const ms = performance.now() - start;
      assert.ok(ms >= 140 && ms < 1500, `waited ${ms} ms`);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    } finally {
      holder.stop();
    }
  });

  test('a lock older than the stale age is broken even when its pid is alive (a reused pid)', () => {
    const dir = tempDir('jh-lock-');
    const file = path.join(dir, 'ledger.lock');
    fs.writeFileSync(file, `${process.pid} ${Date.now() - 11000}`);
    const release = acquire(file, { timeoutMs: 200 });
    release();
    assert.equal(fs.existsSync(file), false);
  });

  test('a lock without a pid is broken only once it is older than the stale age', () => {
    const dir = tempDir('jh-lock-');
    const file = path.join(dir, 'ledger.lock');
    fs.writeFileSync(file, '');
    assert.throws(() => acquire(file, { timeoutMs: 100 }), LockTimeout);
    const old = new Date(Date.now() - 20000);
    fs.utimesSync(file, old, old);
    acquire(file, { timeoutMs: 200 })();
    assert.equal(fs.existsSync(file), false);
  });

  test('release does not remove a lock another process holds now', () => {
    const dir = tempDir('jh-lock-');
    const file = path.join(dir, 'ledger.lock');
    const release = acquire(file);
    const other = `${process.pid + 1} ${Date.now()}`;
    fs.writeFileSync(file, other);
    release();
    assert.equal(fs.readFileSync(file, 'utf8'), other);
  });
});

describe('secrets', () => {
  test('a value from a file in JH_HARNESS_HOME/secrets is written to the ledger as [redacted]', () => {
    const root = makeRepo();
    const secret = `sk-test-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    fs.mkdirSync(path.join(HARNESS_HOME, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(HARNESS_HOME, 'secrets', 'unit-test.key'), `${secret}\n`, { mode: 0o600 });
    const r = cli(root, ['append', 'note', '--data', JSON.stringify({ text: `the key is ${secret} and more`, nested: { list: [secret] } })]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.includes(secret), false, 'the printed line carries the secret');
    const text = ledgerText(root);
    assert.equal(text.includes(secret), false);
    const [event] = readLedger(root);
    assert.equal(event.data.text, 'the key is [redacted] and more');
    assert.deepEqual(event.data.nested, { list: ['[redacted]'] });
  });

  test('key files named in providers.json, secret-named assignments and bearer tokens are masked too', () => {
    const root = makeRepo();
    const elsewhere = tempDir('jh-keys-');
    const keyFile = path.join(elsewhere, 'provider.key');
    const providerKey = `pk-${Date.now().toString(36)}-provider-value`;
    fs.writeFileSync(keyFile, providerKey);
    writeJson(path.join(HARNESS_HOME, 'providers.json'), { jev: { keyFile }, providers: [] });
    const variable = ['SERVICE', 'API', 'KEY'].join('_');
    const text = `${providerKey} | ${variable}=plainvalue123 | Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345`;
    const event = appendEvent(root, { kind: 'note', data: { text } });
    assert.equal(event.data.text, `[redacted] | ${variable}:[redacted] | Authorization: Bearer [redacted]`);
    assert.equal(ledgerText(root).includes(providerKey), false);
    assert.equal(ledgerText(root).includes('plainvalue123'), false);
    fs.unlinkSync(path.join(HARNESS_HOME, 'providers.json'));
  });

  test('short values in a secret file are not masked (they would mangle ordinary text)', () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(HARNESS_HOME, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(HARNESS_HOME, 'secrets', 'short.key'), 'abc\n');
    const event = appendEvent(root, { kind: 'note', data: { text: 'abc is fine' } });
    assert.equal(event.data.text, 'abc is fine');
    fs.unlinkSync(path.join(HARNESS_HOME, 'secrets', 'short.key'));
  });
});

describe('verify', () => {
  const line = (seq, extra = {}) => JSON.stringify({ seq, t: '2026-11-02T01:14:09.312Z', kind: 'note', data: { text: `line ${seq}` }, ...extra });

  test('reports a seq gap in a hand-written ledger', () => {
    const root = makeRepo();
    fs.writeFileSync(ledgerFile(root), [line(1), line(2), line(4), line(5)].join('\n') + '\n');
    const r = cli(root, ['verify']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /problems:/);
    assert.match(r.stdout, /seq 4 where 3 was expected/);
    const json = cli(root, ['verify', '--json']);
    assert.equal(json.status, 2);
    assert.deepEqual(json.json(), { ok: false, lines: 4, issues: ['seq 4 where 3 was expected'] });
  });

  test('reports lines that do not parse, unknown kinds, bad times and data that is not an object', () => {
    const root = makeRepo();
    const lines = [line(1), '{not json', line(2, { kind: 'step.exploded' }), line(3, { t: 'yesterday' }), line(4, { data: [] })];
    fs.writeFileSync(ledgerFile(root), lines.join('\n') + '\n');
    const result = cli(root, ['verify', '--json']).json();
    assert.equal(result.ok, false);
    assert.equal(result.lines, 4);
    assert.deepEqual(result.issues.slice(1), ['seq 2: unknown kind "step.exploded"', 'seq 3: bad time', 'seq 4: data is not an object']);
    assert.match(result.issues[0], /^line 2 does not parse/);
  });

  test('a duplicated seq is a problem', () => {
    const root = makeRepo();
    fs.writeFileSync(ledgerFile(root), [line(1), line(2), line(2), line(3)].join('\n') + '\n');
    const result = verifyLedger(root);
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues, ['seq 2 where 3 was expected']);
  });

  test('an empty or missing ledger verifies', () => {
    const root = makeRepo();
    const r = cli(root, ['verify']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ok: 0 lines/);
  });
});
