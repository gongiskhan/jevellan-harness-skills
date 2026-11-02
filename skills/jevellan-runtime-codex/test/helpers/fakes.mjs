// Fixtures for this skill's own tests, which run with nothing of the other skills present: a temporary skills root
// holding a copy of this skill next to fake sibling skills written here (a fake ledger that answers with canned
// JSON and records every call, fake duty skills), a git project with a worktree, a providers.json, fake `claude` and
// `codex` binaries, and the canned task the fake ledger shows. The same file sits in both runtime skills.
//
// Temporary folders go under JH_TEST_TMPDIR when it is set, otherwise under the system temporary folder; nothing here
// deletes them. Importing this module points JH_HARNESS_HOME at a fresh folder and clears the worker variables.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// <this skill>/test/helpers/fakes.mjs -> <this skill>
export const SKILL_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const SKILL_NAME = path.basename(SKILL_DIR);
export const NODE = process.execPath;
const BASE = process.env.JH_TEST_TMPDIR || os.tmpdir();

export function tempDir(prefix = 'jh-test-') {
  fs.mkdirSync(BASE, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(BASE, prefix)));
}

for (const name of ['JH_TASK', 'JH_STEP', 'JH_DUTY', 'JH_PROJECT', 'JH_SESSION', 'JH_CWD']) delete process.env[name];
export const HARNESS_HOME = tempDir('jh-harness-');
process.env.JH_HARNESS_HOME = HARNESS_HOME;

export const ROLE_MISSING = 'tell the owner which role is missing and do not improvise it';

// ---- the fake ledger ---------------------------------------------------------------------------------------------

