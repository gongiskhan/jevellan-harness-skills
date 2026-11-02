// The ledger's command line, driven as a child process from the project folder the way a session runs it: task
// create, the hand-appended kinds and their guards, status, show, report and wait.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { TaskScript, cli, cliAsync, deadPid, makeRepo, readLedger, sleep, tempDir } from './helpers/ledger-fixture.mjs';
import { appendEvent } from '../skills/jevellan-ledger/scripts/lib/ledger.mjs';
import { isTaskId } from '../skills/jevellan-ledger/scripts/lib/ids.mjs';

const create = (root, args, options) => cli(root, ['task', 'create', ...args, '--json'], options);

describe('task create', () => {
  test('writes task.created only, with the brief, and prints the new id', () => {
    const root = makeRepo();
    const r = create(root, ['--kind', 'feature', '--title', '  Add a   How to run section  ', '--text', 'What, why, where.\n\n'], { env: { JH_SESSION: 'coord-1' } });
    assert.equal(r.status, 0, r.stderr);
    const out = r.json();
    assert.ok(isTaskId(out.task), out.task);
    assert.equal(out.existing, false);
    assert.equal(out.seq, 1);
    const events = readLedger(root);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.created');
    assert.equal(events[0].task, out.task);
    assert.equal(events[0].session, 'coord-1');
    assert.deepEqual(events[0].data, { kind: 'feature', title: 'Add a How to run section', text: 'What, why, where.', parent: null, after: null, origin: 'owner' });
    const text = cli(root, ['task', 'create', '--kind', 'single', '--duty', 'answer', '--title', 'Question', '--text', 'Why?']);
    assert.equal(text.status, 0);
    assert.match(text.stdout, /^Created T[0-9A-Z]{6} \(single answer\): Question\n$/);
  });

  test('a single task carries its duty; parent, after and origin are recorded', () => {
    const root = makeRepo();
    const parent = create(root, ['--kind', 'feature', '--title', 'Parent', '--text', 'p']).json().task;
    const r = create(root, ['--kind', 'single', '--duty', 'investigate', '--title', 'Child', '--text', 'c', '--parent', parent, '--after', parent, '--origin', 'coordinator']);
    assert.equal(r.status, 0, r.stderr);
    const event = readLedger(root).find((e) => e.task === r.json().task);
    assert.deepEqual(event.data, { kind: 'single', title: 'Child', text: 'c', parent, after: parent, origin: 'coordinator', duty: 'investigate' });
  });

  test('--text-file reads the brief from a file and from stdin', () => {
    const root = makeRepo();
    const file = path.join(tempDir('jh-brief-'), 'brief.md');
    fs.writeFileSync(file, 'Line one\r\nLine two\r\n\r\n');
    const fromFile = create(root, ['--kind', 'bug', '--title', 'From a file', '--text-file', file]);
    assert.equal(fromFile.status, 0, fromFile.stderr);
    const fromStdin = create(root, ['--kind', 'automation', '--title', 'From stdin', '--text-file', '-'], { input: 'Piped brief\nsecond line\n' });
    assert.equal(fromStdin.status, 0, fromStdin.stderr);
    const [a, b] = readLedger(root);
    assert.equal(a.data.text, 'Line one\nLine two');
    assert.equal(b.data.text, 'Piped brief\nsecond line');
  });

  const refusals = [
    [['--kind', 'epic', '--title', 't', '--text', 'x'], 2, /--kind must be one of feature, bug, automation, single/],
    [['--title', 't', '--text', 'x'], 2, /--kind must be one of/],
    [['--kind', 'single', '--title', 't', '--text', 'x'], 2, /a single task needs --duty, one of answer, converse/],
    [['--kind', 'single', '--duty', 'dance', '--title', 't', '--text', 'x'], 2, /a single task needs --duty/],
    [['--kind', 'feature', '--duty', 'implement', '--title', 't', '--text', 'x'], 2, /--duty is only for --kind single/],
    [['--kind', 'bug', '--duty', 'verify', '--title', 't', '--text', 'x'], 2, /--duty is only for --kind single/],
    [['--kind', 'feature', '--text', 'x'], 2, /--title is required/],
    [['--kind', 'feature', '--title', '   ', '--text', 'x'], 2, /--title is required/],
    [['--kind', 'feature', '--title', 'x'.repeat(201), '--text', 'x'], 2, /--title must be at most 200 characters/],
    [['--kind', 'feature', '--title', 't'], 2, /the task needs a brief/],
    [['--kind', 'feature', '--title', 't', '--text', '  \n '], 2, /the brief is empty/],
    [['--kind', 'feature', '--title', 't', '--text', 'x', '--text-file', '-'], 2, /give --text or --text-file, not both/],
    [['--kind', 'feature', '--title', 't', '--text-file', '/nonexistent/brief.md'], 2, /cannot read --text-file: ENOENT/],
    [['--kind', 'feature', '--title', 't', '--text', 'x', '--origin', 'robot'], 2, /--origin must be owner or coordinator/],
    [['--kind', 'feature', '--title', 't', '--text', 'x', '--parent', 'nope'], 2, /"nope" is not a task id/],
    [['--kind', 'feature', '--title', 't', '--text', 'x', '--after', 'T000000'], 3, /no task T000000 in this project's ledger/],
    [['--kind', 'feature', '--title', 't', '--text', 'x', '--colour', 'blue'], 2, /Unknown option '--colour'/],
    [['--kind', 'feature', '--title', 't', '--text', 'x', 'extra'], 2, /positional/i],
  ];
  for (const [args, code, pattern] of refusals) {
    test(`refuses ${args.filter((a) => a.startsWith('--')).join(' ')} (${pattern.source.slice(0, 40)})`, () => {
      const root = makeRepo();
      const r = cli(root, ['task', 'create', ...args]);
      assert.equal(r.status, code, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, pattern);
      assert.deepEqual(readLedger(root), []);
    });
  }

  test('a refusal with --json prints the error as JSON', () => {
    const root = makeRepo();
    const r = create(root, ['--kind', 'epic', '--title', 't', '--text', 'x']);
    assert.equal(r.status, 2);
    assert.deepEqual(Object.keys(r.json()), ['error', 'exitCode']);
    assert.equal(r.json().exitCode, 2);
  });

  test('the same open task created twice is one task; a different brief or a finished task makes a new one', () => {
    const root = makeRepo();
    const args = ['--kind', 'feature', '--title', 'README how to run', '--text', 'List the commands.'];
    const first = create(root, args).json();
    const again = create(root, args);
    assert.equal(again.status, 0);
    assert.deepEqual(again.json(), { task: first.task, kind: 'feature', title: 'README how to run', state: 'queued', existing: true });
    const text = cli(root, ['task', 'create', ...args]);
    assert.equal(text.stdout, `${first.task} already exists (queued): README how to run\n`);
    assert.equal(readLedger(root).length, 1);
    // A different brief is a different task.
    const other = create(root, ['--kind', 'feature', '--title', 'README how to run', '--text', 'Something else.']).json();
    assert.notEqual(other.task, first.task);
    // Once the first task landed, the same request is new work.
    appendEvent(root, { kind: 'task.landed', task: first.task, data: { commit: 'abc' } });
    const after = create(root, args).json();
    assert.equal(after.existing, false);
    assert.notEqual(after.task, first.task);
  });

  test('outside a git repository the command refuses', () => {
    const r = cli(tempDir('jh-nogit-'), ['task', 'create', '--kind', 'feature', '--title', 't', '--text', 'x']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not inside a git repository/);
  });

  test('JH_PROJECT points the command at another project', () => {
    const root = makeRepo();
    const elsewhere = tempDir('jh-elsewhere-');
    const r = cli(root, ['append', 'note', '--data', '{"text":"from elsewhere"}'], { cwd: elsewhere, env: { JH_PROJECT: root } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readLedger(root)[0].data.text, 'from elsewhere');
  });
});

describe('append', () => {
  test('note without a task, and with one', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const r = cli(root, ['append', 'note', '--data', '{"text":"prefer small commits"}', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().kind, 'note');
    assert.equal(r.json().task, undefined);
    const withTask = cli(root, ['append', 'note', '--task', s.task, '--data', '{"text":"about this task"}']);
    assert.equal(withTask.status, 0, withTask.stderr);
    assert.match(withTask.stdout, new RegExp(`^#3 \\d\\d:\\d\\d:\\d\\d note ${s.task} about this task`));
  });

  const scriptKinds = ['task.created', 'task.worktree', 'task.placed', 'step.started', 'step.report', 'step.lost', 'step.stopped', 'session.event', 'session.started', 'session.ended', 'landing.decided', 'landing.checked', 'task.landed', 'task.asked'];
  test(`refuses the ${scriptKinds.length} kinds that scripts and hooks own`, () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    for (const kind of scriptKinds) {
      const r = cli(root, ['append', kind, '--task', s.task, '--step', '1', '--data', '{"status":"done","summary":"x"}']);
      assert.equal(r.status, 2, kind);
      assert.match(r.stderr, new RegExp(`${kind.replace('.', '\\.')} is written by the skills' scripts and hooks, not by hand`));
    }
    assert.equal(readLedger(root).length, 1);
  });

  const bad = [
    [['note'], /note: data\.text is required/],
    [['note', '--data', 'not json'], /--data is not JSON/],
    [['note', '--data', '[1,2]'], /--data must be a JSON object/],
    [['note', '--data', '{"text":"x"}', '--step', '0'], /--step must be a positive integer/],
    [['step.message', '--data', '{"direction":"owner","text":"hi"}'], /step\.message needs --task/],
    [['step.message', '--task', '@T', '--step', '1', '--data', '{"direction":"robot","text":"hi"}'], /data\.direction must be owner or coordinator/],
    [['step.message', '--task', '@T', '--step', '1', '--data', '{"direction":"owner"}'], /data\.text is required/],
    [['step.message', '--task', '@T', '--data', '{"direction":"owner","text":"hi"}'], /--step is required/],
    [['step.failed', '--task', '@T', '--step', '1', '--data', '{}'], /data\.reason is required/],
    [['step.done', '--task', '@T'], /--step is required/],
    [['step.retrying', '--task', '@T', '--step', '2', '--data', '{"gotoOrdinal":1,"reason":"r"}'], /data\.attempt must be a positive integer/],
    [['step.retrying', '--task', '@T', '--step', '2', '--data', '{"attempt":1,"reason":"r"}'], /data\.gotoOrdinal must be a positive integer/],
    [['step.retrying', '--task', '@T', '--step', '2', '--data', '{"attempt":1,"gotoOrdinal":1}'], /data\.reason is required/],
    [['step.done', '--task', 'nope', '--step', '1'], /"nope" is not a task id/],
  ];
  for (const [args, pattern] of bad) {
    test(`refuses ${args[0]} with ${pattern.source}`, () => {
      const root = makeRepo();
      const s = new TaskScript(root);
      const r = cli(root, ['append', ...args.map((a) => (a === '@T' ? s.task : a))]);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, pattern);
      assert.equal(readLedger(root).length, 1);
    });
  }

  test('a task that is not in the ledger is not found (exit 3)', () => {
    const root = makeRepo();
    const r = cli(root, ['append', 'step.failed', '--task', 'T000000', '--step', '1', '--data', '{"reason":"x"}']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /no task T000000/);
  });

  test('step.message and step.failed are recorded with the ordinal', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.started(1);
    assert.equal(cli(root, ['append', 'step.message', '--task', s.task, '--step', '1', '--data', '{"direction":"coordinator","text":"Continue."}']).status, 0);
    const failed = cli(root, ['append', 'step.failed', '--task', s.task, '--step', '1', '--data', '{"reason":"crashed"}', '--json']);
    assert.equal(failed.status, 0, failed.stderr);
    assert.deepEqual(failed.json().data, { reason: 'crashed', ordinal: 1 });
  });
});

