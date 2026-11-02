// The projection of section 4: one scripted sequence per rule and per edge, the step view and its resets, lost
// detection, and the command line's status agreeing with the library for every scripted task.
// Rule order in lib/ledger.mjs: stopped, done, waiting-owner, landing, failed, running, queued.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TaskScript, cli, deadPid, livePid, makeRepo, readLedger } from './helpers/ledger-fixture.mjs';
import {
  appendEvent,
  groupByTask,
  projectAll,
  projectTask,
  readEvents,
  resetFor,
  resetPoints,
  stepView,
} from '../skills/jevellan-ledger/scripts/lib/ledger.mjs';

// Every scenario lives in one ledger, so the last test can check that `ledger.mjs status --json` agrees.
const root = makeRepo();
const expected = new Map();
const expect = (script, state) => expected.set(script.task, state);

const FEATURE = [
  { ordinal: 1, duty: 'implement' },
  { ordinal: 2, duty: 'verify', onFail: { goto: 1, maxLoops: 2 } },
  { ordinal: 3, duty: 'document' },
];

function feature() {
  const s = new TaskScript(root, { kind: 'feature' });
  s.worktree();
  s.workflow(FEATURE);
  return s;
}

function allDone() {
  const s = feature();
  for (const step of FEATURE) s.stepDone(step.ordinal, { duty: step.duty });
  return s;
}

describe('rule 1: stopped', () => {
  test('a step.stopped after everything else is stopped, with its reason', () => {
    const s = feature();
    s.started(1);
    s.stopped(1, 'the owner stopped it');
    const v = s.view();
    assert.equal(v.state, 'stopped');
    assert.equal(v.reason, 'the owner stopped it');
    expect(s, 'stopped');
  });

  test('notes and session events after the stop do not undo it', () => {
    const s = feature();
    s.started(1);
    s.stopped(1);
    s.sessionEvent(1);
    s.note('still stopped');
    appendEvent(root, { kind: 'session.ended', task: s.task, step: 1, data: { nativeSessionId: 'native-1', reason: 'killed' } });
    assert.equal(s.view().state, 'stopped');
    expect(s, 'stopped');
  });

  test('a step started again after a stop is running, not stopped', () => {
    const s = feature();
    s.started(1);
    s.stopped(1);
    s.started(1, { pid: process.pid });
    assert.equal(s.view().state, 'running');
    expect(s, 'running');
  });

  test('stopped comes before done: a single step that reported done and was then stopped is stopped', () => {
    const s = new TaskScript(root, { kind: 'single', duty: 'investigate' });
    s.started(1);
    s.report(1, { status: 'done' });
    s.stopped(1);
    assert.equal(s.view().state, 'stopped');
    expect(s, 'stopped');
  });
});

describe('rule 2: done', () => {
  test('task.landed makes the task done, with the commit', () => {
    const s = allDone();
    s.decided('land');
    s.checked(true);
    s.landed('0123456789abcdef');
    const v = s.view();
    assert.equal(v.state, 'done');
    assert.equal(v.landedCommit, '0123456789abcdef');
    assert.ok(v.landedAt);
    expect(s, 'done');
  });

  test('task.landed wins over an earlier question: a task the owner landed after a needs-decision is done', () => {
    const s = feature();
    s.started(1);
    s.report(1, { status: 'needs-decision', question: 'Blue or Green?', options: [{ label: 'Blue' }, { label: 'Green' }] });
    s.landed();
    assert.equal(s.view().state, 'done');
    expect(s, 'done');
  });

  test('a single read-only duty whose step reported done is done', () => {
    const s = new TaskScript(root, { kind: 'single', duty: 'investigate' });
    s.placed(1);
    s.started(1);
    s.report(1, { status: 'done', summary: 'Found it.' });
    const v = s.view();
    assert.equal(v.state, 'done');
    assert.ok(v.doneAt);
    expect(s, 'done');
  });

  test('a single read-only duty is done even when its report lists changed files (plan.md)', () => {
    const s = new TaskScript(root, { kind: 'single', duty: 'plan' });
    s.started(1);
    s.report(1, { status: 'done', changedFiles: ['plan.md'] });
    assert.equal(s.view().state, 'done');
    expect(s, 'done');
  });

  test('a single write duty whose done report changed files is not done: it still has to land', () => {
    const s = new TaskScript(root, { kind: 'single', duty: 'implement' });
    s.started(1);
    s.report(1, { status: 'done', changedFiles: ['README.md'] });
    const v = s.view();
    assert.notEqual(v.state, 'done');
    assert.equal(v.state, 'queued');
    assert.equal(v.steps[0].state, 'reported-done');
    expect(s, 'queued');
  });

  test('a single write duty whose done report changed nothing is done', () => {
    const s = new TaskScript(root, { kind: 'single', duty: 'implement' });
    s.started(1);
    s.report(1, { status: 'done', changedFiles: [] });
    assert.equal(s.view().state, 'done');
    expect(s, 'done');
  });

  test('a single task whose done report was followed by a new start is running again', () => {
    const s = new TaskScript(root, { kind: 'single', duty: 'answer' });
    s.started(1);
    s.report(1, { status: 'done' });
    s.started(1, { pid: process.pid });
    assert.equal(s.view().state, 'running');
    expect(s, 'running');
  });

  test('a feature task whose every step is done but not landed is not done', () => {
    const s = allDone();
    const v = s.view();
    assert.equal(v.state, 'queued');
    assert.deepEqual(v.steps.map((x) => x.state), ['done', 'done', 'done']);
    expect(s, 'queued');
  });
});

