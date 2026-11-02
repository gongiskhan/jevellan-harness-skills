// The runtimes' guards around a worker's process, against a fake `claude` (JH_CLAUDE_BIN) and a fake `codex`
// (JH_CODEX_BIN): liveness comes from the task's newest step.started whatever the ledger says after it, the guards
// run again inside the ledger lock so two concurrent starts never both run, stop signals the worker's process group
// (its members after the leader is gone, never a pid that leads no group), the worker gets JH_CWD, and the worker
// settings deny the Read and Edit tools the harness's secrets folder.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HARNESS_HOME, NODE, REPO, git, makeRepo, sleep, tempDir } from './helpers/ledger-fixture.mjs';

const fakeOut = tempDir('jh-fake-guards-');

// The fake workers read how to behave from a file named after the task (the worker environment carries no test
// variable) and record each run in <task>.jsonl.
const fakeClaude = path.join(tempDir('jh-fake-bin-'), 'claude');
fs.writeFileSync(fakeClaude, String.raw`#!${NODE}
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const out = path.join(process.env.TMPDIR, 'fake-claude');
fs.mkdirSync(out, { recursive: true });
const task = process.env.JH_TASK;
let mode = {};
try { mode = JSON.parse(fs.readFileSync(path.join(out, 'mode-' + task + '.json'), 'utf8')); } catch {}
const record = { argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, jh: { task, step: process.env.JH_STEP, session: process.env.JH_SESSION, cwd: process.env.JH_CWD } };
if (mode.child) {
  // A child in the worker's process group that outlives the worker.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  child.unref();
  record.childPid = child.pid;
}
fs.appendFileSync(path.join(out, task + '.jsonl'), JSON.stringify(record) + '\n');
setTimeout(() => process.exit(0), mode.sleepMs ?? 1500);
`, { mode: 0o755 });

const fakeCodex = path.join(tempDir('jh-fake-bin-'), 'codex');
fs.writeFileSync(fakeCodex, String.raw`#!${NODE}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const resume = argv[1] === 'resume';
  const task = process.env.JH_TASK;
  const out = path.join(process.env.TMPDIR, 'fake-codex');
  fs.mkdirSync(out, { recursive: true });
  let mode = {};
  try { mode = JSON.parse(fs.readFileSync(path.join(out, 'mode-' + task + '.json'), 'utf8')); } catch {}
  fs.appendFileSync(path.join(out, task + '.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, ppid: process.ppid, jhCwd: process.env.JH_CWD, resume }) + '\n');
  const thread = resume ? argv[argv.length - 2] : 'thread-' + crypto.randomUUID();
  // Nothing at all is printed before mode.sleepMs, so a slow turn appends nothing to the ledger meanwhile.
  setTimeout(() => {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
    fs.mkdirSync('.jevellan', { recursive: true });
    fs.writeFileSync('.jevellan/report.json', JSON.stringify({ status: 'done', summary: resume ? 'resumed' : 'started' }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
  }, mode.sleepMs ?? 200);
});
`, { mode: 0o755 });

let project;
let ledger;
let proc;
let env;
const cleanup = [];

