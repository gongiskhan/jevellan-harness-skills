// The commands the scripts of other skills use, driven as a child process the way such a script runs this skill's
// public script: record (the kinds the skills' scripts own), --if-last-seq on record and append, events, show --json
// with lastSeq and the step views, and take-report (what the Stop hook does, for a runtime without one).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { TaskScript, addWorktree, cli, ledgerText, makeRepo, readLedger, tempDir, writeJson } from './helpers.mjs';

// A kind that looks like an event kind and is not one of the twenty, built at run time so the kind lint (which reads
// every script under skills/) does not take it for one this skill uses.
const NOT_A_KIND = ['step', 'exploded'].join('.');
const HAND_KINDS = ['note', 'step.message', 'task.workflow', 'step.done', 'step.failed', 'step.retrying'];
const RECORD_KINDS = ['task.worktree', 'task.placed', 'step.started', 'step.stopped', 'session.event', 'session.started', 'session.ended', 'landing.decided', 'landing.checked', 'task.landed', 'task.asked'];

const json = (root, args, options) => cli(root, [...args, '--json'], options);
const lastSeqOfTask = (root, task) => json(root, ['show', task]).json().lastSeq;

// The refusal of a --json command: exit code, {"error", "exitCode"} on stdout, the message on stderr.
function refused(r, code, pattern) {
  assert.equal(r.status, code, `exit ${r.status}: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['error', 'exitCode']);
  assert.equal(out.exitCode, code);
  assert.match(out.error, pattern);
  assert.match(r.stderr, pattern);
}

describe('record', () => {
  test('appends a script kind with its task, step, session and data, and prints the line as written', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const data = { ordinal: 1, duty: 'implement', runtime: 'claude', provider: 'p', model: 'm', effort: 'low', cwd: '/w', pid: 4242, nativeSessionId: 'n-1' };
    const r = json(root, ['record', 'step.started', '--task', s.task, '--step', '1', '--session', 'sess-1', '--data-file', '-'], { input: JSON.stringify(data) });
    assert.equal(r.status, 0, r.stderr);
    const out = r.json();
    const line = readLedger(root).at(-1);
    assert.deepEqual(out, line);
    assert.equal(line.kind, 'step.started');
    assert.equal(line.task, s.task);
    assert.equal(line.step, 1);
    assert.equal(line.session, 'sess-1');
    assert.deepEqual(line.data, data);
    assert.equal(line.seq, 2);
  });

  test('a kind without a step is recorded without one; the session comes from JH_SESSION when not given', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const r = json(root, ['record', 'task.placed', '--task', s.task, '--data', '{"step":2,"model":"m"}'], { env: { JH_SESSION: 'coord-7' } });
    assert.equal(r.status, 0, r.stderr);
    const line = readLedger(root).at(-1);
    assert.equal(line.kind, 'task.placed');
    assert.equal('step' in line, false);
    assert.equal(line.session, 'coord-7');
    assert.deepEqual(line.data, { step: 2, model: 'm' });
  });

  test('takes every kind the skills\' scripts own', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    for (const kind of RECORD_KINDS) {
      const r = json(root, ['record', kind, '--task', s.task, '--step', '1', '--data', '{}']);
      assert.equal(r.status, 0, `${kind}: ${r.stderr}`);
    }
    assert.deepEqual(readLedger(root).slice(1).map((e) => e.kind), RECORD_KINDS);
  });

  test('refuses unknown kinds, hand kinds, task.created and step.lost, and writes nothing', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const before = ledgerText(root);
    refused(json(root, ['record', NOT_A_KIND, '--task', s.task, '--step', '1', '--data', '{}']), 2, /unknown event kind "step\.exploded"/);
    for (const kind of HAND_KINDS) {
      refused(json(root, ['record', kind, '--task', s.task, '--step', '1', '--data', '{"text":"x"}']), 2, new RegExp(`^${kind.replace('.', '\\.')} is appended with append, which checks it`));
    }
    refused(json(root, ['record', 'task.created', '--task', s.task, '--data', '{}']), 2, /task\.created is written by task create/);
    refused(json(root, ['record', 'step.lost', '--task', s.task, '--step', '1', '--data', '{}']), 2, /step\.lost is written by this skill alone/);
    refused(json(root, ['record', '--task', s.task, '--data', '{}']), 2, /record takes one event kind/);
    refused(json(root, ['record', 'task.placed', 'task.landed', '--task', s.task, '--data', '{}']), 2, /record takes one event kind/);
    assert.equal(ledgerText(root), before);
  });

  test('refuses a missing --task, a missing --step for the step kinds, and bad data; an unknown task is not found', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const before = ledgerText(root);
    refused(json(root, ['record', 'task.placed', '--data', '{}']), 2, /task\.placed needs --task/);
    for (const kind of ['step.started', 'step.stopped']) {
      refused(json(root, ['record', kind, '--task', s.task, '--data', '{}']), 2, new RegExp(`${kind.replace('.', '\\.')} needs --step`));
    }
    // A report goes through take-report (or the Stop hook), which checks it against the schema.
    refused(json(root, ['record', 'step.report', '--task', s.task, '--step', '1', '--data', '{}']), 2, /step\.report is written by this skill alone/);
    refused(json(root, ['record', 'step.started', '--task', s.task, '--step', '0', '--data', '{}']), 2, /--step must be a positive integer/);
    refused(json(root, ['record', 'task.placed', '--task', s.task, '--data', '[1]']), 2, /--data must be a JSON object/);
    refused(json(root, ['record', 'task.placed', '--task', s.task, '--data', '{nope']), 2, /--data is not JSON/);
    refused(json(root, ['record', 'task.placed', '--task', s.task, '--data', '{}', '--data-file', '-']), 2, /give --data or --data-file, not both/);
    refused(json(root, ['record', 'task.placed', '--task', 'nonsense', '--data', '{}']), 2, /"nonsense" is not a task id/);
    refused(json(root, ['record', 'task.placed', '--task', 'T000000', '--data', '{}']), 3, /no task T000000/);
    assert.equal(ledgerText(root), before);
  });
});

describe('--if-last-seq', () => {
  test('record: the seq show --json printed writes; another task\'s line in between does not matter', () => {
    const root = makeRepo();
    const a = new TaskScript(root);
    const b = new TaskScript(root);
    const seen = lastSeqOfTask(root, a.task);
    assert.equal(seen, a.created.seq);
    b.note('a line of another task');
    new TaskScript(root).note('and one more');
    const r = json(root, ['record', 'task.placed', '--task', a.task, '--data', '{"step":1}', '--if-last-seq', String(seen)]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().task, a.task);
    assert.equal(lastSeqOfTask(root, a.task), r.json().seq);
  });

  test('record: a line of the same task in between refuses with exit 6 and writes nothing', () => {
    const root = makeRepo();
    const a = new TaskScript(root);
    const seen = lastSeqOfTask(root, a.task);
    const moved = a.note('written meanwhile');
    const before = ledgerText(root);
    const r = json(root, ['record', 'task.placed', '--task', a.task, '--data', '{"step":1}', '--if-last-seq', String(seen)]);
    refused(r, 6, new RegExp(`task ${a.task} changed after #${seen} \\(its newest line is #${moved.seq}\\); read it again`));
    assert.equal(ledgerText(root), before);
  });

  test('append: equal seq writes, another task\'s line does not matter, the same task\'s line gives exit 6', () => {
    const root = makeRepo();
    const a = new TaskScript(root);
    const b = new TaskScript(root);
    a.started(1);
    let seen = lastSeqOfTask(root, a.task);
    b.note('elsewhere');
    let r = json(root, ['append', 'step.message', '--task', a.task, '--step', '1', '--data', '{"direction":"owner","text":"go on"}', '--if-last-seq', String(seen)]);
    assert.equal(r.status, 0, r.stderr);
    seen = r.json().seq;
    a.note('meanwhile');
    const before = ledgerText(root);
    r = json(root, ['append', 'note', '--task', a.task, '--data', '{"text":"late"}', '--if-last-seq', String(seen)]);
    refused(r, 6, /changed after/);
    assert.equal(ledgerText(root), before);
  });

  test('append: the hand kind\'s own guard still runs; a changed task is exit 6 before the guard is asked', () => {
    const root = makeRepo();
    const a = new TaskScript(root);
    a.started(1);
    const seen = lastSeqOfTask(root, a.task);
    refused(json(root, ['append', 'step.done', '--task', a.task, '--step', '1', '--if-last-seq', String(seen)]), 2, /no report since it last started/);
    a.note('meanwhile');
    refused(json(root, ['append', 'step.done', '--task', a.task, '--step', '1', '--if-last-seq', String(seen)]), 6, /changed after/);
  });

  test('needs --task and a positive integer', () => {
    const root = makeRepo();
    const a = new TaskScript(root);
    const before = ledgerText(root);
    refused(json(root, ['append', 'note', '--data', '{"text":"x"}', '--if-last-seq', '1']), 2, /--if-last-seq needs --task/);
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      refused(json(root, ['record', 'task.placed', '--task', a.task, '--data', '{}', `--if-last-seq=${bad}`]), 2, /--if-last-seq must be a positive integer/);
    }
    assert.equal(ledgerText(root), before);
  });
});