describe('rule 3: waiting-owner', () => {
  test('a needs-decision report waits on the owner with its question and options', () => {
    const s = new TaskScript(root, { kind: 'single', duty: 'investigate' });
    s.started(1);
    const options = [{ label: 'Blue' }, { label: 'Green', description: 'the other one' }];
    s.report(1, { status: 'needs-decision', summary: 'Pick a colour.', question: 'Blue or Green?', options });
    const v = s.view();
    assert.equal(v.state, 'waiting-owner');
    assert.deepEqual(v.waiting, { source: 'step', step: 1, status: 'needs-decision', question: 'Blue or Green?', options, summary: 'Pick a colour.' });
    expect(s, 'waiting-owner');
  });

  test('a blocked report waits on the owner', () => {
    const s = feature();
    s.started(1);
    s.report(1, { status: 'blocked', summary: 'No report was written.', synthesized: true });
    const v = s.view();
    assert.equal(v.state, 'waiting-owner');
    assert.equal(v.waiting.status, 'blocked');
    assert.equal(v.waiting.question, null);
    assert.deepEqual(v.waiting.options, []);
    expect(s, 'waiting-owner');
  });

  test('a message to the step does not end the wait; a new start does', () => {
    const s = feature();
    s.started(1);
    s.report(1, { status: 'needs-decision', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] });
    s.add('step.message', { direction: 'owner', text: 'A' }, 1);
    assert.equal(s.view().state, 'waiting-owner');
    s.started(1, { pid: process.pid });
    assert.equal(s.view().state, 'running');
    expect(s, 'running');
  });

  test('task.asked as the last landing event waits on the owner with the landing question', () => {
    const s = allDone();
    s.decided('ask-owner', 'touches the billing code');
    s.asked('Land this task?', ['Land now', 'Leave it']);
    const v = s.view();
    assert.equal(v.state, 'waiting-owner');
    assert.deepEqual(v.waiting, { source: 'landing', question: 'Land this task?', options: ['Land now', 'Leave it'] });
    expect(s, 'waiting-owner');
  });

  test('a step started after task.asked is judged by the step rules, not by the open landing question', () => {
    const s = allDone();
    s.decided('ask-owner');
    s.asked();
    s.started(3, { duty: 'document', pid: process.pid });
    assert.equal(s.view().state, 'running');
    expect(s, 'running');
  });

  test('waiting-owner comes before landing: a landing question after the decision waits on the owner', () => {
    const s = allDone();
    s.decided('land');
    s.checked(true);
    s.asked('The merge conflicted. Land anyway?', ['Land now', 'Leave it']);
    assert.equal(s.view().state, 'waiting-owner');
    expect(s, 'waiting-owner');
  });
});