const scriptOf = (runtime, script) => path.join(project, '.claude', 'skills', `jevellan-runtime-${runtime}`, 'scripts', script);
const runEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: fakeOut, JH_HARNESS_HOME: HARNESS_HOME, JH_CLAUDE_BIN: fakeClaude, JH_CODEX_BIN: fakeCodex });
const run = (runtime, script, args) => spawnSync(NODE, [scriptOf(runtime, script), ...args, '--json'], { cwd: project, encoding: 'utf8', env: runEnv() });
// The same, without waiting: resolves {status, stdout, stderr} once it exited.
const runAsync = (runtime, script, args) => new Promise((resolve, reject) => {
  const child = spawn(NODE, [scriptOf(runtime, script), ...args, '--json'], { cwd: project, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});
const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};
const records = (fake, task) => {
  const file = path.join(fakeOut, fake, `${task}.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const setMode = (fake, task, mode) => {
  fs.mkdirSync(path.join(fakeOut, fake), { recursive: true });
  fs.writeFileSync(path.join(fakeOut, fake, `mode-${task}.json`), JSON.stringify(mode));
};
const waitFor = (predicate, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    spawnSync('sleep', ['0.1']);
  }
  return predicate();
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const events = (task) => ledger.readEvents(project).events.filter((e) => e.task === task);
const starts = (task, step = 1) => events(task).filter((e) => e.kind === 'step.started' && e.step === step);

let counter = 0;
// A single task with a worktree; `steps` records a workflow of more than its one step.
function newTask(duty = 'investigate', steps = null) {
  counter += 1;
  const r = spawnSync(NODE, [path.join(project, '.claude', 'skills', 'jevellan-ledger', 'scripts', 'ledger.mjs'), 'task', 'create', '--kind', 'single', '--duty', duty, '--title', `guards ${counter}`, '--text', 'Guard the worker.', '--json'], {
    cwd: project, encoding: 'utf8', env: runEnv(),
  });
  const task = JSON.parse(r.stdout).task;
  const dir = path.join(tempDir('jh-wt-'), `wt-${task}`);
  git(project, 'worktree', 'add', '-q', '-b', `jh/${task}`, dir);
  fs.symlinkSync(path.join(project, '.claude'), path.join(dir, '.claude'));
  ledger.appendEvent(project, { kind: 'task.worktree', task, data: { branch: `jh/${task}`, path: dir, base: 'main' } });
  if (steps) {
    const full = steps.map((s) => ({ instructions: `Do step ${s.ordinal}.`, when: null, onFail: null, ...s }));
    ledger.appendEvent(project, { kind: 'task.workflow', task, data: { steps: full, skipped: [], questions: { needs_plan: false, needs_docs: false } } });
  }
  return { task, dir };
}

const CLAUDE = { provider: 'claude-test', model: 'claude-sonnet-5-5', effort: 'low', kind: 'claude-subscription' };
const CODEX = { provider: 'codex-test', model: 'gpt-6-astra', effort: 'medium', kind: 'codex-subscription' };
const place = (task, step, where = CLAUDE) => ledger.appendEvent(project, { kind: 'task.placed', task, data: { step, ...where, source: 'owner' } });
const startArgs = (task, dir, { step = 1, duty = 'investigate', where = CLAUDE } = {}) => ['--task', task, '--step', String(step), '--duty', duty, '--cwd', dir, '--provider', where.provider, '--model', where.model, '--effort', where.effort];
const report = (task, step, session, status = 'progress') => ledger.appendEvent(project, { kind: 'step.report', task, step, session, data: { status, summary: `step ${step} said ${status}` } });

// Holds the ledger lock the way a writer does (a live pid, a fresh time), so appends wait behind it.
function holdLedgerLock() {
  const file = path.join(project, '.jevellan', 'locks', 'ledger.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${process.pid} ${Date.now()}`, { flag: 'wx' });
  return () => fs.unlinkSync(file);
}

before(async () => {
  project = makeRepo({ installed: false });
  const inst = spawnSync(NODE, [path.join(REPO, 'install.mjs'), project, '--json'], { encoding: 'utf8', env: { ...process.env, JH_HARNESS_HOME: HARNESS_HOME } });
  assert.equal(inst.status, 0, inst.stderr);
  fs.mkdirSync(path.join(HARNESS_HOME, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(HARNESS_HOME, 'secrets', 'claude-test.token'), 'fake-guards-token-value-0123456789\n', { mode: 0o600 });
  const codexHome = tempDir('jh-codex-home-');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"fake": true}');
  fs.writeFileSync(path.join(HARNESS_HOME, 'providers.json'), JSON.stringify({
    jev: { keyFile: path.join(HARNESS_HOME, 'secrets', 'jev.key'), model: 'jev-latest', timeoutMs: 4000 },
    providers: [
      { name: 'claude-test', kind: 'claude-subscription', tokenFile: path.join(HARNESS_HOME, 'secrets', 'claude-test.token'), ceilingPct: 90,
        models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet', efforts: ['low', 'medium', 'high'] }] },
      { name: 'codex-test', kind: 'codex-subscription', codexHome, ceilingPct: 90, models: [{ id: 'gpt-6-astra', label: 'GPT', efforts: ['medium'] }] },
    ],
  }));
  ledger = await import(pathToFileURL(path.join(project, '.claude', 'skills', 'jevellan-ledger', 'scripts', 'lib', 'ledger.mjs')).href);
  proc = await import(pathToFileURL(path.join(REPO, 'skills', 'jevellan-runtime-claude', 'scripts', 'lib', 'proc.mjs')).href);
  env = await import(pathToFileURL(path.join(REPO, 'skills', 'jevellan-runtime-claude', 'scripts', 'lib', 'env.mjs')).href);
});

// Whether `pid` is still one of this suite's processes (its command line names `mark`), so a failed test never
// leaves a fake worker behind and the clean-up never signals a pid that was reused meanwhile.
const ours = (pid, mark) => {
  try {
    return Number.isInteger(pid) && pid > 1 && fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(mark);
  } catch {
    return false;
  }
};

after(() => {
  for (const fake of ['fake-claude', 'fake-codex']) {
    const dir = path.join(fakeOut, fake);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      for (const rec of fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))) {
        // Leaders were spawned detached, so their whole group goes: the fake claude, or the codex runner.
        if (ours(rec.pid, fakeClaude)) try { process.kill(-rec.pid, 'SIGKILL'); } catch {}
        if (ours(rec.ppid, 'runner.mjs')) try { process.kill(-rec.ppid, 'SIGKILL'); } catch {}
        if (ours(rec.childPid, '60000')) try { process.kill(rec.childPid, 'SIGKILL'); } catch {}
      }
    }
  }
  for (const stop of cleanup) stop();
});

