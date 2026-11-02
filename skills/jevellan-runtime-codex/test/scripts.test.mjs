// The Codex runtime's four scripts and its runner end to end, alone: a temporary skills root holds a copy of this
// skill, a fake ledger (canned show --json, every call recorded, exit 6 or a refusal on demand) and fake duty skills;
// a fake `codex` (JH_CODEX_BIN) records how it was run. Covers the runner's order of lines (step.started, then
// session.started, then take-report), the kill of a refused start's runner and Codex, resume, stop, status, the masked
// log, and a missing role.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CODEX, ROLE_MISSING, TOKEN, TaskLines, alive, deadPid, fakeCodex, flag, killIfOurs, makeProject,
  makeSkillsRoot, records, runScript, sleeper, tempDir, waitFor, writeProviders,
} from './helpers/fakes.mjs';

const out = tempDir('jh-fake-out-');
const fakes = path.join(out, 'fake-codex');
let bin;
let skills;
let project;
let wt;
let codexHome;
const cleanup = [];

const run = (script, args, cwd = project, at = skills) => runScript(at, script, args, { cwd, env: { TMPDIR: out, JH_CODEX_BIN: bin } });
const startArgs = (task, { duty = 'investigate', cwd = wt, where = CODEX } = {}) => ['--task', task, '--step', '1', '--duty', duty, '--cwd', cwd, '--provider', where.provider, '--model', where.model, '--effort', where.effort];
const runsOf = (task) => records(fakes, `${task}.jsonl`);
const allRuns = () => (fs.existsSync(fakes) ? fs.readdirSync(fakes).filter((f) => f.endsWith('.jsonl')).flatMap((f) => records(fakes, f)) : []);
const sleepFor = (task, ms) => {
  fs.mkdirSync(fakes, { recursive: true });
  fs.writeFileSync(path.join(fakes, `sleep-${task}`), String(ms));
};
const ledgerKinds = () => skills.calls().filter((c) => c.argv[0] !== 'events').map((c) => (c.argv[0] === 'show' || c.argv[0] === 'take-report' ? c.argv[0] : `${c.argv[0]} ${c.argv[1]}${c.exit ? ` (exit ${c.exit})` : ''}`));
const taken = () => skills.calls().filter((c) => c.argv[0] === 'take-report');

function placedTask(task, text = 'Do the fake thing.') {
  const lines = new TaskLines({ task, text });
  lines.worktree(wt);
  lines.placed(1, CODEX);
  return lines;
}

before(() => {
  ({ codexHome } = writeProviders());
  bin = fakeCodex();
  skills = makeSkillsRoot();
  ({ project, wt } = makeProject());
});

after(() => {
  for (const rec of allRuns()) {
    killIfOurs(rec.ppid, 'runner.mjs');
    killIfOurs(rec.pid, bin);
  }
  for (const stop of cleanup) stop();
});