describe('rule 4: landing', () => {
  test('landing.decided without task.landed is landing, with the route and reason', () => {
    const s = allDone();
    s.decided('land', 'small and tested');
    const v = s.view();
    assert.equal(v.state, 'landing');
    assert.deepEqual(v.landing, { route: 'land', reason: 'small and tested' });
    expect(s, 'landing');
  });

  test('a passing landing check is still landing', () => {
    const s = allDone();
    s.decided('land');
    s.checked(true);
    assert.equal(s.view().state, 'landing');
    expect(s, 'landing');
  });

  test('verify-then-land: the extra verify step running is part of landing', () => {
    const s = allDone();
    s.decided('verify-then-land', 'the change touches the browser flow');
    s.placed(4, { model: 'verify-model' });
    s.started(4, { duty: 'verify', pid: process.pid });
    const v = s.view();
    assert.equal(v.state, 'landing');
    assert.deepEqual(v.landing, { route: 'verify-then-land', reason: 'the change touches the browser flow', verifyStep: 4 });
    assert.equal(v.currentStep, 4);
    expect(s, 'landing');
  });

  test('verify-then-land: once the extra verify step reported done, it waits for its step.done (queued)', () => {
    const s = allDone();
    s.decided('verify-then-land');
    s.started(4, { duty: 'verify' });
    s.report(4, { status: 'done', testsRun: { command: 'npm test', passed: true, summary: 'all green' } });
    const v = s.view();
    assert.equal(v.state, 'queued');
    assert.equal(v.steps.find((x) => x.ordinal === 4).state, 'reported-done');
    expect(s, 'queued');
  });

  test('a step started after a plain land decision is judged by the step rules', () => {
    const s = allDone();
    s.decided('land');
    s.started(3, { duty: 'document', pid: process.pid });
    assert.equal(s.view().state, 'running');
    expect(s, 'running');
  });
});

describe('rule 5: failed', () => {
  test('step.failed as the last step event is failed, with its reason', () => {
    const s = feature();
    s.started(1);
    s.failed(1, 'the worker crashed');
    const v = s.view();
    assert.equal(v.state, 'failed');
    assert.equal(v.reason, 'the worker crashed');
    expect(s, 'failed');
  });

  test('step.lost as the last step event is failed', () => {
    const s = feature();
    s.started(1, { pid: 4242 });
    s.lost(1, 4242);
    const v = s.view();
    assert.equal(v.state, 'failed');
    assert.equal(v.reason, 'step 1 lost (pid 4242 gone)');
    expect(s, 'failed');
  });

  test('a failed landing check is failed', () => {
    const s = allDone();
    s.decided('land');
    s.checked(false, 'npm test');
    const v = s.view();
    assert.equal(v.state, 'failed');
    assert.equal(v.reason, 'landing check failed: npm test');
    expect(s, 'failed');
  });

  test('a fix after a failed landing check (retry back to implement, then a new start) is running', () => {
    const s = allDone();
    s.decided('land');
    s.checked(false);
    s.retrying(2, 1, 1, 'the landing check failed');
    assert.equal(s.view().state, 'queued');
    s.started(1, { pid: process.pid });
    const v = s.view();
    assert.equal(v.state, 'running');
    assert.equal(v.currentStep, 1);
    expect(s, 'running');
  });

  test('a step started after a failure is running, not failed', () => {
    const s = feature();
    s.started(1);
    s.failed(1);
    s.started(1, { pid: process.pid });
    assert.equal(s.view().state, 'running');
    expect(s, 'running');
  });
});

describe('rule 6: running', () => {
  test('a started step with nothing after it is running; alive comes from the pid', () => {
    const s = feature();
    s.placed(1);
    s.started(1, { pid: process.pid, model: 'm-1', effort: 'medium', provider: 'p-1' });
    s.sessionEvent(1, 'Bash', 'npm test');
    const v = s.view();
    assert.equal(v.state, 'running');
    assert.equal(v.alive, true);
    assert.equal(v.currentStep, 1);
    assert.equal(v.steps[0].state, 'running');
    assert.equal(v.steps[0].model, 'm-1');
    assert.equal(v.steps[0].effort, 'medium');
    assert.equal(v.steps[0].provider, 'p-1');
    assert.equal(v.steps[0].pid, process.pid);
    assert.equal(v.next, undefined); // projectTask gives no hint; projectAll adds it
    assert.equal(s.view(() => false).alive, false);
    expect(s, 'running');
  });

  test('the current step is the highest ordinal that started', () => {
    const s = feature();
    s.stepDone(1);
    s.started(2, { duty: 'verify', pid: process.pid });
    const v = s.view();
    assert.equal(v.currentStep, 2);
    assert.deepEqual(v.steps.map((x) => x.state), ['done', 'running', 'pending']);
    expect(s, 'running');
  });
});