test('a worker still alive after its report keeps resume and start refused, and stop ends it', () => {
  const { task, dir } = newTask();
  place(task, 1);
  setMode('fake-claude', task, { sleepMs: 60000 });
  const out = json(run('claude', 'start.mjs', startArgs(task, dir)));
  assert.ok(out?.pid, 'started');
  assert.ok(waitFor(() => records('fake-claude', task).length === 1));
  // The Stop hook records the report; the process has not exited.
  report(task, 1, out.session);
  const resumed = run('claude', 'resume.mjs', ['--task', task, '--step', '1', '--message', 'Continue.']);
  assert.equal(resumed.status, 2, resumed.stdout);
  assert.match(json(resumed).error, new RegExp(`step 1 of ${task} is running \\(pid ${out.pid}\\)`));
  place(task, 1);
  const again = run('claude', 'start.mjs', startArgs(task, dir));
  assert.equal(again.status, 2, again.stdout);
  assert.match(json(again).error, /is running/);
  assert.equal(records('fake-claude', task).length, 1, 'no second worker was spawned');
  assert.equal(starts(task).length, 1);
  const stopped = run('claude', 'stop.mjs', ['--task', task, '--step', '1']);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(json(stopped).how, 'SIGTERM');
  assert.ok(waitFor(() => !alive(out.pid)));
});

