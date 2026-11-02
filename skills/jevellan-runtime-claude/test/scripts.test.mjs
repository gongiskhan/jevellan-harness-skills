// The Claude runtime's four scripts end to end, alone: a temporary skills root holds a copy of this skill, a fake
// ledger (canned show --json, every call recorded, exit 6 or a refusal on demand) and fake duty skills; a fake
// `claude` (JH_CLAUDE_BIN) records how it was run. Covers the guards before spawning, the compare-and-append of
// step.started with its retry and the kill on refusal, resume, stop, status, and a missing role.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE, HARNESS_HOME, ROLE_MISSING, TOKEN, TaskLines, alive, deadPid, fakeClaude, flag, killIfOurs, makeProject,
  makeSkillsRoot, records, runScript, sleeper, tempDir, waitFor, writeProviders,
} from './helpers/fakes.mjs';

const out = tempDir('jh-fake-out-');
const fakes = path.join(out, 'fake-claude');
let bin;
let skills;
let project;
let wt;
const cleanup = [];

const run = (script, args, cwd = project, at = skills) => runScript(at, script, args, { cwd, env: { TMPDIR: out, JH_CLAUDE_BIN: bin } });
const startArgs = (task, { step = 1, duty = 'investigate', cwd = wt, where = CLAUDE } = {}) => ['--task', task, '--step', String(step), '--duty', duty, '--cwd', cwd, '--provider', where.provider, '--model', where.model, '--effort', where.effort];
const runs = (session) => records(fakes, `${session}.jsonl`);
const allRuns = () => (fs.existsSync(fakes) ? fs.readdirSync(fakes).filter((f) => f.endsWith('.jsonl')).flatMap((f) => records(fakes, f)) : []);
const sleepFor = (task, ms) => {
  fs.mkdirSync(fakes, { recursive: true });
  fs.writeFileSync(path.join(fakes, `sleep-${task}`), String(ms));
};
// The record and append calls of one event kind.
const appends = (kind) => skills.calls().filter((c) => c.argv[0] !== 'show' && c.argv[1] === kind);
const shows = () => skills.calls().filter((c) => c.argv[0] === 'show');

// A single task with a worktree and a placement on CLAUDE, as the fake ledger shows it.
function placedTask(options = {}) {
  const lines = new TaskLines(options);
  lines.worktree(wt);
  const placed = lines.placed(1, CLAUDE);
  return { lines, placed };
}

before(() => {
  writeProviders();
  bin = fakeClaude();
  skills = makeSkillsRoot();
  ({ project, wt } = makeProject());
});

after(() => {
  for (const rec of allRuns()) killIfOurs(rec.pid, bin);
  for (const stop of cleanup) stop();
});