describe('start and the runner', () => {
  test('a turn: codex in the worktree with the first message; step.started, then session.started, then take-report', () => {
    const lines = placedTask('T0CDX01');
    const show = lines.show();
    skills.script({ shows: { [lines.task]: [show] } });
    const r = run('start.mjs', startArgs(lines.task));
    assert.equal(r.status, 0, r.stderr);
    const o = r.json;
    assert.ok(waitFor(() => taken().length === 1, 15000), 'the runner handed the turn to the ledger');
    const [rec] = runsOf(lines.task);
    assert.equal(rec.ppid, o.pid, 'codex runs under the runner, whose pid the start recorded');
    assert.deepEqual(rec.argv, ['exec', '--json', '-C', wt, '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=medium', '--dangerously-bypass-approvals-and-sandbox', '-']);
    assert.equal(rec.cwd, wt);
    assert.equal(rec.codexHome, codexHome);
    assert.equal(rec.jhCwd, wt);
    assert.match(rec.input, /^Instructions for this session:\n\nYou are working on one step of one task/);
    assert.match(rec.input, /Your step is duty investigate\. The duty's instructions follow here:\n\n# Fake duty investigate/);
    assert.ok(!rec.input.includes('## Interface'));
    assert.match(rec.input, /FIXTURE-AGENTS/);
    assert.match(rec.input, /Start the step now\. End by writing \.jevellan\/report\.json\.$/);
    assert.deepEqual(ledgerKinds(), ['show', 'show', 'record step.started', 'record session.started', 'take-report']);
    const calls = skills.calls();
    const started = calls.find((c) => c.argv[1] === 'step.started');
    assert.equal(flag(started.argv, 'if-last-seq'), String(show.lastSeq));
    assert.deepEqual(started.event.data, { ordinal: 1, duty: 'investigate', runtime: 'codex', provider: 'codex-test', model: 'gpt-6-astra', effort: 'medium', cwd: wt, nativeSessionId: null, pid: o.pid, logFile: o.logFile });
    const session = calls.find((c) => c.argv[1] === 'session.started');
    assert.equal(flag(session.argv, 'session'), o.session);
    assert.deepEqual(session.event.data, { role: 'worker', nativeSessionId: `thread-${rec.pid}`, model: 'gpt-6-astra', runtime: 'codex' });
    const [take] = taken();
    assert.deepEqual(take.report, { task: lines.task, step: 1, session: o.session, nativeSession: `thread-${rec.pid}`, ended: 'codex exec ended with exit 0', status: 'done', synthesized: false });
    assert.equal(flag(take.argv, 'cwd'), wt);
    assert.equal(take.cwd, project);
    assert.ok(waitFor(() => !alive(o.pid)), 'the runner exits after the turn');
  });

  test('a turn with no report is still handed to take-report, which synthesizes it', () => {
    const lines = placedTask('T0CDX02', 'NOREPORT please.');
    fs.rmSync(path.join(wt, '.jevellan', 'report.json'), { force: true });
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    const r = run('start.mjs', startArgs(lines.task));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(waitFor(() => taken().length === 1, 15000));
    assert.equal(taken()[0].report.status, 'blocked');
    assert.equal(taken()[0].report.synthesized, true);
  });

  test('a start refused on the fresh reading kills the runner and codex; no session or report is recorded', () => {
    const lines = placedTask('T0CDX03');
    sleepFor(lines.task, 60000);
    const before = lines.show();
    lines.started(1, 'someone-else', { runtime: 'codex', pid: deadPid() });
    skills.script({ shows: { [lines.task]: [before, before, lines.show()] }, changed: 1 });
    const r = run('start.mjs', startArgs(lines.task));
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.json.error, /was started meanwhile on the same placement/);
    // The refused append carried the runner's pid.
    const refused = skills.calls().find((c) => c.argv[1] === 'step.started');
    const runner = JSON.parse(refused.input).pid;
    assert.ok(Number.isInteger(runner) && runner > 1);
    assert.ok(waitFor(() => !alive(runner)), 'the runner is killed');
    for (const rec of runsOf(lines.task)) {
      assert.equal(rec.ppid, runner);
      assert.ok(waitFor(() => !alive(rec.pid)), 'and codex with it');
    }
    assert.deepEqual(ledgerKinds(), ['show', 'show', 'record step.started (exit 6)', 'show']);
  });

  test('a retry on a task that changed meanwhile appends on the fresh reading', () => {
    const lines = placedTask('T0CDX04');
    const before = lines.show();
    lines.note('meanwhile');
    skills.script({ shows: { [lines.task]: [before, before, lines.show()] }, changed: 1 });
    const r = run('start.mjs', startArgs(lines.task));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(waitFor(() => taken().length === 1, 15000));
    assert.deepEqual(ledgerKinds(), ['show', 'show', 'record step.started (exit 6)', 'show', 'record step.started', 'record session.started', 'take-report']);
  });

  test('the step log carries codex output with secrets masked', () => {
    const lines = placedTask('T0CDX05', 'LEAKY please.');
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    const r = run('start.mjs', startArgs(lines.task));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(waitFor(() => taken().length === 1, 15000));
    const text = fs.readFileSync(r.json.logFile, 'utf8');
    assert.ok(!text.includes(TOKEN), text);
    assert.match(text, /curl -H \[redacted\]/);
    assert.match(text, /warning: key \[redacted\] rejected/);
  });

  test('refused before anything is spawned: no worktree, another placement, a provider without a login', () => {
    const lines = new TaskLines({ task: 'T0CDX06' });
    lines.placed(1, CODEX);
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    const before = allRuns().length;
    let r = run('start.mjs', startArgs(lines.task));
    assert.equal(r.status, 2);
    assert.match(r.json.error, /has no worktree; use the git skill to make it first/);
    lines.worktree(wt);
    lines.placed(1, { ...CODEX, provider: 'codex-nologin' });
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    r = run('start.mjs', startArgs(lines.task));
    assert.match(r.json.error, /is placed on codex-nologin gpt-6-astra medium, not codex-test/);
    r = run('start.mjs', startArgs(lines.task, { where: { ...CODEX, provider: 'codex-nologin' } }));
    assert.equal(r.status, 2);
    assert.match(r.json.error, /no Codex login in .*; the owner runs "codex login" once/);
    assert.equal(allRuns().length, before);
    assert.equal(skills.calls().filter((c) => c.argv[0] === 'record').length, 0);
  });
});

