// The Claude runtime's scripts against a fake `claude` (JH_CLAUDE_BIN): the guards, the command line, the worker
// environment, the system prompt append, and the ledger lines of start, resume, stop and status.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HARNESS_HOME, NODE, REPO, git, makeRepo, tempDir } from './helpers/ledger-fixture.mjs';

const FAKE_TOKEN = 'fake-oauth-token-value-0123456789';
const fakeOut = tempDir('jh-fake-claude-');
const fakeBin = path.join(tempDir('jh-fake-bin-'), 'claude');
fs.writeFileSync(fakeBin, `#!${NODE}
const fs = require('fs');
const path = require('path');
const out = path.join(process.env.TMPDIR, 'fake-claude');
fs.mkdirSync(out, { recursive: true });
const argv = process.argv.slice(2);
const at = argv.indexOf('--session-id') >= 0 ? argv.indexOf('--session-id') : argv.indexOf('--resume');
const sid = argv[at + 1];
const record = { argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), hasToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
  configDir: process.env.CLAUDE_CONFIG_DIR, jh: { task: process.env.JH_TASK, step: process.env.JH_STEP, duty: process.env.JH_DUTY, project: process.env.JH_PROJECT, session: process.env.JH_SESSION, cwd: process.env.JH_CWD } };
fs.appendFileSync(path.join(out, sid + '.jsonl'), JSON.stringify(record) + '\\n');
// The worker environment carries no test variable, so how long to live comes from a file named after the task.
let sleepMs = 1500;
try { sleepMs = Number(fs.readFileSync(path.join(out, 'sleep-' + process.env.JH_TASK), 'utf8')); } catch {}
setTimeout(() => process.exit(0), sleepMs);
`, { mode: 0o755 });

