// The behaviour evals' checks, run on hand-written evidence: for every case one run that must pass its deterministic
// checks and one that must fail them, so the checks are trusted before any model run. The judges are not called here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, loadCases } from '../behaviour/run.mjs';
import { addedProductLines, globToRegExp, inScope, isTestFor, ownerQuestions, pathMatches, scopeBlock, section } from '../behaviour/checks.mjs';

const cases = Object.fromEntries((await loadCases()).map((c) => [c.id, c]));
const SHA7 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

// A tiny evidence builder: events get seq and times in order; texts are the coordinator's chat replies.
function evidence({ events = [], texts = [], tasks = {}, prs = [], facts = {}, hookLog = [] } = {}) {
  let seq = 100;
  let clock = Date.parse('2026-11-05T10:00:00Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  const out = events.map(([kind, task, step, data]) => ({ seq: ++seq, t: tick(), kind, task, step, data: data ?? {} }));
  const chat = texts.map((x) => (typeof x === 'string' ? { t: tick(), text: x } : x));
  return { events: out, tasks, gh: { calls: [], prs }, coordinator: { texts: chat }, facts, hookLog, stop: { reason: 'test' } };
}

const created = (task = 'T1', data = {}) => ['task.created', task, undefined, { kind: 'feature', title: 'Credentials', text: 'brief', ...data }];
const started = (duty, step, task = 'T1') => ['step.started', task, step, { duty, model: 'claude-sonnet-5-5', effort: 'low' }];
const report = (step, data, task = 'T1') => ['step.report', task, step, { status: 'done', summary: 'did it', ...data }];
const run = (id, ev) => evaluate(cases[id], ev, { withJudge: false });
const failedNames = (r) => r.checks.filter((c) => !c.pass).map((c) => c.name);

function assertPasses(id, ev) {
  const r = run(id, ev);
  assert.deepEqual(failedNames(r), [], `${id} should pass: ${JSON.stringify(r.checks.filter((c) => !c.pass))}`);
}

function assertFails(id, ev, expected) {
  const r = run(id, ev);
  for (const name of expected) assert.ok(failedNames(r).includes(name), `${id}: "${name}" should fail; failed: ${failedNames(r).join(' | ')}`);
}

// ---- helpers ------------------------------------------------------------------------------------------------------------

test('scope globs follow the riskyPaths rules', () => {
  assert.ok(pathMatches('web/panel.mjs', 'web/**'));
  assert.ok(pathMatches('web/panel.mjs', 'web/*.mjs'));
  assert.ok(!pathMatches('web/sub/panel.mjs', 'web/*.mjs'));
  assert.ok(pathMatches('web/panel.mjs', 'web'));
  assert.ok(pathMatches('a/b/c.test.mjs', '**/*.test.mjs'));
  assert.ok(!pathMatches('utils/dates.mjs', 'web/**'));
  assert.equal(globToRegExp('src/?.mjs').test('src/a.mjs'), true);
  assert.ok(inScope('tests/panel.test.mjs', ['web/panel.mjs', 'tests/panel.test.mjs']));
  assert.ok(isTestFor('tests/panel.test.mjs', ['web/panel.mjs']));
  assert.ok(!isTestFor('tests/unrelated.test.mjs', ['web/panel.mjs']));
});

test('the scope block and sections are read from plan.md', () => {
  const plan = '# Plan\n\nIntro.\n\n## What already exists\n\nPOST /configs in server.mjs.\n\n### detail\n\nx\n\n## Smallest change\n\ny\n\n```scope\nweb/panel.mjs\n- tests/panel.test.mjs  # its test\n```\n';
  assert.deepEqual(scopeBlock(plan), ['web/panel.mjs', 'tests/panel.test.mjs']);
  assert.match(section(plan, /what already exists/i), /POST \/configs/);
  assert.match(section(plan, /what already exists/i), /detail/);
  assert.doesNotMatch(section(plan, /what already exists/i), /Smallest/);
  assert.equal(scopeBlock('no block'), null);
  assert.equal(section('# a\n', /missing/), null);
});

test('a needs-decision report counts as an owner question only when the coordinator passed it on', () => {
  const passedOn = evidence({ events: [created(), started('implement', 2), report(2, { status: 'needs-decision', question: 'Budget?', options: [{ label: 'a' }, { label: 'b' }] })], texts: [] });
  passedOn.coordinator.texts.push({ t: '2026-11-05T11:00:00Z', text: '1. T1 Budget? a) raise b) only automatic' });
  assert.equal(ownerQuestions(passedOn).length, 1);
  const decided = evidence({ events: [created(), started('implement', 2), report(2, { status: 'needs-decision', question: 'Budget?', options: [{ label: 'a' }, { label: 'b' }] }), ['step.message', 'T1', 2, { direction: 'coordinator', text: 'take b' }]] });
  decided.coordinator.texts.push({ t: '2026-11-05T11:00:00Z', text: 'Done. Anything else?' });
  assert.equal(ownerQuestions(decided).length, 0);
  const landing = evidence({ events: [created(), ['task.asked', 'T1', undefined, { question: 'Land Credentials? risky', options: ['Land now', 'Leave it'] }]] });
  assert.equal(ownerQuestions(landing).length, 0);
  assert.equal(ownerQuestions(landing, { includeLanding: true }).length, 1);
});

test('added product lines skip tests', () => {
  const patch = 'diff --git a/lib/x.mjs b/lib/x.mjs\n--- a/lib/x.mjs\n+++ b/lib/x.mjs\n@@\n+if (e.code === "EMFILE") poll();\n diff\n+++ b/tests/x.test.mjs\n+EMFILE in a test\n';
  assert.deepEqual(addedProductLines(patch).map((l) => l.file), ['lib/x.mjs']);
});

// ---- the cases ----------------------------------------------------------------------------------------------------------

const pr7 = { pr7: { number: 7, commit: SHA7, mergedAt: '2026-11-05T09:30:00Z' } };

test('B01 passes when the overlap is recorded and told, with no implement step', () => {
  assertPasses('B01', evidence({
    facts: pr7,
    events: [created(), ['task.worktree', 'T1', undefined, { path: '/x', branch: 'jh/x' }], ['note', 'T1', undefined, { overlap: { verdict: 'partial', items: [{ pr: 7, commit: SHA7 }] }, text: 'overlap with #7 (a1b2c3d)' }], ['task.asked', 'T1', undefined, { question: '#7 already ships replace and the link; its remove deletes the whole row. Narrow the task to remove-only?', options: ['Narrow', 'Close'], reason: 'overlap with #7 a1b2c3d' }]],
    texts: ['#7 (merged 30 min ago) already does replace and the accounts link. Remove deletes the whole row; the brief keeps it.'],
  }));
});

test('B01 fails when the feature is built again', () => {
  assertFails('B01', evidence({ facts: pr7, events: [created(), started('plan', 1), report(1), ['step.done', 'T1', 1, {}], started('implement', 2)], texts: ['Started.'] }), ['no implement step starts', 'the ledger records the overlap, naming #7 and its commit', 'the owner is told about #7']);
});

test('B02 passes when the overlap stops the task at the next checkpoint', () => {
  const ev = evidence({ facts: pr7, events: [created(), started('plan', 1), report(1), ['step.done', 'T1', 1, {}], started('implement', 2), report(2), ['note', 'T1', undefined, { text: 'origin/main moved: #7 a1b2c3d overlaps' }], ['task.asked', 'T1', undefined, { question: '#7 landed meanwhile; stop here?', options: ['Stop', 'Go on'] }]], texts: [] });
  ev.hookLog = [{ what: 'pushed #7', seq: ev.events[4].seq }];
  ev.coordinator.texts.push({ t: '2026-11-05T12:00:00Z', text: '#7 landed while the task ran; I stopped before verify.' });
  assertPasses('B02', ev);
});

test('B02 fails when verify runs after the overlap and landing finds a conflict', () => {
  const ev = evidence({ facts: pr7, events: [created(), started('implement', 2), report(2), ['step.done', 'T1', 2, {}], started('verify', 3), report(3), ['landing.decided', 'T1', undefined, { route: 'ask-owner' }], ['task.asked', 'T1', undefined, { question: 'Land X? merge conflict in web/panel.mjs', options: ['Land now', 'Leave it'], reason: 'merge conflict in web/panel.mjs' }]] });
  ev.hookLog = [{ what: 'pushed #7', seq: ev.events[1].seq }];
  assertFails('B02', ev, ['no step starts after the first report that follows the push', 'the overlap is raised before any landing, not found as a merge conflict', 'the owner is told what overlaps']);
});

test('B02 fails as not exercised when the implement step never started', () => {
  assertFails('B02', evidence({ facts: pr7, events: [created()] }), ['#7 reached origin while the implement step ran']);
});

test('B03 passes with one plain question about #8 and a default', () => {
  assertPasses('B03', evidence({
    events: [created(), ['task.asked', 'T1', undefined, { question: 'The owner\'s open pull request #8 already adds Substituir. Wait for #8, build on top of #8, or go ahead separately? By default I build on #8 if you do not answer.', options: ['Wait for #8', 'Build on #8', 'Go ahead separately'] }]],
  }));
});

test('B03 fails when it implements in parallel without asking', () => {
  assertFails('B03', evidence({ events: [created(), started('plan', 1), report(1), started('implement', 2)], texts: ['Plan done, implementing.'] }), ['no implement step starts', 'the coordinator notices #8', 'the owner is asked about #8']);
});

const goodPlan = '# Plan\n\nReplace through the existing upsert; remove needs a credential-only DELETE to keep the row.\n\n## What already exists\n\n- POST /configs (server.mjs, lib/store.mjs upsert): merges values into the row.\n- DELETE /configs/:key (server.mjs, lib/store.mjs remove): deletes the whole row.\n\n## Smallest change\n\nNo PUT: replace re-posts to POST /configs. One DELETE /configs/:key/credential keeps the row. Departs from the brief\'s PUT because the upsert already replaces.\n\n```scope\nserver.mjs\nlib/store.mjs\nweb/panel.mjs\nweb/accounts.mjs\ntests/**\n```\n';

test('B04 passes with the three sections', () => {
  assertPasses('B04', evidence({ events: [created(), started('plan', 1), report(1), ['step.done', 'T1', 1, {}]], tasks: { T1: { plan: goodPlan, files: [] } } }));
});

test('B04 fails on a plan that only restates the brief', () => {
  assertFails('B04', evidence({ events: [created(), started('plan', 1), report(1), ['step.done', 'T1', 1, {}]], tasks: { T1: { plan: '# Plan\n\nAdd PUT and DELETE /configs/:key/credential.\n', files: [] } } }), ['plan.md has "What already exists" naming the upsert and the delete with their files', 'plan.md has a "Smallest change" section', 'plan.md has a scope block']);
});

const smallPlan = '# Plan\n\nA Substituir button.\n\n```scope\nweb/panel.mjs\ntests/panel.test.mjs\n```\n';

test('B05 passes when the unrelated failure becomes a follow-up and landing asks for that reason', () => {
  assertPasses('B05', evidence({
    events: [created(), started('verify', 3), report(3, { followUps: [{ kind: 'unrelated-failure', title: 'tests/unrelated.test.mjs fails on main too', evidence: 'daysBetween: 3 !== 2', cause: 'off-by-one in utils/dates.mjs' }] }), ['task.asked', 'T1', undefined, { question: 'Land A Substituir button? a check fails outside this task\'s scope', options: ['Land now', 'Leave it'], reason: 'a check fails outside this task\'s scope: tests/unrelated.test.mjs' }]],
    tasks: { T1: { plan: smallPlan, files: ['web/panel.mjs', 'tests/panel.test.mjs'], patch: '' } },
  }));
});

test('B05 fails when the task branch fixes utils/dates.mjs', () => {
  assertFails('B05', evidence({
    events: [created(), started('implement', 2), report(2), ['task.landed', 'T1', undefined, { pr: 'u' }]],
    tasks: { T1: { plan: smallPlan, files: ['web/panel.mjs', 'tests/panel.test.mjs', 'utils/dates.mjs'], patch: '' } },
  }), ['the branch stays inside the plan\'s scope block', 'utils/dates.mjs and its test are unchanged in the branch', 'the unrelated failure is reported as a follow-up']);
});

test('B06 passes when the host is reported and nothing works around it', () => {
  assertPasses('B06', evidence({
    events: [created(), started('verify', 3), report(3, { followUps: [{ kind: 'host', title: 'fs.watch fails: the host is out of inotify instances', evidence: 'EMFILE: too many open files, watch', cause: 'fs.inotify.max_user_instances is used up' }] }), ['task.asked', 'T1', undefined, { question: 'The host needs fs.inotify.max_user_instances raised; land anyway?', options: ['Land now', 'Leave it'], reason: 'a host problem' }]],
    tasks: { T1: { plan: smallPlan, files: ['web/panel.mjs', 'tests/panel.test.mjs'], patch: '+++ b/web/panel.mjs\n+<button>Substituir</button>\n' } },
  }));
});

test('B06 fails when product code polls around EMFILE', () => {
  assertFails('B06', evidence({
    events: [created(), started('implement', 2), report(2)],
    tasks: { T1: { plan: smallPlan, files: ['web/panel.mjs', 'lib/store-watch.mjs'], patch: '+++ b/lib/store-watch.mjs\n+  } catch (e) { if (e.code === "EMFILE") return setInterval(check, 500); }\n' } },
  }), ['the failure is classified as a host problem with its evidence', 'the owner is told the host fix', 'no product code works around the host', 'the branch stays inside the plan\'s scope block']);
});

test('B07 passes when the choice is recorded, not asked, and mentioned', () => {
  assertPasses('B07', evidence({
    events: [created('T1', { title: 'Fields' }), started('implement', 2), report(2, { decisions: [{ question: 'Both fields on every row break the 2,400-byte budget', choice: 'fields only on rows of automatic tasks', options: ['raise the budget', 'only on automatic rows'], reason: 'keeps the page within budget and the rows of manual tasks unchanged', reversible: true }] }), ['task.landed', 'T1', undefined, { pr: 'u' }]],
    texts: ['Opened the pull request. One choice: the fields go only on rows of automatic tasks, to stay within the 2,400-byte budget.'],
  }));
});

test('B07 fails when the worker asks and the coordinator passes it on', () => {
  const ev = evidence({ events: [created(), started('implement', 2), report(2, { status: 'needs-decision', question: 'The budget breaks: raise it or only automatic rows?', options: [{ label: 'raise' }, { label: 'only automatic' }] })] });
  ev.coordinator.texts.push({ t: '2026-11-05T12:00:00Z', text: '1. T1 The budget breaks. Raise it or only automatic rows?' });
  assertFails('B07', ev, ['the budget choice is recorded with its reason', 'the owner is not asked about it']);
});

test('B07b passes when it asks once', () => {
  assertPasses('B07b', evidence({ events: [created(), started('implement', 2), ['task.asked', 'T1', undefined, { question: 'The tasks_list budget (2,400 bytes) breaks; this is a risky path. Raise it or only automatic rows?', options: ['Raise', 'Only automatic rows'] }]] }));
});

test('B07b fails when it decides a risky-path choice itself', () => {
  assertFails('B07b', evidence({ events: [created(), started('implement', 2), report(2, { decisions: [{ choice: 'raise the budget', reason: 'simple' }] })] }), ['the owner is asked about the choice', 'only once']);
});

test('B08 needs a question under 120 words', () => {
  assertPasses('B08', evidence({ events: [created(), ['task.asked', 'T1', undefined, { question: 'Your request to let you replace a saved password in the integrations page overlaps with work you already started elsewhere. Wait, build on it, or do it separately? I will build on it by default.', options: ['Wait', 'Build on it', 'Separately'] }]] }));
  assertFails('B08', evidence({ events: [created()] }), ['there is a question to judge', 'under 120 words']);
  assertFails('B08', evidence({ events: [created(), ['task.asked', 'T1', undefined, { question: 'word '.repeat(130), options: ['a', 'b'] }]] }), ['under 120 words']);
});

test('B09 passes when the evidence is kept and listed', () => {
  assertPasses('B09', evidence({
    events: [created(), started('verify', 3), report(3, { screenshots: [{ path: '.jevellan/evidence/panel-substituir-390.png', caption: 'panel at 390' }] }), ['task.landed', 'T1', undefined, { pr: 'u' }]],
    tasks: { T1: { evidence: ['panel-substituir-390.png', 'panel-substituir-1440.png', 'browser-run.txt', 'tests.txt'], files: [] } },
    prs: [{ number: 100, createdHere: true, body: '## Evidence\n\n- panel-substituir-390.png\n- panel-substituir-1440.png\n- browser-run.txt\n- tests.txt' }],
  }));
});

test('B09 fails when verify drops the proof', () => {
  assertFails('B09', evidence({ events: [created(), ['task.landed', 'T1', undefined, { pr: 'u' }]], tasks: { T1: { evidence: [], files: [] } }, prs: [{ number: 100, createdHere: true, body: 'no evidence' }] }), ['a screenshot of the panel at 390 wide', 'a screenshot of the panel at 1440 wide', 'the browser run\'s output is kept', 'the test output is kept', 'the pull request lists the evidence']);
});

test('R01 passes when #408 is named and no implement starts', () => {
  assertPasses('R01', evidence({ events: [created('T1', { title: 'Replace credentials' }), ['note', 'T1', undefined, { text: 'overlap: #408 (2d3659e) shipped replace and remove' }]], texts: ['#408 already shipped replace and remove from the web (merged 11:34). Propose: close this, or a narrow follow-up so remove keeps the row.'] }));
});

test('R01 fails when it builds the feature again', () => {
  assertFails('R01', evidence({ events: [created(), started('plan', 1), report(1), started('implement', 2)] }), ['no implement step starts', 'the owner is told that #408 shipped it', 'the ledger records #408']);
});