describe('step.done guard', () => {
  function started(root) {
    const s = new TaskScript(root);
    s.workflow([{ ordinal: 1, duty: 'implement' }, { ordinal: 2, duty: 'verify' }]);
    s.started(1);
    return s;
  }
  const done = (root, s, extra = []) => cli(root, ['append', 'step.done', '--task', s.task, '--step', '1', ...extra]);

  test('refused while the step has no report since it last started', () => {
    const root = makeRepo();
    const s = started(root);
    const r = done(root, s);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /step 1 has no report since it last started; wait for it/);
  });

  test('refused when the report is not done', () => {
    const root = makeRepo();
    const s = started(root);
    s.report(1, { status: 'progress' });
    const r = done(root, s);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /step 1 reported progress, not done/);
  });

  test('refused when the done report says testsRun.passed false', () => {
    const root = makeRepo();
    const s = started(root);
    s.report(1, { status: 'done', testsRun: { command: 'npm test', passed: false, summary: '1 failing' } });
    const r = done(root, s);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /step 1 reported failing tests \(npm test\); apply the workflow's retry rule instead/);
  });

  test('accepted after a done report, refused a second time', () => {
    const root = makeRepo();
    const s = started(root);
    s.report(1, { status: 'done', testsRun: { command: 'npm test', passed: true, summary: 'ok' } });
    const r = done(root, s, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().kind, 'step.done');
    assert.deepEqual(r.json().data, { ordinal: 1 });
    const again = done(root, s);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /step 1 is already done/);
  });

  test('a done report from before the latest start does not count', () => {
    const root = makeRepo();
    const s = started(root);
    s.report(1, { status: 'done' });
    s.started(1);
    const r = done(root, s);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no report since it last started/);
  });

  test('--force records it anyway, marked forced', () => {
    const root = makeRepo();
    const s = started(root);
    const r = done(root, s, ['--force', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json().data, { ordinal: 1, forced: true });
  });
});

