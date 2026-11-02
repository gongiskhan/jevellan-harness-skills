// Fixtures for this skill's own suites: temporary git projects, a private harness home, and helpers that drive the
// ledger's command line and hooks as child processes the way a session does. Everything here comes from this skill's
// own folder (the suites run with only this skill present).
//
// Temporary folders go under JH_TEST_TMPDIR when it is set, otherwise under the system temporary folder. They are
// left behind on purpose (nothing here deletes folders).
//
// Importing this module points JH_HARNESS_HOME at a fresh temporary folder and clears the worker variables, so
// neither the library imported by a test nor any child process reads or writes the real harness home.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { appendEvent, groupByTask, projectTask, readEvents } from '../scripts/lib/ledger.mjs';
import { newTaskId } from '../scripts/lib/ids.mjs';

// The node that runs the suite (Node 22 when the suites are started with Node 22 first on PATH).
export const NODE = process.env.JH_TEST_NODE || process.execPath;

// This skill's folder: the parent of this test folder, wherever the skill was copied.
export const LEDGER_SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LEDGER_CLI = path.join(LEDGER_SKILL, 'scripts', 'ledger.mjs');
export const HOOKS = {
  stop: path.join(LEDGER_SKILL, 'hooks', 'stop.mjs'),
  'post-tool': path.join(LEDGER_SKILL, 'hooks', 'post-tool.mjs'),
  'session-start': path.join(LEDGER_SKILL, 'hooks', 'session-start.mjs'),
};
export const libUrl = (name) => pathToFileURL(path.join(LEDGER_SKILL, 'scripts', 'lib', `${name}.mjs`)).href;

const BASE = process.env.JH_TEST_TMPDIR || os.tmpdir();

export function tempDir(prefix = 'jh-test-') {
  fs.mkdirSync(BASE, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(BASE, prefix)));
}

export const WORKER_VARS = ['JH_TASK', 'JH_STEP', 'JH_DUTY', 'JH_PROJECT', 'JH_SESSION'];
for (const name of WORKER_VARS) delete process.env[name];
export const HARNESS_HOME = tempDir('jh-harness-');
process.env.JH_HARNESS_HOME = HARNESS_HOME;

// The environment of a child: only what it needs, never the worker variables unless a test passes them.
export function childEnv(extra = {}) {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? os.homedir(), JH_HARNESS_HOME: HARNESS_HOME };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

export function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// A git project with one commit. `installed` creates .jevellan/ (what install.mjs leaves behind).
export function makeRepo({ installed = true, commit = true } = {}) {
  const root = tempDir('jh-repo-');
  git(root, 'init', '-q', '-b', 'main');
  if (commit) {
    fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '--no-verify', '-m', 'init');
  }
  if (installed) fs.mkdirSync(path.join(root, '.jevellan'), { recursive: true });
  return root;
}

// A linked worktree of `root` on a new branch, the shape the git skill makes.
export function addWorktree(root, name = 'wt') {
  const where = path.join(tempDir('jh-wt-'), name);
  git(root, 'worktree', 'add', '-q', '-b', `jh/${name}`, where);
  return fs.realpathSync(where);
}

export const ledgerFile = (root) => path.join(root, '.jevellan', 'ledger.jsonl');