describe('rule 7: queued', () => {
  test('a task that was only created is queued; its hint is the worktree', () => {
    const s = new TaskScript(root, { kind: 'bug' });
    const v = s.view();
    assert.equal(v.state, 'queued');
    assert.equal(v.currentStep, null);
    assert.equal(v.workflowResolved, false);
    expect(s, 'queued');
  });

  test('a single task needs no worktree or workflow to be placed', () => {
    const s = new TaskScript(root, { kind: 'single', duty: 'answer' });
    const v = s.view();
    assert.equal(v.state, 'queued');
    assert.equal(v.workflowResolved, true);
    assert.deepEqual(v.steps.map((x) => [x.ordinal, x.duty, x.state]), [[1, 'answer', 'pending']]);
    expect(s, 'queued');
  });

  test('a progress report leaves the task queued for a resume', () => {
    const s = feature();
    s.started(1);
    s.report(1, { status: 'progress', summary: 'half way' });
    const v = s.view();
    assert.equal(v.state, 'queued');
    assert.equal(v.steps[0].state, 'reported-progress');
    expect(s, 'queued');
  });

  test('skipped steps are shown as skipped', () => {
    const s = new TaskScript(root, { kind: 'feature' });
    s.worktree();
    s.workflow([{ ordinal: 1, duty: 'plan' }, { ordinal: 2, duty: 'implement' }], [1]);
    const v = s.view();
    assert.deepEqual(v.steps.map((x) => x.state), ['skipped', 'pending']);
    expect(s, 'queued');
  });
});

describe('retries reset steps', () => {
  test('step.retrying with gotoOrdinal 1 makes that step and every later one pending again', () => {
    const s = feature();
    s.stepDone(1);
    s.started(2, { duty: 'verify' });
    s.report(2, { status: 'done', testsRun: { command: 'npm test', passed: false, summary: '2 failing' } });
    s.retrying(2, 1, 1, 'verify failed');
    let v = s.view();
    assert.equal(v.state, 'queued');
    assert.deepEqual(v.steps.map((x) => x.state), ['pending', 'pending', 'pending']);
    assert.equal(v.currentStep, null);
    s.started(1, { pid: process.pid });
    v = s.view();
    assert.equal(v.state, 'running');
    assert.equal(v.currentStep, 1);
    assert.equal(v.steps[0].starts, 1, 'starts before the reset are not counted');
    assert.deepEqual(v.steps.map((x) => x.state), ['running', 'pending', 'pending']);
    expect(s, 'running');
  });

  test('step.retrying with gotoOrdinal 2 keeps step 1 done', () => {
    const s = feature();
    s.stepDone(1);
    s.started(2, { duty: 'verify' });
    s.report(2, { status: 'done', testsRun: { command: 'npm test', passed: false, summary: 'failing' } });
    s.retrying(2, 2);
    const v = s.view();
    assert.deepEqual(v.steps.map((x) => x.state), ['done', 'pending', 'pending']);
    expect(s, 'queued');
  });

  test('stepView, resetPoints and resetFor agree on which events count', () => {
    const s = feature();
    s.stepDone(1);
    const retry = s.retrying(2, 1);
    s.started(1);
    const { events } = s.info();
    const resets = resetPoints(events);
    assert.deepEqual(resets, [{ seq: retry.seq, from: 1 }]);
    assert.equal(resetFor(resets, 1), retry.seq);
    assert.equal(resetFor(resets, 3), retry.seq);
    const before = stepView(events, 1);
    assert.equal(before.starts, 2);
    const after = stepView(events, 1, resetFor(resets, 1));
    assert.equal(after.starts, 1);
    assert.equal(after.done, null);
    assert.equal(after.state, 'running');
    // A reset that goes back to step 2 does not touch step 1.
    assert.equal(resetFor([{ seq: 999999, from: 2 }], 1), 0);
    expect(s, 'running');
  });

  test('stepView: the last end after a start decides the step; a report without a start is kept as lastReport only', () => {
    const s = feature();
    s.report(1, { status: 'progress' });
    let view = stepView(s.info().events, 1);
    assert.equal(view.state, 'pending');
    assert.equal(view.end, null);
    assert.equal(view.lastReport.data.status, 'progress');
    s.started(1);
    s.report(1, { status: 'blocked' });
    view = stepView(s.info().events, 1);
    assert.equal(view.end.kind, 'step.report');
    assert.equal(view.state, 'reported-blocked');
    expect(s, 'waiting-owner');
    // The coordinator gives up on the blocked step: the failure is the last end and decides.
    s.failed(1);
    view = stepView(s.info().events, 1);
    assert.equal(view.end.kind, 'step.failed');
    assert.equal(view.state, 'failed');
    expect(s, 'failed');
  });
});