describe('step.retrying guard', () => {
  function verifyFailed(root) {
    const s = new TaskScript(root);
    s.workflow([{ ordinal: 1, duty: 'implement' }, { ordinal: 2, duty: 'verify', onFail: { goto: 1, maxLoops: 2 } }]);
    s.stepDone(1);
    s.started(2, { duty: 'verify' });
    s.report(2, { status: 'done', testsRun: { command: 'npm test', passed: false, summary: 'failing' } });
    return s;
  }
  const retry = (root, s, attempt, gotoOrdinal, extra = []) => cli(root, ['append', 'step.retrying', '--task', s.task, '--step', '2', '--data', JSON.stringify({ attempt, gotoOrdinal, reason: 'verify failed' }), ...extra]);

  test('accepted up to maxLoops, refused beyond it, and --force goes past it', () => {
    const root = makeRepo();
    const s = verifyFailed(root);
    const first = retry(root, s, 1, 1, ['--json']);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.json().data, { attempt: 1, gotoOrdinal: 1, reason: 'verify failed', ordinal: 2 });
    assert.equal(retry(root, s, 2, 1).status, 0);
    const third = retry(root, s, 3, 1);
    assert.equal(third.status, 2);
    assert.match(third.stderr, /step 2 already retried 2 of 2 times; tell the owner/);
    assert.equal(retry(root, s, 3, 1, ['--force']).status, 0);
    assert.equal(readLedger(root).filter((e) => e.kind === 'step.retrying').length, 3);
  });

  test('refused when gotoOrdinal is not the step onFail names', () => {
    const root = makeRepo();
    const s = verifyFailed(root);
    const r = retry(root, s, 1, 2);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /step 2's onFail goes back to step 1, not 2/);
  });

  test('a step without onFail may go back anywhere', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.workflow([{ ordinal: 1, duty: 'implement' }]);
    const r = cli(root, ['append', 'step.retrying', '--task', s.task, '--step', '1', '--data', '{"attempt":1,"gotoOrdinal":1,"reason":"lost"}']);
    assert.equal(r.status, 0, r.stderr);
  });
});