// Answers like the ledger skill's public script with --json, from <fake>/state/script.json:
//   {shows: {T: [show1, show2, ...]}  the n-th `show T` gets the n-th entry (the last one repeats); no entry: exit 3
//    changed: N                         the first N appends with --if-last-seq get exit 6 (the task changed)
//    refuse: {kind: "message"}}         a record or append of that kind gets exit 2 with the message
// Every call goes to <fake>/state/calls.jsonl as {argv, cwd, input, exit, event?, changed?, report?}; `events`
// answers with the lines recorded so far.
const FAKE_LEDGER = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'state');
const argv = process.argv.slice(2);
const args = argv.filter((a) => a !== '--json');
const opt = (name) => { const i = args.indexOf('--' + name); return i === -1 ? undefined : args[i + 1]; };
const opts = (name) => args.flatMap((a, i) => (a === '--' + name ? [args[i + 1]] : []));
let script = {};
try { script = JSON.parse(fs.readFileSync(path.join(STATE, 'script.json'), 'utf8')); } catch {}
const calls = () => { try { return fs.readFileSync(path.join(STATE, 'calls.jsonl'), 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const input = opt('data-file') === '-' ? fs.readFileSync(0, 'utf8') : '';
const log = (entry) => fs.appendFileSync(path.join(STATE, 'calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), input, ...entry }) + '\\n');
const answer = (out, entry = {}) => { log({ exit: 0, ...entry }); process.stdout.write(JSON.stringify(out) + '\\n'); };
const fail = (message, exitCode, entry = {}) => {
  log({ exit: exitCode, ...entry });
  process.stdout.write(JSON.stringify({ error: message, exitCode }) + '\\n');
  process.stderr.write(message + '\\n');
  process.exitCode = exitCode;
};
const [command, first] = args;
const task = command === 'show' ? first : opt('task');
if (command === 'show') {
  const list = script.shows?.[task];
  if (!list?.length) fail('no task ' + task + " in this project's ledger", 3);
  else {
    const n = calls().filter((c) => c.argv[0] === 'show' && c.argv[1] === task).length;
    answer(list[Math.min(n, list.length - 1)]);
  }
} else if (command === 'record' || command === 'append') {
  const kind = first;
  const ifLastSeq = opt('if-last-seq');
  if (script.refuse?.[kind]) fail(script.refuse[kind], 2);
  else if (ifLastSeq !== undefined && calls().filter((c) => c.changed).length < (script.changed ?? 0)) {
    fail('task ' + task + ' changed after #' + ifLastSeq + '; read it again', 6, { changed: true });
  } else {
    const event = { seq: 1000 + calls().filter((c) => c.event).length, t: new Date().toISOString(), kind, task };
    if (opt('step') !== undefined) event.step = Number(opt('step'));
    if (opt('session') !== undefined) event.session = opt('session');
    event.data = input ? JSON.parse(input) : {};
    answer(event, { event });
  }
} else if (command === 'events') {
  const tasks = opts('task');
  const kinds = opts('kind');
  const events = calls().filter((c) => c.event).map((c) => c.event)
    .filter((e) => (!tasks.length || tasks.includes(e.task)) && (!kinds.length || kinds.includes(e.kind)));
  answer({ lastSeq: events.length ? events[events.length - 1].seq : 0, events });
} else if (command === 'take-report') {
  const file = path.join(opt('cwd'), '.jevellan', 'report.json');
  let status = 'blocked';
  let synthesized = true;
  try { status = JSON.parse(fs.readFileSync(file, 'utf8')).status; synthesized = false; } catch {}
  const report = { task, step: Number(opt('step')), session: opt('session'), nativeSession: opt('native-session') ?? null, ended: opt('ended'), status, synthesized };
  answer({ task, step: report.step, seq: 2000 + calls().length, status, synthesized, reportFile: null, sessionEndedSeq: 2001 + calls().length }, { report });
} else {
  fail('unknown command ' + command, 2);
}
`;

function skillMd({ name, description, role, extra = '', body }) {
  return `---\nname: ${name}\ndescription: ${description}\njh-role: ${role}\n${extra}---\n\n${body}\n`;
}

// A temporary skills root: a copy of this skill, the fake ledger (unless `ledger` is false) and a fake duty skill
// for each of `duties`. Returns where things are.
export function makeSkillsRoot({ ledger = true, duties = ['answer', 'investigate', 'implement', 'plan'] } = {}) {
  const root = tempDir('jh-skills-');
  fs.cpSync(SKILL_DIR, path.join(root, SKILL_NAME), { recursive: true });
  const state = path.join(root, 'fake-ledger', 'state');
  if (ledger) {
    fs.mkdirSync(path.join(root, 'fake-ledger', 'scripts'), { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(root, 'fake-ledger', 'SKILL.md'), skillMd({ name: 'fake-ledger', description: 'Ledger (a fake for tests).', role: 'ledger', body: '# Fake ledger\n\n## Interface\n\n- `ledger.mjs` -> canned JSON.' }));
    fs.writeFileSync(path.join(root, 'fake-ledger', 'scripts', 'ledger.mjs'), FAKE_LEDGER, { mode: 0o755 });
  }
  for (const duty of duties) {
    fs.mkdirSync(path.join(root, `fake-duty-${duty}`), { recursive: true });
    fs.writeFileSync(path.join(root, `fake-duty-${duty}`, 'SKILL.md'), skillMd({
      name: `fake-duty-${duty}`,
      description: `Duty ${duty} (a fake for tests).`,
      role: 'duty',
      extra: `jh-duty: ${duty}\n`,
      body: `# Fake duty ${duty}\n\nFAKE-DUTY-BODY of ${duty}: cost $1 and keep $& as it is.\n\n## Interface\n\nNo scripts.`,
    }));
  }
  return {
    root,
    skill: path.join(root, SKILL_NAME),
    scripts: path.join(root, SKILL_NAME, 'scripts'),
    state,
    script(value) {
      fs.writeFileSync(path.join(state, 'script.json'), JSON.stringify(value));
      fs.rmSync(path.join(state, 'calls.jsonl'), { force: true });
    },
    calls() {
      try {
        return fs.readFileSync(path.join(state, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

// The value of `--name` in a recorded call's argv.
export function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

// ---- the canned task -----------------------------------------------------------------------------------------------

const STEP_END = new Set(['step.report', 'step.failed', 'step.lost', 'step.stopped']);

// A step's view as the ledger's show --json gives it (events named by seq): since `resetSeq`, the newest start, what
// ended it, whether the step is done, its last report and its last placement.
function viewOf(events, ordinal, resetSeq) {
  let started = null;
  let end = null;
  let done = null;
  let starts = 0;
  let lastReport = null;
  let placed = null;
  for (const e of events) {
    if (e.seq <= resetSeq) continue;
    if (e.kind === 'task.placed' && e.data?.step === ordinal) placed = e;
    if (e.step !== ordinal) continue;
    if (e.kind === 'step.started') {
      started = e;
      end = null;
      done = null;
      starts += 1;
    } else if (e.kind === 'step.report') {
      lastReport = e;
      if (started && e.session === started.session) end = e;
    } else if (STEP_END.has(e.kind) && started) {
      end = e;
    } else if (e.kind === 'step.done') {
      done = e;
    }
  }
  let state = 'pending';
  if (done) state = 'done';
  else if (started && !end) state = 'running';
  else if (end?.kind === 'step.report') state = `reported-${end.data?.status ?? 'unknown'}`;
  else if (end) state = end.kind.slice('step.'.length);
  const seq = (e) => e?.seq ?? null;
  return { state, starts, started: seq(started), end: seq(end), done: seq(done), lastReport: seq(lastReport), placed: seq(placed) };
}

// The lines of one task, written in the order a test tells its story, and the show --json the fake ledger prints.
export class TaskLines {
  constructor({ task = 'T0FAKE1', kind = 'single', duty = 'investigate', title = 'A fake task', text = 'Do the fake thing.' } = {}) {
    this.task = task;
    this.kind = kind;
    this.duty = duty;
    this.events = [];
    const data = { kind, title, text, parent: null, after: null, origin: 'owner' };
    if (kind === 'single') data.duty = duty;
    this.add('task.created', data);
  }

  add(kind, data = {}, { step, session } = {}) {
    const event = { seq: this.events.length + 1, t: new Date().toISOString(), kind, task: this.task };
    if (step !== undefined) event.step = step;
    if (session) event.session = session;
    event.data = data;
    this.events.push(event);
    return event;
  }

  worktree(dir) {
    return this.add('task.worktree', { branch: `jh/${this.task}`, path: dir, base: 'main' });
  }

  workflow(steps) {
    return this.add('task.workflow', { steps: steps.map((s) => ({ instructions: `Do step ${s.ordinal}.`, when: null, onFail: null, ...s })), skipped: [], questions: {} });
  }

  placed(step, where) {
    return this.add('task.placed', { step, kind: 'test-kind', source: 'owner', ...where });
  }

  started(step, session, data = {}) {
    return this.add('step.started', { ordinal: step, duty: this.duty, nativeSessionId: session, ...data }, { step, session });
  }

  report(step, session, data = {}) {
    return this.add('step.report', { status: 'progress', summary: `step ${step} is halfway`, ...data }, { step, session });
  }

  done(step) {
    return this.add('step.done', { ordinal: step }, { step });
  }

  note(text = 'a note') {
    return this.add('note', { text });
  }

  // What `show T --json` prints now.
  show() {
    const events = structuredClone(this.events);
    const resets = events.filter((e) => e.kind === 'step.retrying' && Number.isInteger(e.data?.gotoOrdinal)).map((e) => ({ seq: e.seq, from: e.data.gotoOrdinal }));
    let max = this.kind === 'single' ? 1 : 0;
    for (const e of events) {
      if (Number.isInteger(e.step)) max = Math.max(max, e.step);
      if (e.kind === 'task.placed') max = Math.max(max, e.data.step);
      if (e.kind === 'task.workflow') for (const s of e.data.steps) max = Math.max(max, s.ordinal);
    }
    const views = [];
    for (let ordinal = 1; ordinal <= max; ordinal += 1) {
      const resetSeq = resets.filter((r) => ordinal >= r.from).reduce((m, r) => Math.max(m, r.seq), 0);
      views.push({ ordinal, resetSeq, current: viewOf(events, ordinal, resetSeq), overall: viewOf(events, ordinal, 0) });
    }
    const created = events[0].data;
    return { task: this.task, kind: created.kind, duty: created.duty ?? null, title: created.title, state: 'queued', text: created.text, lastSeq: events[events.length - 1].seq, views, events };
  }
}

// The task as this skill's loadTask gives it, from a show --json, for the helpers that take a task read already
// (what the ledger client does with the same JSON): `created`, and view(n) / overall(n) with events in place of seqs.
export function infoFrom(show) {
  const bySeq = new Map(show.events.map((e) => [e.seq, e]));
  const hydrate = (v) => ({ ...v, started: bySeq.get(v.started) ?? null, end: bySeq.get(v.end) ?? null, done: bySeq.get(v.done) ?? null, lastReport: bySeq.get(v.lastReport) ?? null, placed: bySeq.get(v.placed) ?? null });
  const pick = (ordinal, which) => {
    const v = show.views.find((x) => x.ordinal === ordinal);
    return v ? { ordinal, resetSeq: v.resetSeq, ...hydrate(v[which]) } : { ordinal, resetSeq: 0, state: 'pending', starts: 0, started: null, end: null, done: null, lastReport: null, placed: null };
  };
  return { ...show, created: show.events.find((e) => e.kind === 'task.created'), view: (n) => pick(n, 'current'), overall: (n) => pick(n, 'overall') };
}

// ---- a project, providers, processes -------------------------------------------------------------------------------

export function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A git project with one commit and AGENTS.md, and a linked worktree of it (the shape the git skill makes).
export function makeProject() {
  const project = tempDir('jh-repo-');
  git(project, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Fixture rules\nAlways say FIXTURE-AGENTS.\n');
  git(project, 'add', 'AGENTS.md');
  git(project, 'commit', '-q', '--no-verify', '-m', 'init');
  fs.mkdirSync(path.join(project, '.jevellan'), { recursive: true });
  const wt = path.join(tempDir('jh-wt-'), 'wt');
  git(project, 'worktree', 'add', '-q', '-b', 'jh/wt', wt);
  return { project, wt: fs.realpathSync(wt) };
}

export const TOKEN = 'fake-oauth-token-value-0123456789';
export const CLAUDE = { provider: 'claude-test', model: 'claude-sonnet-5-5', effort: 'low' };
export const CODEX = { provider: 'codex-test', model: 'gpt-6-astra', effort: 'medium' };

// providers.json in the private harness home: a Claude subscription with a token file, a Claude endpoint with a key
// file, a Codex subscription with a login and one without.
export function writeProviders() {
  const secrets = path.join(HARNESS_HOME, 'secrets');
  fs.mkdirSync(secrets, { recursive: true });
  fs.writeFileSync(path.join(secrets, 'claude-test.token'), `${TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(secrets, 'endpoint.key'), 'fake-endpoint-key-0123456789\n', { mode: 0o600 });
  const codexHome = tempDir('jh-codex-home-');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"fake": true}');
  const config = {
    providers: [
      { name: 'claude-test', kind: 'claude-subscription', tokenFile: path.join(secrets, 'claude-test.token'), models: [{ id: 'claude-sonnet-5-5', efforts: ['low', 'medium'] }, { id: 'claude-opus-5-5', efforts: ['high'] }] },
      { name: 'endpoint-test', kind: 'claude-endpoint', keyFile: path.join(secrets, 'endpoint.key'), baseUrl: 'http://127.0.0.1:9', models: [{ id: 'model-a', efforts: ['low'] }, { id: 'model-b', efforts: ['low'] }] },
      { name: 'codex-test', kind: 'codex-subscription', codexHome, models: [{ id: 'gpt-6-astra', efforts: ['medium'] }] },
      { name: 'codex-nologin', kind: 'codex-subscription', codexHome: tempDir('jh-codex-empty-'), models: [{ id: 'gpt-6-astra', efforts: ['medium'] }] },
      { name: 'off-test', kind: 'claude-subscription', enabled: false, models: [{ id: 'claude-sonnet-5-5', efforts: ['low'] }] },
    ],
  };
  fs.writeFileSync(path.join(HARNESS_HOME, 'providers.json'), JSON.stringify(config));
  return { codexHome, secrets };
}

// A fake `claude`: records each run in $TMPDIR/fake-claude/<session>.jsonl and lives for the milliseconds in
// $TMPDIR/fake-claude/sleep-<task> (default 300); the worker environment carries no test variable.
export function fakeClaude() {
  const bin = path.join(tempDir('jh-fake-bin-'), 'claude');
  fs.writeFileSync(bin, `#!${NODE}
const fs = require('fs');
const path = require('path');
const out = path.join(process.env.TMPDIR, 'fake-claude');
fs.mkdirSync(out, { recursive: true });
const argv = process.argv.slice(2);
const at = argv.indexOf('--session-id') >= 0 ? argv.indexOf('--session-id') : argv.indexOf('--resume');
const env = {};
for (const key of Object.keys(process.env)) env[key] = key.includes('TOKEN') || key.includes('KEY') ? '(set)' : process.env[key];
fs.appendFileSync(path.join(out, argv[at + 1] + '.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, env }) + '\\n');
let ms = 300;
try { ms = Number(fs.readFileSync(path.join(out, 'sleep-' + process.env.JH_TASK), 'utf8')); } catch {}
setTimeout(() => process.exit(0), ms);
`, { mode: 0o755 });
  return bin;
}

// A fake `codex`: reads the message on stdin, records the run in $TMPDIR/fake-codex/<task>.jsonl, announces a thread
// (on resume the one it was given), writes a done report unless the message says NOREPORT, prints a known secret
// when it says LEAKY, and finishes after the milliseconds in $TMPDIR/fake-codex/sleep-<task> (default 200).
export function fakeCodex() {
  const bin = path.join(tempDir('jh-fake-bin-'), 'codex');
  fs.writeFileSync(bin, `#!${NODE}
const fs = require('fs');
const path = require('path');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const resume = argv[1] === 'resume';
  const out = path.join(process.env.TMPDIR, 'fake-codex');
  fs.mkdirSync(out, { recursive: true });
  const task = process.env.JH_TASK;
  fs.appendFileSync(path.join(out, task + '.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, ppid: process.ppid, input, codexHome: process.env.CODEX_HOME, jhCwd: process.env.JH_CWD }) + '\\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: resume ? argv[argv.length - 2] : 'thread-' + process.pid }));
  if (input.includes('LEAKY')) {
    const known = fs.readFileSync(path.join(process.env.JH_HARNESS_HOME, 'secrets', 'claude-test.token'), 'utf8').trim();
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'curl -H ' + known } }));
    process.stderr.write('warning: key ' + known + ' rejected\\n');
  }
  let ms = 200;
  try { ms = Number(fs.readFileSync(path.join(out, 'sleep-' + task), 'utf8')); } catch {}
  setTimeout(() => {
    if (!input.includes('NOREPORT')) {
      fs.mkdirSync('.jevellan', { recursive: true });
      fs.writeFileSync('.jevellan/report.json', JSON.stringify({ status: 'done', summary: resume ? 'resumed fine' : 'all fine' }));
    }
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
  }, ms);
});
`, { mode: 0o755 });
  return bin;
}

export function records(out, file) {
  const at = path.join(out, file);
  return fs.existsSync(at) ? fs.readFileSync(at, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export function waitFor(predicate, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    spawnSync('sleep', ['0.1']);
  }
  return predicate();
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// A pid that belonged to a process that has exited.
export function deadPid() {
  return spawnSync(NODE, ['-e', '0']).pid;
}

// A detached process that leads its own group and sleeps, like a worker; `stop()` ends its group. It is started
// through a parent that exits at once, as a worker is by start.mjs, so it is never this test's own child (a child
// that died would stay a zombie, alive to kill(pid, 0), until this process reaped it).
export function sleeper(ms = 60000) {
  const script = `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${ms})', 'jh-test-sleeper'], { detached: true, stdio: 'ignore' }); c.unref(); process.stdout.write(String(c.pid));`;
  const pid = Number(spawnSync(NODE, ['-e', script], { encoding: 'utf8' }).stdout);
  return {
    pid,
    stop() {
      killIfOurs(pid, 'jh-test-sleeper');
    },
  };
}

// Kills the process group of `pid` when its command line still names `mark`, so a clean-up never signals a pid that
// was reused meanwhile.
export function killIfOurs(pid, mark) {
  try {
    if (!(Number.isInteger(pid) && pid > 1 && fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(mark))) return;
  } catch {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

// Runs one of the copied scripts with --json, in `cwd`, with only the variables a coordinator's call would carry.
export function runScript(skills, script, args, { cwd, env = {} } = {}) {
  const r = spawnSync(NODE, [path.join(skills.scripts, script), ...args, '--json'], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: process.env.LANG ?? 'C.UTF-8', JH_HARNESS_HOME: HARNESS_HOME, ...env },
    timeout: 60000,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