describe('a start is ended only by its own session\'s report', () => {
  // Two starts of one step in two sessions: the first worker's report, arriving late, must not end the second start.
  function twoStarts(repo) {
    const s = new TaskScript(repo, { kind: 'feature' });
    s.workflow(FEATURE);
    const add = (kind, session, data) => appendEvent(repo, { kind, task: s.task, step: 1, session, data: { ordinal: 1, ...data } });
    add('step.started', 'session-old', { duty: 'implement', pid: process.pid });
    add('step.failed', 'session-coordinator', { reason: 'given up on' });
    const second = add('step.started', 'session-new', { duty: 'implement', pid: process.pid });
    return { s, add, second };
  }

  test('a report from an older session stays lastReport but does not end the latest start', () => {
    const repo = makeRepo();
    const { s, add, second } = twoStarts(repo);
    const late = add('step.report', 'session-old', { status: 'blocked', summary: 'The first worker, late.' });
    let view = stepView(s.info().events, 1);
    assert.equal(view.started.seq, second.seq);
    assert.equal(view.end, null);
    assert.equal(view.lastReport.seq, late.seq);
    assert.equal(view.state, 'running');
    // The task is running, not waiting on the owner for the old worker's question.
    assert.equal(s.view().state, 'running');
    // Its own session's report ends it.
    const own = add('step.report', 'session-new', { status: 'done' });
    view = stepView(s.info().events, 1);
    assert.equal(view.end.seq, own.seq);
    assert.equal(view.state, 'reported-done');
  });

  test('step.failed, step.lost and step.stopped end the latest start whatever their session', () => {
    for (const [kind, data, state] of [['step.failed', { reason: 'r' }, 'failed'], ['step.lost', { pid: 4242 }, 'lost'], ['step.stopped', { reason: 'r' }, 'stopped']]) {
      const repo = makeRepo();
      const { s, add } = twoStarts(repo);
      const end = add(kind, 'session-someone-else', data);
      const view = stepView(s.info().events, 1);
      assert.equal(view.end.seq, end.seq, kind);
      assert.equal(view.state, state, kind);
    }
  });

  test('status does not mark the newer start lost because of the old session\'s report', () => {
    const repo = makeRepo();
    const s = new TaskScript(repo, { kind: 'single', duty: 'investigate' });
    const add = (kind, session, data) => appendEvent(repo, { kind, task: s.task, step: 1, session, data: { ordinal: 1, ...data } });
    add('step.started', 'session-old', { duty: 'investigate', pid: deadPid() });
    add('step.lost', 'session-old', { pid: 1 });
    add('step.started', 'session-new', { duty: 'investigate', pid: deadPid() });
    add('step.report', 'session-old', { status: 'done' });
    // The new start's pid is gone and nothing of its own session ended it: it is lost, not done.
    const result = projectAll(repo);
    assert.equal(result.lost.length, 1);
    assert.equal(result.lost[0].session, 'session-new');
    assert.equal(result.tasks[0].state, 'failed');
  });
});