describe('task.workflow', () => {
  const steps = [
    { ordinal: 1, duty: 'plan', instructions: 'Plan it.', when: 'needs_plan', onFail: null },
    { ordinal: 2, duty: 'implement', instructions: 'Build it.' },
    { ordinal: 3, duty: 'verify', instructions: 'Check it.', onFail: { goto: 2, maxLoops: 2 } },
  ];
  const workflow = (root, task, data, extra = []) => cli(root, ['append', 'task.workflow', '--task', task, '--data', JSON.stringify(data), ...extra]);

  const shapes = [
    [{ steps: [] }, /data\.steps must be a non-empty list/],
    [{}, /data\.steps must be a non-empty list/],
    [{ steps: [{ ordinal: 1, duty: 'plan', instructions: 'a' }, { ordinal: 1, duty: 'verify', instructions: 'b' }] }, /every step needs a unique positive ordinal/],
    [{ steps: [{ ordinal: 0, duty: 'plan', instructions: 'a' }] }, /every step needs a unique positive ordinal/],
    [{ steps: [{ ordinal: 1, duty: 'review', instructions: 'a' }] }, /step 1: duty must be one of answer/],
    [{ steps: [{ ordinal: 1, duty: 'plan' }] }, /step 1: instructions must be a text/],
    [{ steps: [{ ordinal: 1, duty: 'plan', instructions: 'a', onFail: { goto: 1 } }] }, /step 1: onFail needs goto and maxLoops/],
    [{ steps: [{ ordinal: 1, duty: 'plan', instructions: 'a' }], skipped: [2] }, /skipped step 2 is not in steps/],
    [{ steps: [{ ordinal: 1, duty: 'plan', instructions: 'a' }], skipped: 1 }, /data\.skipped must be a list of ordinals/],
  ];
  for (const [data, pattern] of shapes) {
    test(`refuses ${JSON.stringify(data).slice(0, 70)}`, () => {
      const root = makeRepo();
      const s = new TaskScript(root);
      const r = workflow(root, s.task, data);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, pattern);
      assert.equal(readLedger(root).length, 1);
    });
  }

  test('a single task may only extend its one step (the extra verify step of verify-then-land)', () => {
    const root = makeRepo();
    const s = new TaskScript(root, { kind: 'single', duty: 'answer' });
    const r = workflow(root, s.task, { steps: [steps[1]] });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /keeps step 1 as its answer step/);
  });

  test('accepted once; a second workflow is refused without --force and replaces the first with it', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const data = { steps, skipped: [1], questions: { needs_plan: false, needs_docs: false } };
    const first = workflow(root, s.task, data, ['--json']);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.json().data, data);
    const second = workflow(root, s.task, { steps: [steps[1]] });
    assert.equal(second.status, 2);
    assert.match(second.stderr, /the task already has a workflow; append with --force to replace it/);
    const forced = workflow(root, s.task, { steps: [steps[1]] }, ['--force']);
    assert.equal(forced.status, 0, forced.stderr);
    const shown = cli(root, ['show', s.task, '--json']).json();
    assert.deepEqual(shown.steps.map((x) => x.ordinal), [2]);
  });
});

