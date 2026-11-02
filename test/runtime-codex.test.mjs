// The Codex runtime against a fake `codex` (JH_CODEX_BIN): the command lines, the first message, the thread id as
// the native session id, the runner's report logic (valid, missing, invalid), resume, stop and the login guard.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HARNESS_HOME, NODE, REPO, git, makeRepo, tempDir } from './helpers/ledger-fixture.mjs';

const fakeOut = tempDir('jh-fake-codex-');
const fakeBin = path.join(tempDir('jh-fake-codex-bin-'), 'codex');
fs.writeFileSync(fakeBin, `#!${NODE}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const resume = argv[1] === 'resume';
  const thread = resume ? argv[argv.length - 2] : 'thread-' + crypto.randomUUID();
  const out = path.join(process.env.TMPDIR, 'fake-codex');
  fs.mkdirSync(out, { recursive: true });
  fs.appendFileSync(path.join(out, 'calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), input, codexHome: process.env.CODEX_HOME, jhTask: process.env.JH_TASK }) + '\\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  const finish = () => {
    if (!input.includes('NOREPORT')) {
      fs.mkdirSync('.jevellan', { recursive: true });
      const report = input.includes('BADREPORT') ? { status: 'needs-decision', summary: 'x', question: 'Q?', options: [{ label: 'only' }] } : { status: 'done', summary: resume ? 'resumed fine' : 'all fine' };
      fs.writeFileSync('.jevellan/report.json', JSON.stringify(report));
    }
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'done' } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }));
  };
  if (input.includes('SLOW')) setTimeout(finish, 60000); else setTimeout(finish, 300);
});
`, { mode: 0o755 });