describe('events', () => {
  test('every line with the ledger\'s lastSeq, narrowed by task, kind and --since', () => {
    const root = makeRepo();
    const a = new TaskScript(root);
    const b = new TaskScript(root);
    const c = new TaskScript(root);
    a.started(1);
    b.note('b note');
    c.note('c note');
    a.report(1);
    const all = readLedger(root);
    const last = all.at(-1).seq;

    let out = json(root, ['events']).json();
    assert.deepEqual(out, { lastSeq: last, events: all });

    out = json(root, ['events', '--task', a.task]).json();
    assert.equal(out.lastSeq, last, 'lastSeq is the whole ledger\'s');
    assert.deepEqual(out.events, all.filter((e) => e.task === a.task));

    out = json(root, ['events', '--task', a.task, '--task', b.task]).json();
    assert.deepEqual(out.events, all.filter((e) => [a.task, b.task].includes(e.task)));

    out = json(root, ['events', '--kind', 'note']).json();
    assert.deepEqual(out.events.map((e) => e.data.text), ['b note', 'c note']);

    out = json(root, ['events', '--kind', 'note', '--kind', 'step.report', '--task', a.task, '--task', c.task]).json();
    assert.deepEqual(out.events.map((e) => [e.task, e.kind]), [[c.task, 'note'], [a.task, 'step.report']]);

    const since = a.created.seq + 2;
    out = json(root, ['events', '--since', String(since)]).json();
    assert.deepEqual(out.events, all.filter((e) => e.seq > since));
    out = json(root, ['events', '--since', String(last)]).json();
    assert.deepEqual(out, { lastSeq: last, events: [] });
  });

  test('an empty project has lastSeq 0; bad filters are refused', () => {
    const root = makeRepo();
    assert.deepEqual(json(root, ['events']).json(), { lastSeq: 0, events: [] });
    refused(json(root, ['events', '--kind', NOT_A_KIND]), 2, /unknown event kind/);
    refused(json(root, ['events', '--task', 'nonsense']), 2, /is not a task id/);
    refused(json(root, ['events', '--since=-1']), 2, /--since must be a seq/);
    refused(json(root, ['events', 'extra']), 2, /Unexpected argument|positional/i);
  });
});