describe('status', () => {
  function mixed(root) {
    const waiting = new TaskScript(root, { kind: 'single', duty: 'investigate', title: 'Pick a colour' });
    waiting.started(1);
    waiting.report(1, { status: 'needs-decision', question: 'Blue or Green?', options: [{ label: 'Blue' }, { label: 'Green' }] });
    const running = new TaskScript(root, { kind: 'single', duty: 'investigate', title: 'Look around' });
    running.started(1, { pid: process.pid, model: 'test-model', effort: 'high', provider: 'test-provider' });
    const landing = new TaskScript(root, { title: 'Ready to land' });
    landing.worktree();
    landing.workflow([{ ordinal: 1, duty: 'implement' }]);
    landing.stepDone(1);
    landing.decided('land', 'small change');
    const failed = new TaskScript(root, { kind: 'bug', title: 'Broke' });
    failed.started(1);
    failed.failed(1, 'worker crashed');
    const queued = new TaskScript(root, { kind: 'automation', title: 'Not started' });
    const done = new TaskScript(root, { kind: 'single', duty: 'answer', title: 'Answered' });
    done.started(1);
    done.report(1, { status: 'done' });
    return { waiting, running, landing, failed, queued, done };
  }

  test('groups open tasks, waiting on the owner first, and lists what finished today', () => {
    const root = makeRepo();
    const t = mixed(root);
    const r = cli(root, ['status']);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    const headings = ['Waiting on the owner:', 'Running:', 'Landing:', 'Failed:', 'Queued:', 'Finished in the last 24 hours:'];
    const at = headings.map((h) => out.indexOf(h));
    assert.ok(at.every((i) => i >= 0), out);
    assert.deepEqual(at, [...at].sort((a, b) => a - b));
    const under = (heading, next) => out.slice(out.indexOf(heading), next ? out.indexOf(next) : undefined);
    assert.match(under('Waiting on the owner:', 'Running:'), new RegExp(`${t.waiting.task}  Pick a colour[\\s\\S]*needs-decision: Blue or Green\\?[\\s\\S]*1\\) Blue  2\\) Green`));
    assert.match(under('Running:', 'Landing:'), new RegExp(`${t.running.task}  Look around \\(single investigate\\) - step 1 investigate on test-model high via test-provider`));
    assert.match(under('Landing:', 'Failed:'), new RegExp(`${t.landing.task}[\\s\\S]*route land: small change`));
    assert.match(under('Failed:', 'Queued:'), new RegExp(`${t.failed.task}[\\s\\S]*worker crashed`));
    assert.match(under('Queued:', 'Finished'), new RegExp(`${t.queued.task}[\\s\\S]*next: make the worktree`));
    assert.match(under('Finished in the last 24 hours:'), new RegExp(`${t.done.task}  Answered \\(done\\)`));
    const json = cli(root, ['status', '--json']).json();
    assert.deepEqual(json.tasks.map((x) => x.task), [t.waiting.task, t.running.task, t.landing.task, t.failed.task, t.queued.task]);
    assert.deepEqual(json.recent.map((x) => x.task), [t.done.task]);
  });

  test('an empty project has no open tasks', () => {
    const root = makeRepo();
    const r = cli(root, ['status']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'No open tasks.\n');
    const brief = cli(root, ['status', '--brief']);
    assert.equal(brief.status, 0);
    assert.equal(brief.stdout, '');
  });

  test('--brief prints at most five lines', () => {
    const root = makeRepo();
    mixed(root);
    const few = cli(root, ['status', '--brief']).stdout.trimEnd().split('\n');
    assert.equal(few.length, 5);
    assert.match(few[0], /^T[0-9A-Z]{6} waiting-owner: Pick a colour - step 1 investigate on test-model low via test-provider \| Blue or Green\? 1\) Blue {2}2\) Green \(next: answer the step or ask the owner\)$/);
    for (let i = 0; i < 4; i += 1) new TaskScript(root, { kind: 'bug', title: `Extra ${i}` });
    const r = cli(root, ['status', '--brief']);
    assert.equal(r.status, 0);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 5);
    assert.equal(lines[4], 'and 5 more (ledger.mjs status)');
    assert.ok(lines.every((line) => line.length <= 400));
    const json = cli(root, ['status', '--brief', '--json']).json();
    assert.equal(json.tasks.length, 5);
  });
});