describe('resume, stop, status', () => {
  test('resume continues the thread: step.message, then a new step.started with the thread id, then the report', () => {
    const lines = placedTask('T0CDX07');
    lines.started(1, 'sess-cdx7', { runtime: 'codex', provider: 'codex-test', model: 'gpt-6-astra', effort: 'medium', cwd: wt, nativeSessionId: null, pid: deadPid() });
    lines.add('session.started', { role: 'worker', nativeSessionId: 'thread-old', model: 'gpt-6-astra', runtime: 'codex' }, { step: 1, session: 'sess-cdx7' });
    lines.report(1, 'sess-cdx7');
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    const r = run('resume.mjs', ['--task', lines.task, '--step', '1', '--message', 'Continue.']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.threadId, 'thread-old');
    assert.ok(waitFor(() => taken().length === 1, 15000));
    const [rec] = runsOf(lines.task);
    assert.deepEqual(rec.argv, ['exec', 'resume', '--json', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=medium', '--dangerously-bypass-approvals-and-sandbox', 'thread-old', '-']);
    assert.equal(rec.input, 'From the coordinator: Continue.');
    assert.equal(rec.cwd, wt);
    // A resumed turn announces the thread it was given; it is already the session's native id.
    assert.deepEqual(ledgerKinds(), ['show', 'show', 'append step.message', 'show', 'record step.started', 'take-report']);
    const started = skills.calls().find((c) => c.argv[1] === 'step.started');
    assert.equal(started.event.data.nativeSessionId, 'thread-old');
    assert.equal(started.event.data.resumed, true);
    assert.equal(taken()[0].report.nativeSession, 'thread-old');
  });

  test('stop ends the runner\'s group and records step.stopped; status says exited', () => {
    const s = sleeper();
    cleanup.push(s.stop);
    const logFile = path.join(tempDir('jh-log-'), 'cdx.log');
    fs.writeFileSync(logFile, `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `I used ${TOKEN}` } })}\n`);
    const lines = placedTask('T0CDX08');
    lines.started(1, 'sess-cdx8', { runtime: 'codex', provider: 'codex-test', model: 'gpt-6-astra', effort: 'medium', cwd: wt, nativeSessionId: null, pid: s.pid, logFile });
    lines.add('session.started', { role: 'worker', nativeSessionId: 'thread-8' }, { step: 1, session: 'sess-cdx8' });
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    let st = run('status.mjs', ['--task', lines.task, '--step', '1']);
    assert.equal(st.json.state, 'alive');
    assert.equal(st.json.session, 'thread-8');
    assert.equal(st.json.lastLine, 'said: I used [redacted]');
    const r = run('stop.mjs', ['--task', lines.task, '--step', '1']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.how, 'SIGTERM');
    assert.ok(waitFor(() => !alive(s.pid), 3000));
    const stopped = skills.calls().find((c) => c.argv[1] === 'step.stopped');
    assert.equal(stopped.argv[0], 'record');
    assert.deepEqual(stopped.event.data, { ordinal: 1, reason: 'stopped (SIGTERM)', pid: s.pid });
    st = run('status.mjs', ['--task', lines.task, '--step', '1']);
    assert.equal(st.json.state, 'exited');
  });
});

describe('a missing role', () => {
  test('without a ledger skill every script is refused with exit 2 and the role-missing sentence; nothing runs', () => {
    const lonely = makeSkillsRoot({ ledger: false });
    const before = allRuns().length;
    const sentence = `no installed skill has the role ledger; ${ROLE_MISSING}`;
    for (const [script, args] of [
      ['start.mjs', startArgs('T0CDX01')],
      ['resume.mjs', ['--task', 'T0CDX01', '--step', '1', '--message', 'Continue.']],
      ['stop.mjs', ['--task', 'T0CDX01', '--step', '1']],
      ['status.mjs', ['--task', 'T0CDX01', '--step', '1']],
    ]) {
      const r = run(script, args, project, lonely);
      assert.equal(r.status, 2, `${script}: ${r.stdout}`);
      assert.deepEqual(r.json, { error: sentence, exitCode: 2 });
    }
    assert.equal(allRuns().length, before, 'no codex ran');
  });

  test('without the step\'s duty skill start is refused with exit 2 and the role-missing sentence', () => {
    const noDuty = makeSkillsRoot({ duties: [] });
    const lines = placedTask('T0CDX09');
    noDuty.script({ shows: { [lines.task]: [lines.show()] } });
    const r = run('start.mjs', startArgs(lines.task), project, noDuty);
    assert.equal(r.status, 2);
    assert.equal(r.json.error, `no installed skill has the role duty (duty investigate); ${ROLE_MISSING}`);
  });
});