test('a step.failed or a retry reset does not hide a live worker from start, status and stop', () => {
  const { task, dir } = newTask('investigate', [{ ordinal: 1, duty: 'investigate', onFail: { goto: 1, maxLoops: 2 } }]);
  place(task, 1);
  setMode('fake-claude', task, { sleepMs: 60000 });
  const out = json(run('claude', 'start.mjs', startArgs(task, dir)));
  assert.ok(out?.pid, 'started');
  assert.ok(waitFor(() => records('fake-claude', task).length === 1));
  ledger.appendEvent(project, { kind: 'step.failed', task, step: 1, data: { ordinal: 1, reason: 'the coordinator gave up on it' } });
  place(task, 1);
  let r = run('claude', 'start.mjs', startArgs(task, dir));
  assert.equal(r.status, 2, r.stdout);
  assert.match(json(r).error, new RegExp(`is running \\(pid ${out.pid}\\)`));
  ledger.appendEvent(project, { kind: 'step.retrying', task, step: 1, data: { ordinal: 1, attempt: 1, gotoOrdinal: 1, reason: 'try again' } });
  place(task, 1);
  r = run('claude', 'start.mjs', startArgs(task, dir));
  assert.equal(r.status, 2, r.stdout);
  assert.match(json(r).error, new RegExp(`is running \\(pid ${out.pid}\\)`));
  assert.equal(records('fake-claude', task).length, 1, 'no second worker was spawned');
  // status and stop find the start the reset hid.
  const st = run('claude', 'status.mjs', ['--task', task, '--step', '1']);
  assert.equal(st.status, 0, st.stdout);
  assert.equal(json(st).state, 'alive');
  assert.equal(json(st).pid, out.pid);
  const stopped = run('claude', 'stop.mjs', ['--task', task, '--step', '1']);
  assert.equal(stopped.status, 0, stopped.stdout);
  assert.equal(json(stopped).how, 'SIGTERM');
  assert.ok(waitFor(() => !alive(out.pid)));
  // Once the worker is gone the retry starts.
  setMode('fake-claude', task, { sleepMs: 300 });
  place(task, 1);
  r = run('claude', 'start.mjs', startArgs(task, dir));
  assert.equal(r.status, 0, r.stdout);
  assert.equal(starts(task).length, 2);
});

test('one worker per task: a live step keeps the next step from starting', () => {
  const { task, dir } = newTask('investigate', [{ ordinal: 1, duty: 'investigate' }, { ordinal: 2, duty: 'plan' }]);
  place(task, 1);
  setMode('fake-claude', task, { sleepMs: 60000 });
  const out = json(run('claude', 'start.mjs', startArgs(task, dir)));
  assert.ok(out?.pid, 'started');
  assert.ok(waitFor(() => records('fake-claude', task).length === 1));
  report(task, 1, out.session, 'done');
  ledger.appendEvent(project, { kind: 'step.done', task, step: 1, data: { ordinal: 1 } });
  place(task, 2);
  let r = run('claude', 'start.mjs', startArgs(task, dir, { step: 2, duty: 'plan' }));
  assert.equal(r.status, 2, r.stdout);
  assert.match(json(r).error, new RegExp(`step 1 of ${task} is still running \\(pid ${out.pid}\\)`));
  assert.equal(run('claude', 'stop.mjs', ['--task', task, '--step', '1']).status, 0);
  assert.ok(waitFor(() => !alive(out.pid)));
  setMode('fake-claude', task, { sleepMs: 300 });
  r = run('claude', 'start.mjs', startArgs(task, dir, { step: 2, duty: 'plan' }));
  assert.equal(r.status, 0, r.stdout);
});

test('resume waits a moment for a worker that is exiting after its report, and the worker gets JH_CWD', () => {
  const { task, dir } = newTask();
  place(task, 1);
  setMode('fake-claude', task, { sleepMs: 1200 });
  const out = json(run('claude', 'start.mjs', startArgs(task, dir)));
  assert.ok(out?.pid, 'started');
  assert.ok(waitFor(() => records('fake-claude', task).length === 1));
  report(task, 1, out.session);
  const resumed = run('claude', 'resume.mjs', ['--task', task, '--step', '1', '--message', 'Continue.']);
  assert.equal(resumed.status, 0, resumed.stdout);
  assert.ok(waitFor(() => records('fake-claude', task).length === 2));
  const [first, second] = records('fake-claude', task);
  assert.equal(first.jh.cwd, dir);
  assert.equal(second.jh.cwd, dir);
  assert.deepEqual(second.argv.slice(0, 3), ['-p', '--resume', out.session]);
});