describe('start', () => {
  test('spawns claude in the worktree, then records step.started (compare-and-append) and session.started', () => {
    const { lines } = placedTask();
    const show = lines.show();
    skills.script({ shows: { [lines.task]: [show] } });
    const r = run('start.mjs', startArgs(lines.task));
    assert.equal(r.status, 0, r.stderr);
    const o = r.json;
    assert.ok(waitFor(() => runs(o.session).length === 1));
    const rec = runs(o.session)[0];
    assert.equal(rec.cwd, wt);
    assert.equal(rec.pid, o.pid);
    assert.deepEqual(rec.argv.slice(0, 3), ['-p', '--session-id', o.session]);
    assert.deepEqual(rec.argv.slice(-2), ['--', 'Start the step now. End by writing .jevellan/report.json.']);
    const settings = JSON.parse(rec.argv[rec.argv.indexOf('--settings') + 1]);
    assert.ok(settings.claudeMdExcludes.includes(path.join(path.dirname(wt), 'CLAUDE.md')));
    assert.ok(!settings.claudeMdExcludes.some((p) => p.startsWith(`${wt}/`)));
    assert.ok(!rec.argv.join(' ').includes(TOKEN), 'the token is never on the command line');
    assert.equal(rec.env.CLAUDE_CODE_OAUTH_TOKEN, '(set)');
    assert.deepEqual([rec.env.JH_TASK, rec.env.JH_STEP, rec.env.JH_DUTY, rec.env.JH_PROJECT, rec.env.JH_SESSION, rec.env.JH_CWD], [lines.task, '1', 'investigate', project, o.session, wt]);
    assert.equal(rec.env.CLAUDE_CONFIG_DIR, path.join(HARNESS_HOME, 'claude-config'));
    const append = fs.readFileSync(o.appendFile, 'utf8');
    assert.match(append, /Your step is duty investigate\. Use the duty skill for investigate now and follow it\./);
    assert.match(append, /FIXTURE-AGENTS/);
    assert.match(append, new RegExp(`Task ${lines.task}: A fake task`));
    // The ledger: read twice (the guards, then the fresh reading), then the two lines.
    const calls = skills.calls();
    assert.deepEqual(calls.map((c) => c.argv.slice(0, 2)), [['show', lines.task], ['show', lines.task], ['record', 'step.started'], ['record', 'session.started']]);
    assert.ok(calls.every((c) => c.cwd === project && c.argv.includes('--json')));
    const started = calls[2];
    assert.equal(flag(started.argv, 'if-last-seq'), String(show.lastSeq));
    assert.equal(flag(started.argv, 'step'), '1');
    assert.equal(flag(started.argv, 'session'), o.session);
    assert.deepEqual(started.event.data, { ordinal: 1, duty: 'investigate', runtime: 'claude', provider: 'claude-test', model: 'claude-sonnet-5-5', effort: 'low', cwd: wt, nativeSessionId: o.session, pid: o.pid, logFile: o.logFile });
    assert.equal(flag(calls[3].argv, 'if-last-seq'), undefined);
    assert.deepEqual(calls[3].event.data, { role: 'worker', nativeSessionId: o.session, model: 'claude-sonnet-5-5' });
  });

  test('a task that changed meanwhile is read and decided again, then appended on the fresh reading', () => {
    const { lines } = placedTask();
    // A long-lived worker: it must survive the retry, which only re-reads and appends again.
    sleepFor(lines.task, 60000);
    const before = lines.show();
    lines.note('written by someone else meanwhile');
    const changed = lines.show();
    skills.script({ shows: { [lines.task]: [before, before, changed] }, changed: 1 });
    const r = run('start.mjs', startArgs(lines.task));
    assert.equal(r.status, 0, r.stderr);
    const tries = appends('step.started');
    assert.deepEqual(tries.map((c) => [flag(c.argv, 'if-last-seq'), c.exit]), [[String(before.lastSeq), 6], [String(changed.lastSeq), 0]]);
    assert.equal(shows().length, 3);
    assert.equal(appends('session.started').length, 1);
    assert.ok(waitFor(() => runs(r.json.session).length === 1), 'the worker started');
    assert.ok(alive(r.json.pid), 'the worker spawned before the retry survives it');
  });

  test('a start refused on the fresh reading kills the worker it spawned and records nothing more', () => {
    const { lines } = placedTask({ task: 'T0FAKE2' });
    sleepFor(lines.task, 60000);
    const before = lines.show();
    lines.started(1, 'someone-else', { pid: deadPid(), runtime: 'claude' });
    skills.script({ shows: { [lines.task]: [before, before, lines.show()] }, changed: 1 });
    const r = run('start.mjs', startArgs(lines.task));
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.json.error, new RegExp(`step 1 of ${lines.task} was started meanwhile on the same placement`));
    const spawned = allRuns().filter((rec) => rec.env.JH_TASK === lines.task);
    assert.equal(spawned.length, 1, 'the worker had been spawned');
    assert.ok(waitFor(() => !alive(spawned[0].pid)), 'and is killed');
    assert.deepEqual(appends('step.started').map((c) => c.exit), [6]);
    assert.equal(appends('session.started').length, 0);
  });

  test('a ledger that refuses step.started, or session.started, gets the worker killed too', () => {
    for (const [task, kind] of [['T0FAKE3', 'step.started'], ['T0FAKE4', 'session.started']]) {
      const { lines } = placedTask({ task });
      sleepFor(task, 60000);
      skills.script({ shows: { [task]: [lines.show()] }, refuse: { [kind]: `${kind} refused for the test` } });
      const r = run('start.mjs', startArgs(task));
      assert.equal(r.status, 2, r.stdout);
      assert.equal(r.json.error, `${kind} refused for the test`);
      const spawned = allRuns().filter((rec) => rec.env.JH_TASK === task);
      assert.equal(spawned.length, 1);
      assert.ok(waitFor(() => !alive(spawned[0].pid)), `the worker is killed when ${kind} is refused`);
    }
  });

  test('refused before anything is spawned: no placement, another placement, outside the worktree, another duty, a done step', () => {
    const lines = new TaskLines({ task: 'T0FAKE5' });
    lines.worktree(wt);
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    const before = allRuns().length;
    let r = run('start.mjs', startArgs(lines.task));
    assert.equal(r.status, 2);
    assert.match(r.json.error, /has no placement since it last ran; use the placement skill first/);
    lines.placed(1, { ...CLAUDE, model: 'claude-opus-5-5', effort: 'high' });
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    r = run('start.mjs', startArgs(lines.task));
    assert.match(r.json.error, /is placed on claude-test claude-opus-5-5 high, not claude-test claude-sonnet-5-5 low/);
    r = run('start.mjs', startArgs(lines.task, { cwd: project, where: { ...CLAUDE, model: 'claude-opus-5-5', effort: 'high' } }));
    assert.match(r.json.error, /the task's worktree is .*; start the step there/);
    r = run('start.mjs', startArgs(lines.task, { duty: 'implement' }));
    assert.match(r.json.error, /step 1 of T0FAKE5 is investigate, not implement/);
    r = run('start.mjs', startArgs(lines.task, { duty: 'dance' }));
    assert.match(r.json.error, /--duty must be one of answer, converse/);
    lines.started(1, 's-old', { pid: deadPid() });
    lines.report(1, 's-old', { status: 'done' });
    lines.done(1);
    lines.placed(1, CLAUDE);
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    r = run('start.mjs', startArgs(lines.task));
    assert.equal(r.status, 2);
    assert.match(r.json.error, /step 1 of T0FAKE5 is done/);
    r = run('start.mjs', startArgs(lines.task, { where: { ...CLAUDE, provider: 'codex-test', model: 'gpt-6-astra', effort: 'medium' } }));
    assert.equal(r.status, 2);
    assert.equal(allRuns().length, before, 'no worker was spawned');
    assert.equal(appends('step.started').length, 0);
  });

  test('a tool-less duty gets one turn in the project and its duty body inline, without the Interface section', () => {
    const lines = new TaskLines({ task: 'T0FAKE6', duty: 'answer' });
    lines.placed(1, CLAUDE);
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    const r = run('start.mjs', startArgs(lines.task, { duty: 'answer', cwd: project }));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(waitFor(() => runs(r.json.session).length === 1));
    const { argv, cwd } = runs(r.json.session)[0];
    assert.equal(cwd, project);
    assert.equal(argv[argv.indexOf('--max-turns') + 1], '1');
    assert.equal(argv[argv.indexOf('--tools') + 1], '');
    const append = fs.readFileSync(r.json.appendFile, 'utf8');
    assert.match(append, /You have no tools, so the duty's instructions follow here:\n\n# Fake duty answer\n\nFAKE-DUTY-BODY of answer: cost \$1 and keep \$& as it is\./);
    assert.ok(!append.includes('## Interface'));
  });

  test('an unknown task is exit 3', () => {
    skills.script({ shows: {} });
    const r = run('start.mjs', startArgs('T0NONE1'));
    assert.equal(r.status, 3);
    assert.equal(r.json.error, `no task T0NONE1 in the ledger of ${project}`);
    assert.deepEqual(r.json, { error: r.json.error, exitCode: 3 });
  });
});

describe('resume', () => {
  function reportedTask(task, pid = deadPid()) {
    const { lines } = placedTask({ task });
    const session = `sess-${task}`;
    lines.started(1, session, { runtime: 'claude', provider: 'claude-test', model: 'claude-sonnet-5-5', effort: 'low', cwd: wt, pid });
    lines.report(1, session);
    fs.mkdirSync(path.join(HARNESS_HOME, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(HARNESS_HOME, 'logs', `${session}.append.md`), 'the step\'s append\n');
    return { lines, session };
  }

  test('sends the message to the same session: step.message (append, checked), then a new step.started', () => {
    const { lines, session } = reportedTask('T0RES01');
    const show = lines.show();
    skills.script({ shows: { [lines.task]: [show] } });
    const r = run('resume.mjs', ['--task', lines.task, '--step', '1', '--message', 'Continue.', '--from', 'owner']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.session, session);
    assert.ok(waitFor(() => runs(session).length === 1));
    const { argv, cwd } = runs(session)[0];
    assert.equal(cwd, wt);
    assert.deepEqual(argv.slice(0, 3), ['-p', '--resume', session]);
    assert.equal(argv[argv.length - 1], 'From the owner: Continue.');
    const calls = skills.calls();
    assert.deepEqual(calls.map((c) => c.argv.slice(0, 2)), [['show', lines.task], ['show', lines.task], ['append', 'step.message'], ['show', lines.task], ['record', 'step.started']]);
    assert.equal(flag(calls[2].argv, 'if-last-seq'), String(show.lastSeq));
    assert.deepEqual(calls[2].event.data, { direction: 'owner', text: 'Continue.' });
    assert.equal(flag(calls[4].argv, 'if-last-seq'), String(show.lastSeq));
    assert.equal(calls[4].event.data.resumed, true);
    assert.equal(calls[4].event.data.nativeSessionId, session);
    assert.equal(calls[4].event.data.pid, r.json.pid);
  });

  test('refused while the worker lives, and when the step was resumed meanwhile; nothing is spawned', () => {
    const s = sleeper();
    cleanup.push(s.stop);
    let { lines } = reportedTask('T0RES02', s.pid);
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    let r = run('resume.mjs', ['--task', lines.task, '--step', '1', '--message', 'Continue.']);
    assert.equal(r.status, 2);
    assert.match(r.json.error, new RegExp(`step 1 of ${lines.task} is running \\(pid ${s.pid}\\)`));
    s.stop();
    ({ lines } = reportedTask('T0RES03'));
    const before = lines.show();
    lines.started(1, 'sess-T0RES03', { runtime: 'claude', cwd: wt, pid: deadPid(), resumed: true });
    skills.script({ shows: { [lines.task]: [before, before, lines.show()] }, changed: 1 });
    r = run('resume.mjs', ['--task', lines.task, '--step', '1', '--message', 'Continue.']);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.json.error, /was started, resumed or reset meanwhile; look at its status first/);
    assert.deepEqual(appends('step.message').map((c) => c.exit), [6]);
    assert.equal(appends('step.started').length, 0);
    assert.equal(runs('sess-T0RES03').length, 0, 'no worker was spawned');
  });

  test('refused before the step started and for a step of the other runtime', () => {
    const { lines } = placedTask({ task: 'T0RES04' });
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    let r = run('resume.mjs', ['--task', lines.task, '--step', '1', '--message', 'Continue.']);
    assert.equal(r.status, 2);
    assert.match(r.json.error, /has not started; start it with start\.mjs/);
    lines.started(1, 'cx', { runtime: 'codex', pid: deadPid() });
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    r = run('resume.mjs', ['--task', lines.task, '--step', '1', '--message', 'Continue.']);
    assert.match(r.json.error, /runs on the codex runtime; resume it with that runtime's skill/);
  });
});

describe('stop and status', () => {
  test('stop signals the worker\'s group and records step.stopped', () => {
    const s = sleeper();
    cleanup.push(s.stop);
    const { lines } = placedTask({ task: 'T0STOP1' });
    lines.started(1, 'sess-stop', { runtime: 'claude', pid: s.pid });
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    const r = run('stop.mjs', ['--task', lines.task, '--step', '1']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.how, 'SIGTERM');
    assert.ok(waitFor(() => !alive(s.pid), 3000));
    const [stopped] = appends('step.stopped');
    assert.equal(stopped.argv[0], 'record');
    assert.equal(flag(stopped.argv, 'step'), '1');
    assert.equal(flag(stopped.argv, 'session'), 'sess-stop');
    assert.deepEqual(stopped.event.data, { ordinal: 1, reason: 'stopped (SIGTERM)', pid: s.pid });
    assert.equal(r.json.seq, stopped.event.seq);
    // Again: the process had already ended.
    const again = run('stop.mjs', ['--task', lines.task, '--step', '1', '--reason', 'tidy up']);
    assert.equal(again.json.how, 'not running');
    assert.equal(appends('step.stopped')[1].event.data.reason, 'tidy up');
  });

  test('stop of a step that never started is exit 3', () => {
    const { lines } = placedTask({ task: 'T0STOP2' });
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    const r = run('stop.mjs', ['--task', lines.task, '--step', '1']);
    assert.equal(r.status, 3);
    assert.equal(appends('step.stopped').length, 0);
  });

  test('status finds the newest start even after a retry reset, and masks secrets in the last log line', () => {
    const logFile = path.join(tempDir('jh-log-'), 'worker.log');
    fs.writeFileSync(logFile, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })}\n${JSON.stringify({ type: 'result', subtype: 'success', result: `used ${TOKEN} to sign in` })}\n`);
    const lines = new TaskLines({ task: 'T0STAT1', kind: 'feature' });
    lines.workflow([{ ordinal: 1, duty: 'investigate', onFail: { goto: 1, maxLoops: 2 } }]);
    lines.placed(1, CLAUDE);
    const started = lines.started(1, 'sess-stat', { runtime: 'claude', provider: 'claude-test', model: 'claude-sonnet-5-5', effort: 'low', pid: deadPid(), logFile });
    lines.add('step.failed', { ordinal: 1, reason: 'gave up' }, { step: 1 });
    lines.add('step.retrying', { ordinal: 1, attempt: 1, gotoOrdinal: 1, reason: 'again' }, { step: 1 });
    skills.script({ shows: { [lines.task]: [lines.show()] } });
    const r = run('status.mjs', ['--task', lines.task, '--step', '1']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json, { task: lines.task, step: 1, state: 'exited', pid: started.data.pid, session: 'sess-stat', startedAt: started.t, model: 'claude-sonnet-5-5', effort: 'low', provider: 'claude-test', ended: 'step.failed', lastLine: 'result: success used [redacted] to sign in' });
  });
});

describe('a missing role', () => {
  test('without a ledger skill every script is refused with exit 2 and the role-missing sentence; no worker starts', () => {
    const lonely = makeSkillsRoot({ ledger: false });
    const before = allRuns().length;
    const sentence = `no installed skill has the role ledger; ${ROLE_MISSING}`;
    for (const [script, args] of [
      ['start.mjs', startArgs('T0FAKE1')],
      ['resume.mjs', ['--task', 'T0FAKE1', '--step', '1', '--message', 'Continue.']],
      ['stop.mjs', ['--task', 'T0FAKE1', '--step', '1']],
      ['status.mjs', ['--task', 'T0FAKE1', '--step', '1']],
    ]) {
      const r = run(script, args, project, lonely);
      assert.equal(r.status, 2, `${script}: ${r.stdout}`);
      assert.deepEqual(r.json, { error: sentence, exitCode: 2 });
      assert.equal(r.stderr.trim(), sentence);
    }
    assert.equal(allRuns().length, before, 'no worker process was started');
  });

  test('without the step\'s duty skill start is refused with exit 2 and the role-missing sentence', () => {
    const noDuty = makeSkillsRoot({ duties: [] });
    const { lines } = placedTask({ task: 'T0DUTY1' });
    noDuty.script({ shows: { [lines.task]: [lines.show()] } });
    const before = allRuns().length;
    const r = run('start.mjs', startArgs(lines.task), project, noDuty);
    assert.equal(r.status, 2);
    assert.equal(r.json.error, `no installed skill has the role duty (duty investigate); ${ROLE_MISSING}`);
    assert.equal(allRuns().length, before);
  });
});