export function readLedger(root) {
  let text = '';
  try {
    text = fs.readFileSync(ledgerFile(root), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export function ledgerText(root) {
  try {
    return fs.readFileSync(ledgerFile(root), 'utf8');
  } catch {
    return '';
  }
}

function result(r, ms) {
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ms,
    json() {
      return JSON.parse(this.stdout);
    },
  };
}

// Runs ledger.mjs with `args` in `root` (the project root is found from the working folder, as in a session).
export function cli(root, args, { env = {}, input, cwd } = {}) {
  const start = performance.now();
  const r = spawnSync(NODE, [LEDGER_CLI, ...args], {
    cwd: cwd ?? root,
    env: childEnv(env),
    input: input ?? '',
    encoding: 'utf8',
    timeout: 60000,
  });
  return result(r, performance.now() - start);
}

// Runs ledger.mjs without waiting for it; resolves {status, stdout, stderr, exitAt} once it exited and its output
// is drained. exitAt is the moment the process exited.
export function cliAsync(root, args, { env = {}, cwd } = {}) {
  const child = spawn(NODE, [LEDGER_CLI, ...args], { cwd: cwd ?? root, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    let exitAt = null;
    child.on('error', reject);
    child.on('exit', () => {
      exitAt = performance.now();
    });
    child.on('close', (status, signal) => resolve({ status, signal, exitAt: exitAt ?? performance.now(), stdout, stderr }));
  });
  return { child, done };
}

// Runs a hook with the hook input JSON on stdin; `ms` is the hook's wall time.
export function runHook(name, input, { cwd, env = {} } = {}) {
  const start = performance.now();
  const r = spawnSync(NODE, [HOOKS[name]], {
    cwd,
    env: childEnv(env),
    input: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
    encoding: 'utf8',
    timeout: 30000,
  });
  return result(r, performance.now() - start);
}

// A pid that belonged to a process that has exited.
export function deadPid() {
  const r = spawnSync(NODE, ['-e', '0']);
  return r.pid;
}

// A process that stays alive until `stop()` is called.
export function livePid() {
  const child = spawn(NODE, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  return { pid: child.pid, stop: () => child.kill('SIGKILL') };
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A scripted task: each method appends one event through the library, as the scripts and hooks that own that kind
// would, so projection scenarios read as the story they tell.
export class TaskScript {
  constructor(root, { kind = 'feature', duty, title, text = 'Brief for the scripted task.', session = 'worker-session-1' } = {}) {
    this.root = root;
    this.session = session;
    this.task = newTaskId();
    this.kind = kind;
    this.duty = duty;
    const data = { kind, title: title ?? `Scripted ${kind} ${this.task}`, text, parent: null, after: null, origin: 'owner' };
    if (kind === 'single') data.duty = duty;
    this.created = this.add('task.created', data);
  }

  add(kind, data = {}, step) {
    return appendEvent(this.root, { kind, task: this.task, step, session: this.session, data });
  }

  worktree(branch = `jh/scripted-${this.task}`) {
    return this.add('task.worktree', { branch, path: `/worktrees/${this.task}`, base: 'main' });
  }

  // steps: [{ordinal, duty, onFail?}], instructions filled in.
  workflow(steps, skipped = []) {
    const full = steps.map((s) => ({ instructions: `Do step ${s.ordinal}.`, when: null, onFail: null, ...s }));
    return this.add('task.workflow', { steps: full, skipped, questions: { needs_plan: false, needs_docs: false } });
  }

  placed(step, data = {}) {
    return this.add('task.placed', { step, provider: 'test-provider', model: 'test-model', effort: 'low', kind: 'test-kind', probabilities: {}, latencyMs: 1, policyHash: 'h', source: 'jev', ...data });
  }

  started(ordinal, data = {}) {
    const duty = data.duty ?? (this.kind === 'single' ? this.duty : 'implement');
    return this.add('step.started', { ordinal, duty, runtime: 'test-runtime', provider: 'test-provider', model: 'test-model', effort: 'low', cwd: '/worktree', nativeSessionId: 'native-1', ...data }, ordinal);
  }

  report(ordinal, data = {}) {
    return this.add('step.report', { status: 'done', summary: `Step ${ordinal} finished.`, ...data }, ordinal);
  }

  done(ordinal) {
    return this.add('step.done', { ordinal }, ordinal);
  }

  failed(ordinal, reason = 'the step failed') {
    return this.add('step.failed', { ordinal, reason }, ordinal);
  }

  retrying(ordinal, gotoOrdinal, attempt = 1, reason = 'tests failed') {
    return this.add('step.retrying', { ordinal, attempt, gotoOrdinal, reason }, ordinal);
  }

  lost(ordinal, pid = 999999) {
    return this.add('step.lost', { ordinal, pid }, ordinal);
  }

  stopped(ordinal, reason = 'stopped by the coordinator') {
    return this.add('step.stopped', { ordinal, reason }, ordinal);
  }

  decided(route, reason = 'scripted landing') {
    return this.add('landing.decided', { route, probabilities: { [route]: 0.9 }, reason, policyHash: 'h' });
  }

  checked(passed, command = 'npm test') {
    return this.add('landing.checked', { command, passed, tail: passed ? 'ok' : '1 failing' });
  }

  landed(commit = 'abc1234def5678') {
    return this.add('task.landed', { commit });
  }

  asked(question = 'Land this task?', options = ['Land now', 'Leave it']) {
    return this.add('task.asked', { question, options });
  }

  note(text = 'a note') {
    return this.add('note', { text });
  }

  sessionEvent(step, tool = 'Bash', summary = 'ls') {
    return this.add('session.event', { tool, summary }, step);
  }

  // One step that ran and reported done, and was recorded done.
  stepDone(ordinal, data = {}) {
    this.started(ordinal, data);
    this.report(ordinal);
    return this.done(ordinal);
  }

  info() {
    return groupByTask(readEvents(this.root).events).get(this.task);
  }

  view(alive = () => true) {
    return projectTask(this.info(), { alive });
  }
}