test('two concurrent starts on one placement: one runs, the other is refused and its worker killed (claude)', async () => {
  const { task, dir } = newTask();
  place(task, 1);
  setMode('fake-claude', task, { sleepMs: 60000 });
  const release = holdLedgerLock();
  let released = false;
  let results;
  try {
    const both = [runAsync('claude', 'start.mjs', startArgs(task, dir)), runAsync('claude', 'start.mjs', startArgs(task, dir))];
    // Both passed the guards before the lock and spawned their worker.
    const deadline = Date.now() + 1500;
    while (records('fake-claude', task).length < 2 && Date.now() < deadline) await sleep(20);
    release();
    released = true;
    results = await Promise.all(both);
  } finally {
    if (!released) release();
  }
  for (const r of results) assert.doesNotMatch(r.stderr, /lock busy/);
  assert.deepEqual(results.map((r) => r.status).sort(), [0, 2], results.map((r) => r.stdout).join('\n'));
  const winner = json(results.find((r) => r.status === 0));
  const loser = json(results.find((r) => r.status === 2));
  assert.match(loser.error, /started meanwhile on the same placement/);
  assert.equal(starts(task).length, 1);
  assert.equal(starts(task)[0].data.pid, winner.pid);
  const loserPid = records('fake-claude', task).map((rec) => rec.pid).find((pid) => pid !== winner.pid);
  assert.ok(loserPid, 'the refused start had spawned a worker');
  assert.ok(waitFor(() => !alive(loserPid)), 'the refused worker is killed');
  assert.ok(alive(winner.pid));
  assert.equal(run('claude', 'stop.mjs', ['--task', task, '--step', '1']).status, 0);
});

test('two concurrent starts on one placement: one runs, the other is refused and its runner killed (codex)', async () => {
  const { task, dir } = newTask();
  place(task, 1, CODEX);
  setMode('fake-codex', task, { sleepMs: 60000 });
  const release = holdLedgerLock();
  let released = false;
  let results;
  try {
    const args = startArgs(task, dir, { where: CODEX });
    const both = [runAsync('codex', 'start.mjs', args), runAsync('codex', 'start.mjs', args)];
    const deadline = Date.now() + 1500;
    while (records('fake-codex', task).length < 2 && Date.now() < deadline) await sleep(20);
    release();
    released = true;
    results = await Promise.all(both);
  } finally {
    if (!released) release();
  }
  for (const r of results) assert.doesNotMatch(r.stderr, /lock busy/);
  assert.deepEqual(results.map((r) => r.status).sort(), [0, 2], results.map((r) => r.stdout).join('\n'));
  const winner = json(results.find((r) => r.status === 0));
  assert.match(json(results.find((r) => r.status === 2)).error, /started meanwhile on the same placement/);
  assert.equal(starts(task).length, 1);
  assert.equal(starts(task)[0].data.pid, winner.pid);
  const lost = records('fake-codex', task).find((rec) => rec.ppid !== winner.pid);
  assert.ok(lost, 'the refused start had spawned a runner');
  assert.ok(waitFor(() => !alive(lost.ppid) && !alive(lost.pid)), 'the refused runner and its codex are killed');
  assert.ok(alive(winner.pid));
  assert.equal(run('codex', 'stop.mjs', ['--task', task, '--step', '1']).status, 0);
  assert.ok(waitFor(() => !alive(winner.pid)));
});