describe('show --json lastSeq and views', () => {
  test('a retry back to step 1 resets both steps\' current views; overall keeps every line', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.worktree();
    s.workflow([{ ordinal: 1, duty: 'implement' }, { ordinal: 2, duty: 'verify', onFail: { goto: 1, maxLoops: 2 } }]);
    const placed1 = s.placed(1);
    const started1 = s.started(1);
    const report1 = s.report(1);
    const done1 = s.done(1);
    const started2 = s.started(2, { duty: 'verify' });
    const report2 = s.report(2, { status: 'blocked', summary: 'tests fail' });
    const retry = s.retrying(2, 1);
    new TaskScript(root).note('another task is newer');

    let out = json(root, ['show', s.task]).json();
    assert.equal(out.lastSeq, retry.seq, 'lastSeq is the task\'s newest line, not the ledger\'s');
    assert.deepEqual(out.views.map((v) => v.ordinal), [1, 2]);
    const [one, two] = out.views;
    assert.equal(one.resetSeq, retry.seq);
    assert.equal(two.resetSeq, retry.seq);
    assert.deepEqual(one.current, { state: 'pending', starts: 0, started: null, end: null, done: null, lastReport: null, placed: null });
    assert.deepEqual(one.overall, { state: 'done', starts: 1, started: started1.seq, end: report1.seq, done: done1.seq, lastReport: report1.seq, placed: placed1.seq });
    assert.deepEqual(two.current, { state: 'pending', starts: 0, started: null, end: null, done: null, lastReport: null, placed: null });
    assert.deepEqual(two.overall, { state: 'reported-blocked', starts: 1, started: started2.seq, end: report2.seq, done: null, lastReport: report2.seq, placed: null });
    // Every seq a view names is one of the task's events in the same output.
    const seqs = new Set(out.events.map((e) => e.seq));
    for (const v of out.views) for (const which of ['current', 'overall']) for (const key of ['started', 'end', 'done', 'lastReport', 'placed']) {
      if (v[which][key] !== null) assert.ok(seqs.has(v[which][key]), `${which}.${key} of step ${v.ordinal}`);
    }

    // Step 1 runs again: its current view counts only the new start, overall counts both.
    const again = s.started(1);
    out = json(root, ['show', s.task]).json();
    assert.equal(out.lastSeq, again.seq);
    assert.deepEqual(out.views[0].current, { state: 'running', starts: 1, started: again.seq, end: null, done: null, lastReport: null, placed: null });
    assert.equal(out.views[0].overall.starts, 2);
    assert.equal(out.views[0].overall.started, again.seq);
    assert.equal(out.views[0].overall.state, 'running');
    // The projection fields are still there.
    assert.equal(out.task, s.task);
    assert.equal(out.currentStep, 1);
    assert.equal(out.text, 'Brief for the scripted task.');
  });

  test('a single task has the view of step 1 before anything ran; a feature task has none until a step is named', () => {
    const root = makeRepo();
    const single = new TaskScript(root, { kind: 'single', duty: 'answer' });
    let out = json(root, ['show', single.task]).json();
    assert.equal(out.lastSeq, single.created.seq);
    assert.deepEqual(out.views, [{ ordinal: 1, resetSeq: 0, current: { state: 'pending', starts: 0, started: null, end: null, done: null, lastReport: null, placed: null }, overall: { state: 'pending', starts: 0, started: null, end: null, done: null, lastReport: null, placed: null } }]);
    const feature = new TaskScript(root);
    out = json(root, ['show', feature.task]).json();
    assert.deepEqual(out.views, []);
  });

  test('the views go up to the highest ordinal a placement, a workflow or a step event names', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const placed = s.placed(5);
    let out = json(root, ['show', s.task]).json();
    assert.deepEqual(out.views.map((v) => v.ordinal), [1, 2, 3, 4, 5]);
    assert.equal(out.views[4].current.placed, placed.seq);
    assert.equal(out.views[0].current.placed, null);
    s.workflow([1, 2, 3, 4, 5, 6, 7].map((ordinal) => ({ ordinal, duty: 'implement' })));
    out = json(root, ['show', s.task]).json();
    assert.equal(out.views.length, 7);
    s.add('session.event', { tool: 'Bash', summary: 'ls' }, 9);
    out = json(root, ['show', s.task]).json();
    assert.deepEqual(out.views.map((v) => v.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('a step named far beyond any workflow gets its own view without every ordinal below it', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.workflow([{ ordinal: 1, duty: 'implement' }, { ordinal: 2, duty: 'verify' }]);
    const far = json(root, ['record', 'step.started', '--task', s.task, '--step', '1000000000', '--data', '{"pid":1}']);
    assert.equal(far.status, 0, far.stderr);
    const start = performance.now();
    const r = json(root, ['show', s.task]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(performance.now() - start < 10000);
    const ordinals = r.json().views.map((v) => v.ordinal);
    assert.equal(ordinals.length, 101);
    assert.deepEqual(ordinals.slice(0, 3), [1, 2, 3]);
    assert.equal(ordinals.at(-2), 100);
    assert.equal(ordinals.at(-1), 1000000000);
    assert.equal(r.json().views.at(-1).current.state, 'running');
  });
});

describe('take-report', () => {
  const reportPath = (dir) => path.join(dir, '.jevellan', 'report.json');
  const takeArgs = (task, cwd, extra = []) => ['take-report', '--task', task, '--step', '1', '--session', 'sess-9', '--cwd', cwd, ...extra];
  const archive = (root) => {
    const dir = path.join(root, '.jevellan', 'reports');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  test('a valid report becomes step.report with reportFile, moves to the reports folder, then session.ended', () => {
    const root = makeRepo();
    const wt = addWorktree(root, 'take-valid');
    const s = new TaskScript(root, { session: 'sess-9' });
    s.started(1, { cwd: wt });
    const body = {
      status: 'done',
      summary: 'Added a How to run section.',
      changedFiles: ['README.md'],
      testsRun: { command: 'npm test', passed: true, summary: '34 passed' },
      screenshots: [{ path: '.jevellan/evidence/readme.png', caption: 'The new section' }],
      limitations: ['none known'],
    };
    writeJson(reportPath(wt), body);
    const r = json(root, takeArgs(s.task, wt, ['--native-session', 'thread-1', '--ended', 'codex exec ended with exit 0']), { cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    const out = r.json();
    const [report, ended] = readLedger(root).slice(-2);
    assert.deepEqual(out, { task: s.task, step: 1, seq: report.seq, status: 'done', synthesized: false, reportFile: report.data.reportFile, sessionEndedSeq: ended.seq, warnings: [] });
    assert.equal(report.kind, 'step.report');
    assert.equal(report.task, s.task);
    assert.equal(report.step, 1);
    assert.equal(report.session, 'sess-9');
    const { reportFile, ...data } = report.data;
    assert.deepEqual(data, { ...body, limitations: 'none known' });
    assert.equal(path.dirname(reportFile), path.join(root, '.jevellan', 'reports'));
    assert.match(path.basename(reportFile), new RegExp(`^${s.task}-s1-\\d{8}T\\d{9}Z\\.json$`));
    assert.deepEqual(JSON.parse(fs.readFileSync(reportFile, 'utf8')), body);
    assert.equal(fs.existsSync(reportPath(wt)), false, 'the report is gone from the step\'s folder');
    assert.equal(ended.kind, 'session.ended');
    assert.equal(ended.task, s.task);
    assert.equal(ended.step, 1);
    assert.equal(ended.session, 'sess-9');
    assert.deepEqual(ended.data, { nativeSessionId: 'thread-1', reason: 'codex exec ended with exit 0 with a done report' });
    assert.equal(s.view().steps[0].state, 'reported-done');
  });

  test('an invalid report is recorded blocked and synthesized with the problem, and archived with -invalid', () => {
    const root = makeRepo();
    const wt = addWorktree(root, 'take-invalid');
    const s = new TaskScript(root, { session: 'sess-9' });
    s.started(1, { cwd: wt });
    writeJson(reportPath(wt), { status: 'needs-decision', summary: 'Which one?', question: 'Blue or Green?', options: [{ label: 'Blue' }] });
    const r = json(root, takeArgs(s.task, wt));
    assert.equal(r.status, 0, r.stderr);
    const out = r.json();
    assert.equal(out.status, 'blocked');
    assert.equal(out.synthesized, true);
    const report = readLedger(root).find((e) => e.kind === 'step.report');
    assert.deepEqual({ ...report.data, reportFile: null }, { status: 'blocked', summary: 'The report was not valid.', limitations: 'report.json: options must have 2 to 4 items', synthesized: true, reportFile: null });
    assert.equal(out.reportFile, report.data.reportFile);
    assert.match(path.basename(report.data.reportFile), new RegExp(`^${s.task}-s1-\\d{8}T\\d{9}Z-invalid\\.json$`));
    assert.deepEqual(JSON.parse(fs.readFileSync(report.data.reportFile, 'utf8')).options, [{ label: 'Blue' }], 'the archive keeps what the worker wrote');
    assert.equal(fs.existsSync(reportPath(wt)), false);
    assert.equal(readLedger(root).at(-1).data.reason, 'the session ended with a blocked report');
  });

  test('a report that is not JSON is recorded blocked with the parse problem', () => {
    const root = makeRepo();
    const wt = addWorktree(root, 'take-not-json');
    const s = new TaskScript(root, { session: 'sess-9' });
    s.started(1, { cwd: wt });
    fs.mkdirSync(path.dirname(reportPath(wt)), { recursive: true });
    fs.writeFileSync(reportPath(wt), '{"status": "done",');
    const r = json(root, takeArgs(s.task, wt));
    assert.equal(r.status, 0, r.stderr);
    const report = readLedger(root).find((e) => e.kind === 'step.report');
    assert.equal(report.data.status, 'blocked');
    assert.equal(report.data.synthesized, true);
    assert.match(report.data.limitations, /^report\.json: is not valid JSON \(/);
    assert.match(report.data.reportFile, /-invalid\.json$/);
    assert.equal(fs.readFileSync(report.data.reportFile, 'utf8'), '{"status": "done",');
  });

  test('no report is recorded blocked and synthesized with the ended text; nothing is archived', () => {
    const root = makeRepo();
    const wt = addWorktree(root, 'take-missing');
    const s = new TaskScript(root, { session: 'sess-9' });
    s.started(1, { cwd: wt });
    let r = json(root, takeArgs(s.task, wt, ['--ended', 'codex exec ended with exit 1']));
    assert.equal(r.status, 0, r.stderr);
    let out = r.json();
    assert.deepEqual({ ...out, seq: 0, sessionEndedSeq: 0 }, { task: s.task, step: 1, seq: 0, status: 'blocked', synthesized: true, reportFile: null, sessionEndedSeq: 0, warnings: [] });
    let [report, ended] = readLedger(root).slice(-2);
    assert.deepEqual(report.data, { status: 'blocked', summary: 'No report was written.', synthesized: true, limitations: 'codex exec ended with exit 1 and no .jevellan/report.json' });
    assert.deepEqual(ended.data, { nativeSessionId: null, reason: 'codex exec ended with exit 1 with a blocked report' });
    assert.deepEqual(archive(root), []);

    // Without --ended (or with an empty one) the text is "the session ended".
    r = json(root, takeArgs(s.task, wt, ['--ended', '  ']));
    assert.equal(r.status, 0, r.stderr);
    [report, ended] = readLedger(root).slice(-2);
    assert.equal(report.data.limitations, 'the session ended and no .jevellan/report.json');
    assert.equal(ended.data.reason, 'the session ended with a blocked report');
    out = r.json();
    assert.equal(out.sessionEndedSeq, ended.seq);
  });

  test('refuses a relative --cwd, a missing --task, --step or --session, and an unknown task; writes nothing', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    writeJson(reportPath(root), { status: 'done', summary: 'Stays put.' });
    const before = ledgerText(root);
    refused(json(root, takeArgs(s.task, '.')), 2, /--cwd must be the step's folder, an absolute path/);
    refused(json(root, takeArgs(s.task, 'relative/dir')), 2, /--cwd must be/);
    refused(json(root, ['take-report', '--step', '1', '--session', 'x', '--cwd', root]), 2, /--task is required/);
    refused(json(root, ['take-report', '--task', s.task, '--session', 'x', '--cwd', root]), 2, /--step must be a positive integer/);
    refused(json(root, ['take-report', '--task', s.task, '--step', '1', '--cwd', root]), 2, /--session is required/);
    refused(json(root, takeArgs('T000000', root)), 3, /no task T000000/);
    assert.equal(ledgerText(root), before);
    assert.equal(fs.existsSync(reportPath(root)), true, 'a refused take-report leaves the report where it was');
  });

  test('a report that cannot be moved after its line is written is named in warnings, and the exit is still 0', () => {
    const root = makeRepo();
    const wt = addWorktree(root, 'take-unmovable');
    const s = new TaskScript(root, { session: 'sess-10' });
    s.started(1, { cwd: wt });
    writeJson(reportPath(wt), { status: 'done', summary: 'Recorded, but stuck in the worktree.' });
    // The worktree's .jevellan cannot lose an entry: the move out of it fails after the line is written.
    const dir = path.dirname(reportPath(wt));
    fs.chmodSync(dir, 0o555);
    try {
      const r = json(root, takeArgs(s.task, wt));
      assert.equal(r.status, 0, r.stderr);
      const out = r.json();
      assert.equal(out.status, 'done');
      assert.equal(out.warnings.length, 1);
      assert.match(out.warnings[0], /^report recorded, but .*report\.json could not be moved to /);
      assert.match(r.stderr, /could not be moved/);
      assert.equal(fs.existsSync(reportPath(wt)), true, 'the report is still where the worker wrote it');
      assert.equal(readLedger(root).at(-1).kind, 'session.ended');
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  test('when the line cannot be written the report stays where the worker wrote it', () => {
    const root = makeRepo();
    const wt = addWorktree(root, 'take-unwritable');
    const s = new TaskScript(root, { session: 'sess-9' });
    s.started(1, { cwd: wt });
    writeJson(reportPath(wt), { status: 'done', summary: 'Kept through a failed append.' });
    // The archive folder cannot be made: a file sits where it goes.
    fs.writeFileSync(path.join(root, '.jevellan', 'reports'), 'not a folder');
    const before = ledgerText(root);
    const r = json(root, takeArgs(s.task, wt));
    assert.notEqual(r.status, 0);
    assert.equal(ledgerText(root), before, 'neither step.report nor session.ended');
    assert.equal(fs.existsSync(reportPath(wt)), true);
    // Once the folder can be made, the same command records it.
    fs.renameSync(path.join(root, '.jevellan', 'reports'), path.join(tempDir('jh-aside-'), 'reports'));
    const again = json(root, takeArgs(s.task, wt));
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.json().status, 'done');
    assert.equal(fs.existsSync(reportPath(wt)), false);
  });
});