let project;
let ledger;
const codexHome = tempDir('jh-codex-home-');
fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"fake": true}');
const env = (extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: fakeOut, JH_HARNESS_HOME: HARNESS_HOME, JH_CODEX_BIN: fakeBin, ...extra });
const run = (script, args) => spawnSync(NODE, [path.join(project, '.claude', 'skills', 'jevellan-runtime-codex', 'scripts', script), ...args, '--json'], { cwd: project, encoding: 'utf8', env: env() });
const ledgerRun = (args) => spawnSync(NODE, [path.join(project, '.claude', 'skills', 'jevellan-ledger', 'scripts', 'ledger.mjs'), ...args, '--json'], { cwd: project, encoding: 'utf8', env: env() });
const calls = () => {
  const file = path.join(fakeOut, 'fake-codex', 'calls.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
let counter = 0;
function newTask(text) {
  counter += 1;
  const task = JSON.parse(ledgerRun(['task', 'create', '--kind', 'single', '--duty', 'investigate', '--title', `codex ${counter}`, '--text', text]).stdout).task;
  const dir = path.join(tempDir('jh-wt-'), `wt-${task}`);
  git(project, 'worktree', 'add', '-q', '-b', `jh/${task}`, dir);
  fs.symlinkSync(path.join(project, '.claude'), path.join(dir, '.claude'));
  ledger.appendEvent(project, { kind: 'task.worktree', task, data: { branch: `jh/${task}`, path: dir, base: 'main' } });
  ledger.appendEvent(project, { kind: 'task.placed', task, data: { step: 1, provider: 'codex', model: 'gpt-6-astra', effort: 'medium', kind: 'codex-subscription', source: 'owner' } });
  return { task, dir };
}
const startArgs = (task, dir) => ['--task', task, '--step', '1', '--duty', 'investigate', '--cwd', dir, '--provider', 'codex', '--model', 'gpt-6-astra', '--effort', 'medium'];
const waitReport = (task) => JSON.parse(ledgerRun(['wait', '--task', task, '--step', '1', '--timeout', '20']).stdout);

before(async () => {
  project = makeRepo({ installed: false });
  const inst = spawnSync(NODE, [path.join(REPO, 'install.mjs'), project, '--json'], { encoding: 'utf8', env: { ...process.env, JH_HARNESS_HOME: HARNESS_HOME } });
  assert.equal(inst.status, 0, inst.stderr);
  fs.writeFileSync(path.join(HARNESS_HOME, 'providers.json'), JSON.stringify({
    jev: { keyFile: path.join(HARNESS_HOME, 'secrets', 'jev.key'), model: 'jev-latest', timeoutMs: 4000 },
    providers: [
      { name: 'codex', kind: 'codex-subscription', codexHome, ceilingPct: 90, models: [{ id: 'gpt-6-astra', label: 'GPT', efforts: ['low', 'medium', 'high', 'xhigh'] }] },
      { name: 'codex-nologin', kind: 'codex-subscription', codexHome: tempDir('jh-codex-empty-'), models: [{ id: 'gpt-6-astra', label: 'GPT', efforts: ['medium'] }] },
    ],
  }));
  ledger = await import(pathToFileURL(path.join(project, '.claude', 'skills', 'jevellan-ledger', 'scripts', 'lib', 'ledger.mjs')).href);
});

test('a step runs on codex exec: command line, first message, thread id, the report recorded by the runner', () => {
  const { task, dir } = newTask('Find the thing.');
  const r = run('start.mjs', startArgs(task, dir));
  assert.equal(r.status, 0, r.stderr);
  const report = waitReport(task);
  assert.equal(report.status, 'done');
  assert.equal(report.summary, 'all fine');
  assert.ok(fs.existsSync(report.reportFile));
  const call = calls().find((c) => c.jhTask === task);
  assert.deepEqual(call.argv, ['exec', '--json', '-C', dir, '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=medium', '--dangerously-bypass-approvals-and-sandbox', '-']);
  assert.equal(call.cwd, dir);
  assert.equal(call.codexHome, codexHome);
  assert.match(call.input, /^Instructions for this session:\n\nYou are working on one step of one task/);
  assert.match(call.input, /Your step is duty investigate\. The duty's instructions follow here/);
  assert.match(call.input, /Start the step now\. End by writing \.jevellan\/report\.json\.$/);
  const events = ledger.readEvents(project).events.filter((e) => e.task === task);
  const thread = events.find((e) => e.kind === 'session.started')?.data?.nativeSessionId;
  assert.match(thread, /^thread-/);
  assert.equal(events.find((e) => e.kind === 'step.started').data.runtime, 'codex');
  assert.ok(events.some((e) => e.kind === 'session.ended'));

  // resume the same thread
  const res = run('resume.mjs', ['--task', task, '--step', '1', '--message', 'Continue.']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).threadId, thread);
  const second = waitReport(task);
  assert.equal(second.summary, 'resumed fine');
  const resumeCall = calls().filter((c) => c.jhTask === task)[1];
  assert.deepEqual(resumeCall.argv, ['exec', 'resume', '--json', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=medium', '--dangerously-bypass-approvals-and-sandbox', thread, '-']);
  assert.equal(resumeCall.input, 'From the coordinator: Continue.');
  assert.equal(resumeCall.cwd, dir);
});

test('no report is recorded blocked and synthesized; an invalid one blocked with its problem', () => {
  let { task, dir } = newTask('NOREPORT please.');
  assert.equal(run('start.mjs', startArgs(task, dir)).status, 0);
  let report = waitReport(task);
  assert.equal(report.status, 'blocked');
  assert.equal(report.synthesized, true);
  ({ task, dir } = newTask('BADREPORT please.'));
  assert.equal(run('start.mjs', startArgs(task, dir)).status, 0);
  report = waitReport(task);
  assert.equal(report.status, 'blocked');
  assert.match(report.limitations, /options must have 2 to 4 items/);
});

test('stop ends the runner and codex; a provider without a Codex login is refused', () => {
  const { task, dir } = newTask('SLOW please.');
  const r = JSON.parse(run('start.mjs', startArgs(task, dir)).stdout);
  spawnSync('sleep', ['1']);
  const stopped = run('stop.mjs', ['--task', task, '--step', '1']);
  assert.equal(stopped.status, 0, stopped.stderr);
  let alive = true;
  try {
    process.kill(r.pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false);
  assert.ok(ledger.readEvents(project).events.some((e) => e.task === task && e.kind === 'step.stopped'));
  const other = newTask('no login');
  ledger.appendEvent(project, { kind: 'task.placed', task: other.task, data: { step: 1, provider: 'codex-nologin', model: 'gpt-6-astra', effort: 'medium', kind: 'codex-subscription', source: 'owner' } });
  const refused = run('start.mjs', ['--task', other.task, '--step', '1', '--duty', 'investigate', '--cwd', other.dir, '--provider', 'codex-nologin', '--model', 'gpt-6-astra', '--effort', 'medium']);
  assert.equal(refused.status, 2);
  assert.match(JSON.parse(refused.stdout).error, /codex login/);
});