test('codex: a runner alive after its report keeps resume refused; stop ends it; the worker gets JH_CWD', () => {
  const { task, dir } = newTask();
  place(task, 1, CODEX);
  const out = json(run('codex', 'start.mjs', startArgs(task, dir, { where: CODEX })));
  assert.ok(out?.pid, 'started');
  assert.ok(waitFor(() => events(task).some((e) => e.kind === 'step.report')));
  assert.equal(records('fake-codex', task)[0].jhCwd, dir);
  // The resumed turn hangs; the coordinator records its own end of it while the runner still runs.
  setMode('fake-codex', task, { sleepMs: 60000 });
  let r = run('codex', 'resume.mjs', ['--task', task, '--step', '1', '--message', 'Continue.']);
  assert.equal(r.status, 0, r.stdout);
  const resumed = json(r);
  assert.ok(waitFor(() => records('fake-codex', task).length === 2));
  assert.equal(records('fake-codex', task)[1].jhCwd, dir);
  ledger.appendEvent(project, { kind: 'step.failed', task, step: 1, data: { ordinal: 1, reason: 'the coordinator gave up on it' } });
  r = run('codex', 'resume.mjs', ['--task', task, '--step', '1', '--message', 'Continue.']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(json(r).error, new RegExp(`is running \\(pid ${resumed.pid}\\)`));
  assert.equal(records('fake-codex', task).length, 2, 'no third turn was spawned');
  const stopped = run('codex', 'stop.mjs', ['--task', task, '--step', '1']);
  assert.equal(stopped.status, 0, stopped.stdout);
  assert.equal(json(stopped).how, 'SIGTERM');
  assert.ok(waitFor(() => !alive(resumed.pid)));
});

test('stop ends the members of a worker\'s group after the worker itself is gone', () => {
  const { task, dir } = newTask();
  place(task, 1);
  setMode('fake-claude', task, { sleepMs: 300, child: true });
  const out = json(run('claude', 'start.mjs', startArgs(task, dir)));
  assert.ok(out?.pid, 'started');
  assert.ok(waitFor(() => records('fake-claude', task).length === 1));
  const { childPid } = records('fake-claude', task)[0];
  assert.ok(waitFor(() => !alive(out.pid)), 'the worker exits');
  assert.ok(alive(childPid), 'its child is still running');
  const stopped = run('claude', 'stop.mjs', ['--task', task, '--step', '1']);
  assert.equal(stopped.status, 0, stopped.stdout);
  assert.equal(json(stopped).how, 'SIGTERM');
  assert.ok(waitFor(() => !alive(childPid)), 'the child is ended with its group');
});

test('stop never signals a pid that leads no process group', () => {
  // A live process in this test's own group: what a reused pid looks like to stop.mjs.
  const victim = spawn(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  cleanup.push(() => victim.kill('SIGKILL'));
  const { task } = newTask();
  ledger.appendEvent(project, { kind: 'step.started', task, step: 1, session: 'reused-pid', data: { ordinal: 1, duty: 'investigate', runtime: 'claude', provider: 'claude-test', model: 'claude-sonnet-5-5', effort: 'low', cwd: project, nativeSessionId: 'reused-pid', pid: victim.pid } });
  const stopped = run('claude', 'stop.mjs', ['--task', task, '--step', '1']);
  assert.equal(stopped.status, 0, stopped.stdout);
  assert.equal(json(stopped).how, 'not running');
  assert.ok(alive(victim.pid), 'the unrelated process was left alone');
  assert.equal(proc.groupAlive(victim.pid), false);
  // 0 and 1 are never a group: kill(-1) would reach every process of the owner. Signal 0 only checks.
  for (const pid of [0, 1, -5, 2.5, undefined]) {
    assert.equal(proc.groupAlive(pid), false);
    assert.equal(proc.signalGroup(pid, 0), false);
  }
});

test('the worker settings stay valid JSON and deny Read and Edit on the harness secrets folder', () => {
  const { task, dir } = newTask('implement');
  place(task, 1);
  setMode('fake-claude', task, { sleepMs: 200 });
  const out = json(run('claude', 'start.mjs', startArgs(task, dir, { duty: 'implement' })));
  assert.ok(out?.pid, 'started');
  assert.ok(waitFor(() => records('fake-claude', task).length === 1));
  const argv = records('fake-claude', task)[0].argv;
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
  const secrets = path.join(HARNESS_HOME, 'secrets');
  assert.deepEqual(settings.permissions.deny, [`Read(/${secrets}/**)`, `Edit(/${secrets}/**)`]);
  assert.ok(settings.permissions.deny.every((rule) => /^(Read|Edit)\(\/\/[^/]/.test(rule)), 'absolute rules start with //');
  assert.deepEqual(settings.attribution, { commit: '', pr: '', sessionUrl: false });
  // A harness home reached through a symlink is denied under both spellings.
  const link = path.join(tempDir('jh-harness-link-'), 'home');
  fs.symlinkSync(HARNESS_HOME, link);
  const saved = process.env.JH_HARNESS_HOME;
  process.env.JH_HARNESS_HOME = link;
  try {
    const deny = JSON.parse(env.workerSettings()).permissions.deny;
    assert.deepEqual(deny, [`Read(/${link}/secrets/**)`, `Read(/${secrets}/**)`, `Edit(/${link}/secrets/**)`, `Edit(/${secrets}/**)`]);
  } finally {
    process.env.JH_HARNESS_HOME = saved;
  }
});