let project;
let ledger;
const run = (script, args, extra = {}) => spawnSync(NODE, [path.join(project, '.claude', 'skills', 'jevellan-runtime-claude', 'scripts', script), ...args, '--json'], {
  cwd: project,
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: fakeOut, JH_HARNESS_HOME: HARNESS_HOME, JH_CLAUDE_BIN: fakeBin, ...extra },
});
// How long the fake worker of `task` lives.
const sleepFor = (task, ms) => {
  fs.mkdirSync(path.join(fakeOut, 'fake-claude'), { recursive: true });
  fs.writeFileSync(path.join(fakeOut, 'fake-claude', `sleep-${task}`), String(ms));
};
const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};
const records = (session) => {
  const file = path.join(fakeOut, 'fake-claude', `${session}.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const waitFor = (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    spawnSync('sleep', ['0.1']);
  }
  return false;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let counter = 0;
function newTask(duty, title = `a ${duty} task ${(counter += 1)}`) {
  const r = spawnSync(NODE, [path.join(project, '.claude', 'skills', 'jevellan-ledger', 'scripts', 'ledger.mjs'), 'task', 'create', '--kind', 'single', '--duty', duty, '--title', title, '--text', `Do the ${duty} thing.`, '--json'], {
    cwd: project, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, JH_HARNESS_HOME: HARNESS_HOME },
  });
  return JSON.parse(r.stdout).task;
}

function worktreeFor(task) {
  const dir = path.join(tempDir('jh-wt-'), `wt-${task}`);
  git(project, 'worktree', 'add', '-q', '-b', `jh/${task}`, dir);
  fs.symlinkSync(path.join(project, '.claude'), path.join(dir, '.claude'));
  ledger.appendEvent(project, { kind: 'task.worktree', task, data: { branch: `jh/${task}`, path: dir, base: 'main' } });
  return dir;
}

function place(task, step, model = 'claude-sonnet-5-5', effort = 'low') {
  ledger.appendEvent(project, { kind: 'task.placed', task, data: { step, provider: 'claude-test', model, effort, kind: 'claude-subscription', source: 'owner' } });
}

const startArgs = (task, duty, cwd, model = 'claude-sonnet-5-5', effort = 'low') => ['--task', task, '--step', '1', '--duty', duty, '--cwd', cwd, '--provider', 'claude-test', '--model', model, '--effort', effort];

before(async () => {
  project = makeRepo({ installed: false });
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Fixture rules\nAlways say FIXTURE-AGENTS.\n');
  git(project, 'add', 'AGENTS.md');
  git(project, 'commit', '-q', '-m', 'agents');
  const inst = spawnSync(NODE, [path.join(REPO, 'install.mjs'), project, '--json'], { encoding: 'utf8', env: { ...process.env, JH_HARNESS_HOME: HARNESS_HOME } });
  assert.equal(inst.status, 0, inst.stderr);
  fs.mkdirSync(path.join(HARNESS_HOME, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(HARNESS_HOME, 'secrets', 'claude-test.token'), `${FAKE_TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(HARNESS_HOME, 'providers.json'), JSON.stringify({
    jev: { keyFile: path.join(HARNESS_HOME, 'secrets', 'jev.key'), model: 'jev-latest', timeoutMs: 4000 },
    providers: [{ name: 'claude-test', kind: 'claude-subscription', tokenFile: path.join(HARNESS_HOME, 'secrets', 'claude-test.token'), ceilingPct: 90,
      models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet', efforts: ['low', 'medium', 'high'] }, { id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'high', 'xhigh'] }] }],
  }));
  ledger = await import(pathToFileURL(path.join(project, '.claude', 'skills', 'jevellan-ledger', 'scripts', 'lib', 'ledger.mjs')).href);
});

describe('start', () => {
  test('refuses without a placement, with another placement, and outside the worktree', () => {
    const task = newTask('investigate');
    const wt = worktreeFor(task);
    let r = run('start.mjs', startArgs(task, 'investigate', wt));
    assert.equal(r.status, 2);
    assert.match(json(r).error, /no placement/);
    place(task, 1, 'claude-opus-5-5', 'high');
    r = run('start.mjs', startArgs(task, 'investigate', wt));
    assert.equal(r.status, 2);
    assert.match(json(r).error, /is placed on claude-test claude-opus-5-5 high/);
    r = run('start.mjs', startArgs(task, 'investigate', project, 'claude-opus-5-5', 'high'));
    assert.equal(r.status, 2);
    assert.match(json(r).error, /worktree is/);
    r = run('start.mjs', startArgs(task, 'implement', wt, 'claude-opus-5-5', 'high'));
    assert.equal(r.status, 2);
    assert.match(json(r).error, /step 1 of .* is investigate, not implement/);
  });

  test('starts a read-only step: command line, environment, append file and ledger lines', () => {
    const task = newTask('investigate');
    const wt = worktreeFor(task);
    place(task, 1);
    const r = run('start.mjs', startArgs(task, 'investigate', wt));
    assert.equal(r.status, 0, r.stderr);
    const out = json(r);
    assert.ok(waitFor(() => records(out.session).length === 1));
    const rec = records(out.session)[0];
    const argv = rec.argv;
    assert.deepEqual(argv.slice(0, 3), ['-p', '--session-id', out.session]);
    assert.equal(argv[argv.length - 2], '--');
    assert.equal(argv[argv.length - 1], 'Start the step now. End by writing .jevellan/report.json.');
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.ok(argv.includes('Write(./.jevellan/report.json)'));
    assert.ok(!argv.includes('Write(./plan.md)'));
    assert.ok(argv.includes('--append-system-prompt-file'));
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
    // The instruction files of every folder above the worktree stay out (the owner's home among them on a real
    // machine); the worktree's own are the project's.
    for (const at of [path.dirname(wt), path.dirname(path.dirname(wt)), '/']) {
      for (const file of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', '**')]) assert.ok(settings.claudeMdExcludes.includes(path.join(at, file)), path.join(at, file));
    }
    assert.ok(!settings.claudeMdExcludes.some((p) => p.startsWith(`${wt}/`)));
    assert.deepEqual(settings.attribution, { commit: '', pr: '', sessionUrl: false });
    assert.ok(!argv.join(' ').includes(FAKE_TOKEN), 'the token is never on the command line');
    assert.equal(rec.hasToken, true);
    assert.equal(rec.configDir, path.join(HARNESS_HOME, 'claude-config'));
    assert.deepEqual(rec.jh, { task, step: '1', duty: 'investigate', project: fs.realpathSync(project), session: out.session, cwd: wt });
    assert.equal(rec.cwd, wt);
    const append = fs.readFileSync(out.appendFile, 'utf8');
    assert.match(append, /You are working on one step of one task/);
    assert.match(append, /Your step is duty investigate\. Use the duty skill for investigate now and follow it\./);
    assert.match(append, /FIXTURE-AGENTS/);
    assert.match(append, new RegExp(`Task ${task}: a investigate task \\d+`));
    assert.ok(!append.includes(FAKE_TOKEN));
    const events = ledger.readEvents(project).events.filter((e) => e.task === task);
    const started = events.find((e) => e.kind === 'step.started');
    assert.equal(started.data.pid, out.pid);
    assert.equal(started.data.nativeSessionId, out.session);
    assert.ok(events.some((e) => e.kind === 'session.started' && e.data.role === 'worker'));
    // A second start while it runs is refused.
    place(task, 1);
    const again = run('start.mjs', startArgs(task, 'investigate', wt));
    assert.equal(again.status, 2);
    assert.match(json(again).error, /is running/);
    assert.ok(waitFor(() => !alive(out.pid)));
  });

  test('a write duty runs with bypassPermissions; a tool-less duty gets one turn and the duty body inline', () => {
    const task = newTask('implement');
    const wt = worktreeFor(task);
    place(task, 1);
    let r = run('start.mjs', startArgs(task, 'implement', wt));
    assert.equal(r.status, 0, r.stderr);
    let out = json(r);
    assert.ok(waitFor(() => records(out.session).length === 1));
    let argv = records(out.session)[0].argv;
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.ok(!argv.includes('--tools'));
    const ask = newTask('answer');
    place(ask, 1);
    r = run('start.mjs', startArgs(ask, 'answer', project));
    assert.equal(r.status, 0, r.stderr);
    out = json(r);
    assert.ok(waitFor(() => records(out.session).length === 1));
    argv = records(out.session)[0].argv;
    assert.equal(argv[argv.indexOf('--max-turns') + 1], '1');
    assert.equal(argv[argv.indexOf('--tools') + 1], '');
    const append = fs.readFileSync(out.appendFile, 'utf8');
    assert.match(append, /You have no tools, so the duty's instructions follow here/);
  });
});

describe('resume, stop, status', () => {
  test('resume continues the same session after a report; refused while running', () => {
    const task = newTask('investigate', 'resume me');
    const wt = worktreeFor(task);
    place(task, 1);
    sleepFor(task, 2500);
    const r = run('start.mjs', startArgs(task, 'investigate', wt));
    const out = json(r);
    let res = run('resume.mjs', ['--task', task, '--step', '1', '--message', 'Continue.']);
    assert.equal(res.status, 2);
    assert.match(json(res).error, /is running/);
    let st = run('status.mjs', ['--task', task, '--step', '1']);
    assert.equal(json(st).state, 'alive');
    assert.ok(waitFor(() => !alive(out.pid), 8000));
    ledger.appendEvent(project, { kind: 'step.report', task, step: 1, session: out.session, data: { status: 'progress', summary: 'halfway' } });
    res = run('resume.mjs', ['--task', task, '--step', '1', '--message', 'Continue.']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(json(res).session, out.session);
    assert.ok(waitFor(() => records(out.session).length === 2));
    const argv = records(out.session)[1].argv;
    assert.deepEqual(argv.slice(0, 3), ['-p', '--resume', out.session]);
    assert.equal(argv[argv.length - 1], 'From the coordinator: Continue.');
    const events = ledger.readEvents(project).events.filter((e) => e.task === task);
    assert.ok(events.some((e) => e.kind === 'step.message' && e.data.text === 'Continue.' && e.data.direction === 'coordinator'));
    const starts = events.filter((e) => e.kind === 'step.started');
    assert.equal(starts.length, 2);
    assert.equal(starts[1].data.nativeSessionId, out.session);
    st = run('status.mjs', ['--task', task, '--step', '1']);
    assert.equal(json(st).session, out.session);
  });

  test('stop ends the process group and records step.stopped', () => {
    const task = newTask('investigate', 'stop me');
    const wt = worktreeFor(task);
    place(task, 1);
    sleepFor(task, 60000);
    const out = json(run('start.mjs', startArgs(task, 'investigate', wt)));
    assert.ok(waitFor(() => records(out.session).length === 1));
    const r = run('stop.mjs', ['--task', task, '--step', '1']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(json(r).how, 'SIGTERM');
    assert.equal(alive(out.pid), false);
    const stopped = ledger.readEvents(project).events.find((e) => e.task === task && e.kind === 'step.stopped');
    assert.equal(stopped.data.ordinal, 1);
    const st = run('status.mjs', ['--task', task, '--step', '1']);
    assert.equal(json(st).state, 'exited');
  });
});