describe('show and report', () => {
  function reported(root) {
    const s = new TaskScript(root, { kind: 'single', duty: 'investigate', title: 'Where is the config', text: 'Find the config loader.' });
    s.placed(1);
    s.started(1);
    s.report(1, { status: 'done', summary: 'It is in src/config.js.', changedFiles: [], testsRun: { command: 'npm test', passed: true, summary: '34 passed' }, reportFile: '/p/.jevellan/reports/x.json' });
    return s;
  }

  test('show prints the brief and the events, the report rendered', () => {
    const root = makeRepo();
    const s = reported(root);
    const r = cli(root, ['show', s.task]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^${s.task} Where is the config\\nkind single investigate, state done\\n\\nBrief:\\nFind the config loader\\.\\n\\nEvents:\\n`));
    assert.match(r.stdout, /#1 \d\d:\d\d:\d\d task\.created T[0-9A-Z]{6} single investigate: Where is the config/);
    assert.match(r.stdout, /task\.placed .* step 1: test-model low via test-provider/);
    assert.match(r.stdout, /step\.report s1\n {4}Report of T[0-9A-Z]{6} step 1 \(#4, .*\): done\n {4}It is in src\/config\.js\.\n {4}Tests: npm test -> passed\. 34 passed\n {4}Report file: \/p\/\.jevellan\/reports\/x\.json/);
    const json = cli(root, ['show', s.task, '--json']).json();
    assert.equal(json.state, 'done');
    assert.equal(json.text, 'Find the config loader.');
    assert.deepEqual(json.events.map((e) => e.kind), ['task.created', 'task.placed', 'step.started', 'step.report']);
  });

  test('show refuses a bad id (2) and does not find an unknown one (3)', () => {
    const root = makeRepo();
    assert.equal(cli(root, ['show', 'nope']).status, 2);
    const r = cli(root, ['show', 'T000000']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /no task T000000 in this project's ledger/);
  });

  test('report prints the latest report as JSON, for the task or one step', () => {
    const root = makeRepo();
    const s = reported(root);
    s.started(2, { duty: 'verify' });
    s.report(2, { status: 'progress', summary: 'Half way.' });
    const latest = cli(root, ['report', s.task]);
    assert.equal(latest.status, 0, latest.stderr);
    const out = latest.json();
    assert.equal(out.step, 2);
    assert.equal(out.status, 'progress');
    assert.equal(out.summary, 'Half way.');
    assert.equal(out.task, s.task);
    const first = cli(root, ['report', s.task, '--step', '1', '--json']).json();
    assert.equal(first.step, 1);
    assert.equal(first.summary, 'It is in src/config.js.');
    assert.deepEqual(first.testsRun, { command: 'npm test', passed: true, summary: '34 passed' });
  });

  test('report exits 3 when there is no report yet', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.started(1);
    const r = cli(root, ['report', s.task]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, new RegExp(`no report for ${s.task} yet`));
    const step = cli(root, ['report', s.task, '--step', '2']);
    assert.equal(step.status, 3);
    assert.match(step.stderr, new RegExp(`no report for ${s.task} step 2 yet`));
    assert.equal(cli(root, ['report', 'T000000']).status, 3);
  });
});

describe('wait', () => {
  // wait polls every 500 ms, so how soon it returns depends on where the append falls in its poll period. Four
  // waits run at once and their reports are appended 1 s after the start plus 0, 125, 250 and 375 ms, which
  // spreads the appends over the period; every one must return within 600 ms of its line.
  test('returns within 600 ms of a report line', async (t) => {
    const root = makeRepo();
    const offsets = [0, 125, 250, 375];
    const runs = offsets.map(() => {
      const s = new TaskScript(root, { kind: 'single', duty: 'investigate' });
      s.started(1, { pid: process.pid });
      return { s, ...cliAsync(root, ['wait', '--task', s.task, '--step', '1', '--json']) };
    });
    const measured = await Promise.all(runs.map(async ({ s, done }, i) => {
      await sleep(1000 + offsets[i]);
      s.report(1, { status: 'done', summary: `Arrived ${i}.` });
      const appendedAt = performance.now();
      const exit = await done;
      return { i, exit, ms: exit.exitAt - appendedAt };
    }));
    for (const { i, exit, ms } of measured) {
      t.diagnostic(`wait returned ${ms.toFixed(0)} ms after the report line was appended (append at +${1000 + offsets[i]} ms)`);
      assert.equal(exit.status, 0, exit.stderr);
      const out = JSON.parse(exit.stdout);
      assert.equal(out.kind, 'step.report');
      assert.equal(out.status, 'done');
      assert.equal(out.summary, `Arrived ${i}.`);
    }
    const worst = Math.max(...measured.map((m) => m.ms));
    t.diagnostic(`worst: ${worst.toFixed(0)} ms`);
    for (const { ms } of measured) assert.ok(ms < 600, `wait took ${ms.toFixed(0)} ms`);
  });

  test('a report already there returns at once, rendered for people without --json', () => {
    const root = makeRepo();
    const s = new TaskScript(root, { kind: 'single', duty: 'investigate' });
    s.started(1);
    s.report(1, { status: 'needs-decision', summary: 'Pick one.', question: 'Blue or Green?', options: [{ label: 'Blue' }, { label: 'Green' }] });
    const r = cli(root, ['wait', '--task', s.task, '--step', '1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /: needs-decision\nPick one\.\nQuestion: Blue or Green\?\n {2}1\. Blue\n {2}2\. Green/);
    assert.ok(r.ms < 1000, `${r.ms} ms`);
  });

  test('exits 4 when the step fails', async () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.started(1, { pid: process.pid });
    const { done } = cliAsync(root, ['wait', '--task', s.task, '--step', '1', '--json']);
    await sleep(300);
    const failed = cli(root, ['append', 'step.failed', '--task', s.task, '--step', '1', '--data', '{"reason":"the worker crashed"}']);
    assert.equal(failed.status, 0, failed.stderr);
    const exit = await done;
    assert.equal(exit.status, 4, exit.stderr);
    const out = JSON.parse(exit.stdout);
    assert.equal(out.kind, 'step.failed');
    assert.equal(out.reason, 'the worker crashed');
  });

  test('exits 4 and marks the step lost when its process is gone', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.started(1, { pid: deadPid() });
    const r = cli(root, ['wait', '--task', s.task, '--step', '1', '--timeout', '10', '--json']);
    assert.equal(r.status, 4, r.stderr);
    assert.equal(r.json().kind, 'step.lost');
    assert.equal(readLedger(root).filter((e) => e.kind === 'step.lost').length, 1);
  });

  test('exits 4 when the step is stopped', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.started(1, { pid: process.pid });
    s.stopped(1, 'owner');
    const r = cli(root, ['wait', '--task', s.task, '--step', '1']);
    assert.equal(r.status, 4);
    assert.match(r.stdout, /step\.stopped .* step 1 stopped: owner/);
  });

  test('exits 5 on --timeout 1', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.started(1, { pid: process.pid });
    const r = cli(root, ['wait', '--task', s.task, '--step', '1', '--timeout', '1', '--json']);
    assert.equal(r.status, 5, r.stderr);
    assert.deepEqual(r.json(), { timeout: true, task: s.task, step: 1 });
    assert.ok(r.ms >= 1000 && r.ms < 3000, `${r.ms} ms`);
    const text = cli(root, ['wait', '--task', s.task, '--step', '1', '--timeout', '1']);
    assert.equal(text.stdout, `Timed out after 1 s waiting for ${s.task} step 1.\n`);
  });

  test('a report from before the latest start does not end the wait', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.started(1, { pid: process.pid });
    s.report(1, { status: 'progress' });
    s.started(1, { pid: process.pid });
    assert.equal(cli(root, ['wait', '--task', s.task, '--step', '1', '--timeout', '1']).status, 5);
  });

  test('without --step it waits for the current step', async () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.stepDone(1);
    s.started(2, { duty: 'verify', pid: process.pid });
    const { done } = cliAsync(root, ['wait', '--task', s.task, '--json']);
    await sleep(300);
    s.report(2, { status: 'done', summary: 'Verified.' });
    const exit = await done;
    assert.equal(exit.status, 0, exit.stderr);
    assert.equal(JSON.parse(exit.stdout).step, 2);
  });

  test('without --step after a retry back to an earlier step, it waits for that step', async () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.workflow([{ ordinal: 1, duty: 'implement' }, { ordinal: 2, duty: 'verify', onFail: { goto: 1, maxLoops: 2 } }]);
    s.stepDone(1);
    s.started(2, { duty: 'verify' });
    s.report(2, { status: 'done', testsRun: { command: 'npm test', passed: false, summary: 'failing' } });
    s.retrying(2, 1);
    s.started(1, { pid: process.pid });
    const { done } = cliAsync(root, ['wait', '--task', s.task, '--timeout', '5', '--json']);
    await sleep(300);
    s.report(1, { status: 'done', summary: 'Fixed.' });
    const exit = await done;
    assert.equal(exit.status, 0, exit.stdout + exit.stderr);
    const out = JSON.parse(exit.stdout);
    assert.equal(out.step, 1);
    assert.equal(out.summary, 'Fixed.');
  });

  test('refuses without --task (2) and does not find an unknown task (3)', () => {
    const root = makeRepo();
    const none = cli(root, ['wait']);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /wait needs --task T/);
    assert.equal(cli(root, ['wait', '--task', 'T000000', '--timeout', '1']).status, 3);
    assert.equal(cli(root, ['wait', '--task', 'T000000', '--timeout', '0']).status, 2);
  });
});

describe('tail and help', () => {
  test('tail prints the last lines, filtered by task', () => {
    const root = makeRepo();
    const a = new TaskScript(root);
    const b = new TaskScript(root);
    a.note('for a');
    b.note('for b');
    const all = cli(root, ['tail']);
    assert.equal(all.status, 0);
    assert.equal(all.stdout.trimEnd().split('\n').length, 4);
    const onlyA = cli(root, ['tail', '--task', a.task, '--json']);
    const lines = onlyA.stdout.trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((e) => e.kind), ['task.created', 'note']);
    assert.ok(lines.every((e) => e.task === a.task));
  });

  test('no command prints the usage and exits 2; an unknown one is refused', () => {
    const root = makeRepo();
    const none = cli(root, []);
    assert.equal(none.status, 2);
    assert.match(none.stdout, /^ledger\.mjs task create/);
    assert.equal(cli(root, ['help']).status, 0);
    const unknown = cli(root, ['explode']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown command "explode"/);
  });
});
