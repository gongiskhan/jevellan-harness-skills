// The pure parts of placement (scripts/route.mjs) and the role lookups it makes over a temporary skills root of fake
// duty and runtime skills: frontmatter lists, duty needs and kinds, provider ranking, the menu and its questions,
// effort mapping, the state and its cap, the step part of the state read from the ledger's step views, how placed work
// ended, and the history. Runs with only this skill present.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fakeDuty, fakeRuntime, lineMaker, seqView, skillFile, tempDir } from './helpers/fixture.mjs';
import * as route from '../scripts/route.mjs';

const OPUS = { id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
const HAIKU = { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low', 'medium'] };
const ADVICE = 'tell the owner which role is missing and do not improvise it';

describe('roles and kinds', () => {
  test('frontmatterList reads inline lists, single values and block lists', () => {
    const fm = (body) => `---\nname: x\n${body}\n---\nbody`;
    assert.deepEqual(route.frontmatterList(fm('jh-needs: []'), 'jh-needs'), []);
    assert.deepEqual(route.frontmatterList(fm('jh-needs: [repo-write, "shell"]'), 'jh-needs'), ['repo-write', 'shell']);
    assert.deepEqual(route.frontmatterList(fm('jh-needs: repo-read'), 'jh-needs'), ['repo-read']);
    assert.deepEqual(route.frontmatterList(fm('jh-needs:\n  - repo-write\n  - browser\nother: 1'), 'jh-needs'), ['repo-write', 'browser']);
    assert.equal(route.frontmatterList(fm('other: 1'), 'jh-needs'), undefined);
    assert.throws(() => route.frontmatterList(fm('jh-needs: [open'), 'jh-needs'), { message: 'frontmatter jh-needs: "[open" is not a list' });
  });

  test('dutyNeeds and runtimeKinds read the installed skills by role; a missing role is exit 2 with the advice', () => {
    const skills = tempDir('jh-roles-');
    fakeDuty(skills, 'implement', ['repo-write', 'shell']);
    skillFile(path.join(skills, 'fake-duty-verify'), ['name: fake-duty-verify', 'description: Duty verify.', 'jh-role: duty', 'jh-duty: verify', 'jh-needs:', '  - repo-write', '  - browser']);
    skillFile(path.join(skills, 'fake-duty-odd'), ['name: fake-duty-odd', 'description: Duty odd.', 'jh-role: duty', 'jh-duty: odd', 'jh-needs: [telepathy]']);
    skillFile(path.join(skills, 'fake-duty-bare'), ['name: fake-duty-bare', 'description: Duty bare.', 'jh-role: duty', 'jh-duty: bare']);
    assert.deepEqual(route.dutyNeeds('implement', skills), ['repo-write', 'shell']);
    assert.deepEqual(route.dutyNeeds('verify', skills), ['repo-write', 'browser']);
    assert.throws(() => route.dutyNeeds('odd', skills), (e) => e.exitCode === 2 && /declares unknown jh-needs: telepathy/.test(e.message));
    assert.throws(() => route.dutyNeeds('bare', skills), (e) => e.exitCode === 2 && /declares no jh-needs/.test(e.message));
    assert.throws(() => route.dutyNeeds('plan', skills), (e) => e.exitCode === 2 && e.message === `no installed skill has the role duty (duty plan); ${ADVICE}`);
    assert.throws(() => route.runtimeKinds(skills), (e) => e.exitCode === 2 && e.message === `no installed skill has the role runtime; ${ADVICE}`);
    fakeRuntime(skills, 'a', ['claude-subscription', 'claude-endpoint']);
    fakeRuntime(skills, 'b', ['codex-subscription']);
    assert.deepEqual([...route.runtimeKinds(skills)].sort(), ['claude-endpoint', 'claude-subscription', 'codex-subscription']);
  });

  test('dutyKinds: one-turn duties and duties without needs run on the one-turn kinds, the rest on the agent kinds', () => {
    const all = new Set(['claude-subscription', 'claude-endpoint', 'codex-subscription', 'openai-compatible']);
    assert.deepEqual(route.dutyKinds('answer', [], all), ['claude-subscription', 'claude-endpoint', 'openai-compatible']);
    assert.deepEqual(route.dutyKinds('converse', ['repo-read'], all), ['claude-subscription', 'claude-endpoint', 'openai-compatible']);
    assert.deepEqual(route.dutyKinds('implement', ['repo-write', 'shell'], all), ['claude-subscription', 'claude-endpoint', 'codex-subscription']);
    assert.deepEqual(route.dutyKinds('implement', ['repo-write'], new Set(['claude-subscription'])), ['claude-subscription']);
  });
});

describe('providers and the menu', () => {
  test('rankProviders orders eligible, unmetered, known usage, lower usage; paid use follows paidUse', () => {
    const now = Date.now();
    const p = (name, kind, extra = {}) => ({ name, kind, enabled: true, ceilingPct: 90, paidUse: 'always', metered: kind === 'claude-endpoint', models: [OPUS], ...extra });
    const entry = (weeklyPct, fiveHourPct) => ({ auth: 'ready', weeklyPct, fiveHourPct, observedAt: new Date(now).toISOString() });
    const state = { providers: { a: entry(40, 10), b: entry(20, 30), c: entry(null, null), e: entry(null, null), f: entry(null, null), d: { auth: 'needs-login', observedAt: new Date(now).toISOString() } } };
    const ranked = route.rankProviders({
      providers: [p('a', 'claude-subscription'), p('b', 'claude-subscription'), p('c', 'claude-subscription'), p('d', 'claude-subscription'), p('e', 'claude-endpoint'), p('f', 'claude-endpoint', { paidUse: 'when-subscriptions-run-out' })],
      state,
      kinds: ['claude-subscription', 'claude-endpoint'],
      keyReady: () => true,
      now,
    });
    assert.deepEqual(ranked.map((r) => `${r.provider.name}:${r.reason}`), ['b:eligible', 'a:eligible', 'c:eligible', 'e:eligible', 'd:needs-login', 'f:paid-not-allowed']);
    assert.equal(route.providerCriterion({ name: 'x', weeklyPct: 12.345, fiveHourPct: null, ceilingPct: 90 }), 'x: week 12.3% of 90%, five hours unknown');
  });

  test('rankProviders: a provider with placement false is not offered, one whose projects list leaves the project out is not listed (H-044)', () => {
    const now = Date.now();
    const repo = tempDir('jh-rank-repo-');
    const entry = { auth: 'ready', weeklyPct: null, fiveHourPct: null, observedAt: new Date(now).toISOString() };
    const p = (name, extra = {}) => ({ name, kind: 'claude-endpoint', enabled: true, ceilingPct: 90, paidUse: 'always', metered: false, placement: true, models: [OPUS], ...extra });
    const ranked = route.rankProviders({
      providers: [p('open'), p('hidden', { placement: false }), p('listed', { projects: [repo] }), p('elsewhere', { projects: [tempDir('jh-rank-other-')] }), p('both', { placement: false, projects: [tempDir('jh-rank-other-')] })],
      state: { providers: { open: entry, hidden: entry, listed: entry, elsewhere: entry, both: entry } },
      kinds: ['claude-endpoint'],
      project: repo,
      keyReady: () => true,
      now,
    });
    assert.deepEqual(ranked.map((r) => `${r.provider.name}:${r.reason}`), ['listed:eligible', 'open:eligible', 'both:project-not-listed', 'elsewhere:project-not-listed', 'hidden:not-offered']);
    const policy = route.loadRouterPolicy();
    assert.throws(() => route.buildMenu({ config: { providers: [p('hidden', { placement: false })] }, state: { providers: { hidden: entry } }, kinds: ['claude-endpoint'], policy, project: repo, keyReady: () => true, now }), (e) => e.exitCode === 2 && /no provider can run this step \(kinds claude-endpoint\): hidden not-offered/.test(e.message));
  });

  test('buildMenu names each model by its best provider and refuses a model without a description; the questions follow it', () => {
    const now = Date.now();
    const observedAt = new Date(now).toISOString();
    const providers = [
      { name: 'main', kind: 'claude-subscription', enabled: true, ceilingPct: 90, paidUse: 'always', metered: false, models: [OPUS, HAIKU] },
      { name: 'second', kind: 'claude-subscription', enabled: true, ceilingPct: 90, paidUse: 'always', metered: false, models: [OPUS] },
    ];
    const state = { providers: { main: { auth: 'ready', weeklyPct: 50, fiveHourPct: 1, observedAt }, second: { auth: 'ready', weeklyPct: 5, fiveHourPct: 1, observedAt } } };
    const policy = route.loadRouterPolicy();
    const menu = route.buildMenu({ config: { providers }, state, kinds: ['claude-subscription'], policy, keyReady: () => true, now });
    assert.deepEqual(menu.models.map((m) => [m.id, m.provider]), [['claude-opus-5-5', 'second'], ['claude-haiku-5-5', 'main']]);
    assert.deepEqual(menu.servedBy.get('claude-opus-5-5'), ['second', 'main']);
    assert.deepEqual(menu.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    const { questions, modelKeys } = route.placementQuestions(policy, menu);
    assert.deepEqual(Object.keys(questions), ['model', 'effort']);
    assert.equal(modelKeys.get('Opus via second (claude-subscription)'), 'claude-opus-5-5');
    assert.equal(questions.model.instructions, policy.modelInstructions);
    assert.deepEqual(Object.keys(route.providerQuestion(menu, 'claude-opus-5-5').criteria), ['second', 'main']);
    assert.equal(route.providerQuestion(menu, 'claude-haiku-5-5'), undefined);

    const mystery = { ...providers[0], models: [{ id: 'mystery-1', label: 'Mystery', efforts: ['low'] }] };
    assert.throws(() => route.buildMenu({ config: { providers: [mystery] }, state, kinds: ['claude-subscription'], policy, keyReady: () => true, now }), (e) => e.exitCode === 2 && /has no line in "## model descriptions" for mystery-1/.test(e.message));
    const tired = { providers: { main: { ...state.providers.main, weeklyPct: 95 } } };
    assert.throws(() => route.buildMenu({ config: { providers: [providers[0]] }, state: tired, kinds: ['claude-subscription'], policy, keyReady: () => true, now }), (e) => e.exitCode === 2 && /no provider can run this step \(kinds claude-subscription\): main usage-ceiling/.test(e.message));
  });

  test('modelOptionKeys keeps every option distinct; resolveChoice breaks exact ties toward Jev', () => {
    const keys = route.modelOptionKeys([
      { id: 'a-1', label: 'A', provider: 'p', kind: 'claude-subscription' },
      { id: 'a-2', label: 'A', provider: 'p', kind: 'claude-subscription' },
      { id: 'b', label: 'B', provider: 'p', kind: 'claude-endpoint' },
    ]);
    assert.deepEqual([...keys], [['A via p (claude-subscription) [a-1]', 'a-1'], ['A via p (claude-subscription) [a-2]', 'a-2'], ['B via p (claude-endpoint)', 'b']]);
    const questions = { q: { type: 'choice', instructions: 'i', criteria: { x: 'x', y: 'y', z: 'z' } } };
    assert.equal(route.resolveChoice(questions, { q: { type: 'choice', choice: 'y', probabilities: { x: 0.4, y: 0.4, z: 0.2 } } }, 'q').option, 'y');
    assert.equal(route.resolveChoice(questions, { q: { type: 'choice', choice: 'z', probabilities: { x: 0.4, y: 0.4, z: 0.2 } } }, 'q').option, 'x');
    assert.throws(() => route.resolveChoice(questions, {}, 'q'), (e) => e.message === 'Jev: invalid response');
    assert.deepEqual(route.resolveNoul({ n: { type: 'noul', noul: 0.5 } }, 'n'), { value: true, probability: 0.5 });
    assert.throws(() => route.resolveNoul({}, 'n'), (e) => e.message === 'Jev: invalid response');
  });
});

describe('efforts and the state', () => {
  test('mapEffort: the next supported level above, else the highest below', () => {
    assert.equal(route.mapEffort('max', ['low', 'medium']), 'medium');
    assert.equal(route.mapEffort('medium', ['low', 'high']), 'high');
    assert.equal(route.mapEffort('low', ['max', 'high']), 'high');
    assert.equal(route.mapEffort('xhigh', ['low', 'medium', 'high', 'xhigh']), 'xhigh');
    assert.equal(route.mapEffort('xhigh', ['low', 'medium', 'high']), 'high');
    assert.throws(() => route.mapEffort('huge', ['low']), (e) => e.exitCode === 2 && /unknown effort huge/.test(e.message));
    assert.throws(() => route.mapEffort('low', []), (e) => e.exitCode === 2);
  });

  test('stateJson drops history first, then earlier summaries, then cuts the task text', () => {
    const base = {
      project: { name: 'p', guidance: '' },
      task: { id: 'T1', kind: 'feature', title: 't', text: 'x'.repeat(500), parent: null },
      step: { ordinal: 3, duty: 'verify', instructions: '', attempt: 1, previous: [{ duty: 'plan', status: 'done', summary: 'a'.repeat(300) }, { duty: 'implement', status: 'done', summary: 'b'.repeat(300) }] },
      history: { recent: [{ duty: 'plan', model: 'm', effort: 'high', outcome: 'done', attempts: 1, pad: 'h'.repeat(300) }, { duty: 'implement', model: 'm', effort: 'high', outcome: 'done', attempts: 1, pad: 'i'.repeat(300) }] },
      rules: 'r',
    };
    const full = JSON.stringify(base).length;
    assert.equal(route.STATE_LIMIT, 60000);
    assert.equal(route.stateJson(base, full), JSON.stringify(base));
    const lessHistory = JSON.parse(route.stateJson(base, full - 100));
    assert.equal(lessHistory.history.recent.length, 1);
    assert.equal(lessHistory.history.recent[0].duty, 'implement', 'the oldest history entry goes first');
    const noHistory = JSON.parse(route.stateJson(base, full - 450));
    assert.deepEqual(noHistory.history.recent, []);
    assert.equal(noHistory.step.previous.length, 2);
    const fewer = JSON.parse(route.stateJson(base, full - 1000));
    assert.equal(fewer.step.previous.length, 1);
    assert.equal(fewer.step.previous[0].duty, 'implement');
    assert.equal(fewer.task.text, 'x'.repeat(500));
    const cut = route.stateJson(base, full - 1500);
    assert.ok(cut.length <= full - 1500);
    assert.ok(JSON.parse(cut).task.text.endsWith('[Task shortened.]'));
    assert.throws(() => route.stateJson(base, 50), (e) => e.exitCode === 2 && e.message === 'Jev: decision context exceeds the size limit');
  });
});

// A task as lib/ledger-client.mjs readTask gives it, without a ledger: the show --json fields, created, and the views.
function taskOf(events, views = {}) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const hydrate = (v) => Object.fromEntries(Object.entries(seqView(v)).map(([k, value]) => [k, ['state', 'starts'].includes(k) ? value : bySeq.get(value) ?? null]));
  return {
    task: events[0].task,
    events,
    created: events[0],
    view: (o) => ({ ordinal: o, resetSeq: views[o]?.resetSeq ?? 0, ...hydrate(views[o]?.current ?? {}) }),
  };
}

const STEPS = [
  { ordinal: 1, duty: 'plan', instructions: 'Write plan.md.', when: 'jev:needs_plan', onFail: null },
  { ordinal: 2, duty: 'implement', instructions: 'Follow plan.md.', when: null, onFail: null },
  { ordinal: 3, duty: 'verify', instructions: 'Run the tests.', when: null, onFail: { goto: 2, maxLoops: 2 } },
];

describe('the step part of the state', () => {
  test('earlier steps come from their views since the last retry reset; the attempt and failure from the retries', () => {
    const line = lineMaker();
    const T = 'T4K2M9Q';
    const events = [
      line('task.created', T, { kind: 'feature', title: 'Add a section', text: 'The brief.', parent: null }),
      line('task.workflow', T, { steps: STEPS, skipped: [] }),
      line('step.started', T, { ordinal: 1, duty: 'plan' }, 1), // 3
      line('step.report', T, { status: 'done', summary: 'Plan written.' }, 1), // 4
      line('step.done', T, { ordinal: 1 }, 1), // 5
      line('step.started', T, { ordinal: 2, duty: 'implement' }, 2), // 6
      line('step.report', T, { status: 'done', summary: 'Implemented.' }, 2), // 7
      line('step.done', T, { ordinal: 2 }, 2), // 8
      line('step.started', T, { ordinal: 3, duty: 'verify' }, 3), // 9
      line('step.report', T, { status: 'done', summary: 'Two tests fail.', testsRun: { command: 'npm test', passed: false } }, 3), // 10
      line('step.retrying', T, { ordinal: 3, attempt: 1, gotoOrdinal: 2, reason: 'tests failed' }, 3), // 11
    ];
    const views = { 1: { current: { state: 'done', starts: 1, started: 3, end: 4, done: 5, lastReport: 4 } } };
    const step = route.stepState(taskOf(events, views), 2, 'implement');
    assert.deepEqual(step, {
      ordinal: 2,
      duty: 'implement',
      instructions: 'Follow plan.md.',
      attempt: 2,
      previous: [{ duty: 'plan', status: 'done', summary: 'Plan written.' }],
      failure: 'Two tests fail.',
    });
    // The view is what decides: a step whose current view has not started is left out of the earlier steps.
    assert.deepEqual(route.stepState(taskOf(events, {}), 2, 'implement').previous, []);
    // Step 3 sees steps 1 and 2 as their views say (a running step 2, a blocked step 1).
    const other = { 1: { current: { state: 'reported-blocked', starts: 1, started: 3, end: 4, lastReport: 4 } }, 2: { current: { state: 'running', starts: 2, started: 6, lastReport: 7 } } };
    const blocked = events.map((e) => (e.seq === 4 ? { ...e, data: { status: 'blocked', summary: 'No access.' } } : e));
    assert.deepEqual(route.stepState(taskOf(blocked, other), 3, 'verify').previous, [{ duty: 'plan', status: 'blocked', summary: 'No access.' }, { duty: 'implement', status: 'running', summary: 'Implemented.' }]);
    assert.throws(() => route.stepState(taskOf(events, views), 2, 'verify'), (e) => e.exitCode === 2 && e.message === `step 2 of ${T} is duty implement, not verify`);
    const skipped = [...events.slice(0, 1), line('task.workflow', T, { steps: STEPS, skipped: [1] })];
    assert.throws(() => route.stepState(taskOf(skipped), 1, 'plan'), (e) => e.exitCode === 2 && /step 1 of T4K2M9Q is skipped by its workflow/.test(e.message));
    assert.deepEqual(route.stepState(taskOf(skipped), 2, 'implement').previous, [{ duty: 'plan', status: 'skipped', summary: 'Jev: not needed' }]);
  });

  test('a single task has one step with no instructions', () => {
    const line = lineMaker();
    const events = [line('task.created', 'TSNGL01', { kind: 'single', duty: 'answer', title: 'Which port', text: 'Which port?', parent: null })];
    assert.deepEqual(route.stepState(taskOf(events), 1, 'answer'), { ordinal: 1, duty: 'answer', instructions: '', attempt: 1, previous: [] });
    assert.deepEqual(route.taskState(taskOf(events)), { id: 'TSNGL01', kind: 'single', title: 'Which port', text: 'Which port?', parent: null });
  });
});

describe('how placed work ended', () => {
  test('placementOutcome reads how placed work ended, and on which attempt', () => {
    let seq = 0;
    const e = (kind, step, data = {}) => ({ seq: (seq += 1), kind, task: 'T1', step, data });
    const placed = e('task.placed', 2, { step: 2, attempt: 1 });
    const events = [placed, e('step.started', 2), e('step.report', 2, { status: 'blocked' }), e('step.started', 2), e('step.report', 2, { status: 'done' }), e('step.done', 2)];
    assert.deepEqual(route.placementOutcome(events, placed), { outcome: 'done', attempts: 1, placedAttempt: 1, onPlacedAttempt: true });
    const failing = [placed, e('step.started', 2), e('step.report', 2, { status: 'done', testsRun: { command: 'npm test', passed: false } })];
    assert.equal(route.placementOutcome(failing, placed).outcome, 'failed');
    const running = [placed, e('step.started', 2), e('step.report', 2, { status: 'progress' }), e('step.started', 2)];
    assert.deepEqual(route.placementOutcome(running, placed), { outcome: 'running', attempts: null, placedAttempt: 1, onPlacedAttempt: false });
    const later = [placed, e('step.started', 2), e('step.failed', 2, { reason: 'crash' }), e('step.retrying', 2, { gotoOrdinal: 2 }), e('step.started', 2), e('step.report', 2, { status: 'done' })];
    assert.deepEqual(route.placementOutcome(later, placed), { outcome: 'done', attempts: 2, placedAttempt: 1, onPlacedAttempt: false });
    const replaced = [placed, e('step.started', 2), e('step.lost', 2, { pid: 1 }), e('task.placed', 2, { step: 2, attempt: 1 }), e('step.started', 2), e('step.report', 2, { status: 'done' })];
    assert.equal(route.placementOutcome(replaced, placed).outcome, 'lost');
    assert.equal(route.placementOutcome([placed], placed).outcome, 'pending');
  });

  test('historyOf gives each placement with how its work ended, read from its task\'s lines', () => {
    const line = lineMaker();
    const events = [];
    for (let i = 1; i <= 12; i += 1) events.push(line('task.placed', 'TAAAAA1', { step: 1, duty: 'plan', model: `m-${i}`, effort: 'low' }));
    events.push(line('task.placed', 'TBBBBB2', { step: 1, duty: 'implement', model: 'opus', effort: 'high' }));
    events.push(line('step.started', 'TBBBBB2', {}, 1));
    events.push(line('step.report', 'TBBBBB2', { status: 'done' }, 1));
    events.push(line('note', null, { text: 'not a task line' }));
    const grouped = route.groupByTask(events);
    assert.deepEqual([...grouped.keys()], ['TAAAAA1', 'TBBBBB2']);
    const placed = events.filter((e) => e.kind === 'task.placed').slice(-route.HISTORY_LIMIT);
    const history = route.historyOf(placed, events);
    assert.equal(history.length, route.HISTORY_LIMIT);
    assert.equal(history[0].model, 'm-4');
    assert.deepEqual(history.at(-1), { duty: 'implement', model: 'opus', effort: 'high', outcome: 'done', attempts: 1 });
    assert.equal(history.at(-2).outcome, 'pending');
  });
});