describe('lost detection', () => {
  test('status appends step.lost when the pid is dead and nothing ended the step, once', () => {
    const repo = makeRepo();
    const s = new TaskScript(repo, { kind: 'single', duty: 'investigate' });
    const pid = deadPid();
    const start = s.started(1, { pid });
    const first = projectAll(repo);
    assert.equal(first.lost.length, 1);
    const lost = first.lost[0];
    assert.equal(lost.kind, 'step.lost');
    assert.equal(lost.task, s.task);
    assert.equal(lost.step, 1);
    assert.equal(lost.session, start.session);
    assert.deepEqual(lost.data, { ordinal: 1, pid });
    assert.equal(first.tasks.find((t) => t.task === s.task).state, 'failed');
    // The second read finds the step already ended and writes nothing.
    const second = projectAll(repo);
    assert.equal(second.lost.length, 0);
    assert.equal(readLedger(repo).filter((e) => e.kind === 'step.lost').length, 1);
  });

  test('the command line marks the lost step and says so', () => {
    const repo = makeRepo();
    const s = new TaskScript(repo, { kind: 'single', duty: 'investigate', title: 'Lost one' });
    s.started(1, { pid: deadPid() });
    const r = cli(repo, ['status']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Failed:/);
    assert.match(r.stdout, new RegExp(`Marked lost: ${s.task} step 1 \\(#3\\)`));
    assert.deepEqual(readLedger(repo).map((e) => e.kind), ['task.created', 'step.started', 'step.lost']);
  });

  test('no step.lost when a report arrived after the start, even though the pid is dead', () => {
    const repo = makeRepo();
    const s = new TaskScript(repo, { kind: 'feature' });
    s.workflow(FEATURE);
    s.started(1, { pid: deadPid() });
    s.report(1, { status: 'progress' });
    const result = projectAll(repo);
    assert.equal(result.lost.length, 0);
    assert.equal(readLedger(repo).some((e) => e.kind === 'step.lost'), false);
  });

  test('no step.lost while the pid is alive', () => {
    const repo = makeRepo();
    const holder = livePid();
    try {
      const s = new TaskScript(repo, { kind: 'single', duty: 'investigate' });
      s.started(1, { pid: holder.pid });
      const result = projectAll(repo);
      assert.equal(result.lost.length, 0);
      const task = result.tasks.find((t) => t.task === s.task);
      assert.equal(task.state, 'running');
      assert.equal(task.alive, true);
      assert.equal(task.next, 'wait for the step report');
    } finally {
      holder.stop();
    }
  });

  test('no step.lost for a start without a pid, and none when markLost is off', () => {
    const repo = makeRepo();
    const a = new TaskScript(repo, { kind: 'single', duty: 'investigate' });
    a.started(1);
    const b = new TaskScript(repo, { kind: 'single', duty: 'investigate' });
    b.started(1, { pid: deadPid() });
    const off = projectAll(repo, { markLost: false });
    assert.equal(off.lost.length, 0);
    assert.equal(off.tasks.find((t) => t.task === b.task).alive, false);
    const on = projectAll(repo);
    assert.deepEqual(on.lost.map((e) => e.task), [b.task]);
  });

  test('a report that lands between the read and the append wins: the re-check under the lock writes nothing', () => {
    const repo = makeRepo();
    const s = new TaskScript(repo, { kind: 'single', duty: 'investigate' });
    const pid = deadPid();
    s.started(1, { pid });
    let calls = 0;
    // The first liveness check happens outside the lock; the report arrives right then.
    const alive = () => {
      calls += 1;
      if (calls === 1) s.report(1, { status: 'done' });
      return false;
    };
    const result = projectAll(repo, { alive });
    assert.equal(result.lost.length, 0);
    assert.deepEqual(readLedger(repo).map((e) => e.kind), ['task.created', 'step.started', 'step.report']);
  });

  test('a step started again after a reset is judged by its new start', () => {
    const repo = makeRepo();
    const s = new TaskScript(repo, { kind: 'feature' });
    s.workflow(FEATURE);
    s.started(1, { pid: process.pid });
    s.report(1, { status: 'done' });
    s.done(1);
    s.retrying(1, 1);
    s.started(1, { pid: deadPid() });
    const result = projectAll(repo);
    assert.equal(result.lost.length, 1);
    assert.equal(result.tasks[0].state, 'failed');
  });
});

describe('the command line agrees', () => {
  test('ledger.mjs status --json gives every scripted task the state the library gives it', () => {
    assert.ok(expected.size >= 30, `only ${expected.size} scenarios`);
    const r = cli(root, ['status', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const view = r.json();
    const got = new Map();
    for (const task of view.tasks) got.set(task.task, task.state);
    for (const task of view.recent) got.set(task.task, task.state);
    for (const [task, state] of expected) assert.equal(got.get(task), state, `${task}`);
    assert.deepEqual(view.lost, []);
    // Open tasks only, waiting-owner first and queued last.
    const order = ['waiting-owner', 'running', 'landing', 'failed', 'queued'];
    const ranks = view.tasks.map((t) => order.indexOf(t.state));
    assert.ok(ranks.every((rank) => rank >= 0));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    // The library sees the same.
    const library = new Map([...groupByTask(readEvents(root).events)].map(([id, info]) => [id, projectTask(info).state]));
    for (const [task, state] of expected) assert.equal(library.get(task), state, `${task} (library)`);
  });
});
