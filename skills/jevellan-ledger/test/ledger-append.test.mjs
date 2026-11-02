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
} from './helpers.mjs';
import { LedgerError, MAX_LINE, appendEvent, verifyLedger } from '../scripts/lib/ledger.mjs';
import { LockTimeout, acquire } from '../scripts/lib/lock.mjs';

// Kinds that look like event kinds but are not among the twenty, built at run time so the kind lint (which reads every
// script under skills/) does not take them for kinds this skill uses.
const NOT_A_KIND = {
  task: ['task', 'exploded'].join('.'),
  step: ['step', 'reported'].join('.'),
  stepExploded: ['step', 'exploded'].join('.'),
};

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
    const r = cli(root, ['append', NOT_A_KIND.task, '--task', 'T000000', '--data', '{}']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown event kind "task\.exploded"/);
    assert.throws(() => appendEvent(root, { kind: NOT_A_KIND.step, data: {} }), (e) => e instanceof LedgerError && e.exitCode === 2 && /unknown event kind/.test(e.message));
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

  const good = (seq) => JSON.stringify({ seq, t: new Date().toISOString(), kind: 'note', data: { text: `line ${seq}` } });

  test('a last line that does not parse does not stop later appends: seq follows the last line that parses', () => {
    const root = makeRepo();
    fs.writeFileSync(ledgerFile(root), `${good(1)}\n{"seq": 2, "t"\n`);
    const r = cli(root, ['append', 'note', '--data', '{"text":"x"}', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().seq, 2);
    const event = appendEvent(root, { kind: 'note', data: { text: 'y' } });
    assert.equal(event.seq, 3);
    // verify still reports the bad line, and only it.
    const result = verifyLedger(root);
    assert.equal(result.ok, false);
    assert.equal(result.lines, 3);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0], /^line 2 does not parse/);
  });

  test('a bad last line without its newline is passed over and the next line starts on its own line', () => {
    const root = makeRepo();
    fs.writeFileSync(ledgerFile(root), `${good(1)}\n${good(2)}\n{"seq": 3, "t": "cut sho`);
    const event = appendEvent(root, { kind: 'note', data: { text: 'after the cut' } });
    assert.equal(event.seq, 3);
    const lines = ledgerText(root).split('\n');
    assert.equal(lines[2], '{"seq": 3, "t": "cut sho');
    assert.deepEqual(JSON.parse(lines[3]), event);
    assert.deepEqual(verifyLedger(root).issues.map((i) => i.replace(/ \(.*$/, '')), ['line 3 does not parse']);
  });

  test('lines that parse without an integer seq, and a bad line over 64 KB, are passed over too', () => {
    const root = makeRepo();
    const huge = `{"seq": 3, "garbage": "${'x'.repeat(3 * MAX_LINE)}`;
    fs.writeFileSync(ledgerFile(root), [good(1), good(2), '{"seq":"3"}', '[3]', 'null', '7', huge].join('\n') + '\n');
    assert.equal(appendEvent(root, { kind: 'note', data: { text: 'next' } }).seq, 3);
  });

  test('a ledger with no line that parses starts at seq 1', () => {
    const root = makeRepo();
    fs.writeFileSync(ledgerFile(root), `not json\n${'y'.repeat(MAX_LINE + 50)}\n\n`);
    assert.equal(appendEvent(root, { kind: 'note', data: { text: 'first good line' } }).seq, 1);
  });

  test('a long ledger with a long bad tail keeps numbering from its last good line, read across chunk boundaries', () => {
    const root = makeRepo();
    // 150 lines of about 1 KB with two-byte characters, then a cut line of 100 KB: reading back from the end crosses
    // several 64 KB chunks, and a chunk boundary falls inside a good line.
    const lines = Array.from({ length: 150 }, (_, i) => JSON.stringify({ seq: i + 1, t: new Date().toISOString(), kind: 'note', data: { text: `line ${i + 1} ${'zé'.repeat(500)}` } }));
    fs.writeFileSync(ledgerFile(root), `${lines.join('\n')}\n{"seq": 151, "cut": "${'q'.repeat(100 * 1024)}\n`);
    assert.equal(appendEvent(root, { kind: 'note', data: { text: 'more' } }).seq, 151);
    assert.equal(verifyLedger(root).issues.length, 1);
  });
});

// fs.writeSync may write fewer bytes than asked; the ledger and the lock must finish the write or fail loudly.
// The fake below shortens only the writes that carry `marker`, so every other write goes through as usual.
function shortWrites(marker, { max = 7, stopAfter = Infinity } = {}) {
  const original = fs.writeSync;
  let written = 0;
  fs.writeSync = function writeSync(fd, data, ...rest) {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    if (!Buffer.isBuffer(bytes) || !bytes.includes(marker)) return original.call(fs, fd, data, ...rest);
    const offset = typeof data === 'string' ? 0 : rest[0] ?? 0;
    const length = typeof data === 'string' ? bytes.length : rest[1] ?? bytes.length - offset;
    const n = Math.max(0, Math.min(length, max, stopAfter - written));
    if (n === 0) return 0;
    written += n;
    return original.call(fs, fd, bytes, offset, n, null);
  };
  return () => {
    fs.writeSync = original;
  };
}

describe('short writes', () => {
  test('an append whose writes come back short is continued until the whole line is in the file', () => {
    const root = makeRepo();
    appendEvent(root, { kind: 'note', data: { text: 'before' } });
    const restore = shortWrites('short-write-marker', { max: 7 });
    let event;
    try {
      event = appendEvent(root, { kind: 'note', data: { text: 'short-write-marker in a line long enough to need many writes' } });
    } finally {
      restore();
    }
    assert.deepEqual(readLedger(root)[1], event);
    assert.equal(verifyLedger(root).ok, true);
  });

  test('a write that makes no progress throws; the cut line is passed over by the next append', () => {
    const root = makeRepo();
    appendEvent(root, { kind: 'note', data: { text: 'before' } });
    const restore = shortWrites('stalled-write-marker', { max: 5, stopAfter: 20 });
    try {
      assert.throws(() => appendEvent(root, { kind: 'note', data: { text: 'stalled-write-marker' } }), /no progress after 20 of \d+ bytes/);
    } finally {
      restore();
    }
    assert.equal(ledgerText(root).split('\n')[1].length, 20);
    const next = appendEvent(root, { kind: 'note', data: { text: 'after the stall' } });
    assert.equal(next.seq, 2);
    assert.deepEqual(readLedgerLoose(root).map((e) => e.seq), [1, 2]);
    assert.deepEqual(verifyLedger(root).issues.map((i) => i.replace(/ \(.*$/, '')), ['line 2 does not parse']);
  });

  test('the lock file gets its whole holder text even when writes come back short', () => {
    const dir = tempDir('jh-lock-');
    const file = path.join(dir, 'ledger.lock');
    const restore = shortWrites(`${process.pid} `, { max: 3 });
    let release;
    try {
      release = acquire(file, { timeoutMs: 200 });
    } finally {
      restore();
    }
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`^${process.pid} \\d{13}$`));
    release();
    assert.equal(fs.existsSync(file), false);
  });
});

// The lines of the ledger that parse, ignoring the others.
function readLedgerLoose(root) {
  return ledgerText(root).split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

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
    const lines = [line(1), '{not json', line(2, { kind: NOT_A_KIND.stepExploded }), line(3, { t: 'yesterday' }), line(4, { data: [] })];
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
