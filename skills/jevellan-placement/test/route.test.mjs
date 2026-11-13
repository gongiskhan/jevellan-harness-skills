// Placement end to end with no real sibling skill: a copy of this skill runs from a temporary skills root next to
// fake duty and runtime skills (frontmatter only) and a fake ledger skill whose public script answers show --json and
// events --json from canned data and records every call it gets, record task.placed included. Jev is a fake on
// 127.0.0.1 (JH_JEV_URL); the copy's providers.mjs is a stub, so nothing probes a real provider. Also the role-missing
// paths: no ledger, no runtime, no duty skill, each exit 2 with the sentence that says to stop and tell the owner.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  STUB_NO_PROBE,
  copySkill,
  fakeDuty,
  fakeLedger,
  fakeRuntime,
  git,
  harnessHome,
  lineMaker,
  makeRepo,
  readJson,
  runNode,
  showJson,
  startJev,
  tempDir,
  writeJson,
} from './helpers/fixture.mjs';
import { PROVIDER_INSTRUCTIONS, loadRouterPolicy } from '../scripts/route.mjs';

const JEV_KEY = 'jev-fixture-key-0123456789';
const ADVICE = 'tell the owner which role is missing and do not improvise it';
const OPUS = { id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
const SONNET = { id: 'claude-sonnet-5-5', label: 'Sonnet', efforts: ['low', 'medium', 'high'] };
const HAIKU = { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low', 'medium'] };
const DUTY_NEEDS = { answer: [], investigate: ['repo-read'], plan: ['repo-read'], implement: ['repo-write', 'shell'], verify: ['repo-write', 'shell', 'browser'] };
const CLAUDE_KINDS = ['claude-subscription', 'claude-endpoint'];
const FEATURE_STEPS = [
  { ordinal: 1, duty: 'plan', instructions: 'Write plan.md at the worktree root.', when: 'jev:needs_plan', onFail: null },
  { ordinal: 2, duty: 'implement', instructions: 'Follow plan.md when it exists. Commit on the task branch.', when: null, onFail: null },
  { ordinal: 3, duty: 'verify', instructions: 'Run the project test command.', when: null, onFail: { goto: 2, maxLoops: 2 } },
];
const T = 'T4K2M9Q';
const U = 'TQ7RS3V';

let jev;
before(async () => {
  jev = await startJev({ key: JEV_KEY });
});
after(async () => {
  await jev.close();
});

// The ledger a feature task T whose plan step was placed, ran and is done, and a single task U whose one placement
// ended blocked: {show, events}, as the fake ledger serves it.
function ledgerData() {
  const line = lineMaker();
  const placed = (task, step, data) => line('task.placed', task, { step, provider: 'claude-main', kind: 'claude-subscription', probabilities: {}, latencyMs: 5, policyHash: 'h', source: 'jev', attempt: 1, ...data }, step);
  const t = [
    line('task.created', T, { kind: 'feature', title: 'Add a How to run section', text: 'Add a How to run section to the README.', parent: null, after: null, origin: 'owner' }),
    line('task.workflow', T, { steps: FEATURE_STEPS, skipped: [], questions: { needs_plan: true, needs_docs: false } }),
    placed(T, 1, { duty: 'plan', model: 'claude-opus-5-5', effort: 'high' }), // 3
    line('step.started', T, { ordinal: 1, duty: 'plan', session: 'w1' }, 1), // 4
    line('step.report', T, { status: 'done', summary: 'Plan written to plan.md: one section in the README.' }, 1), // 5
    line('step.done', T, { ordinal: 1 }, 1), // 6
  ];
  const u = [
    line('task.created', U, { kind: 'single', duty: 'investigate', title: 'Find the port', text: 'Which port does the dev server use?', parent: null, after: null, origin: 'owner' }),
    placed(U, 1, { duty: 'investigate', model: 'claude-haiku-5-5', effort: 'low' }), // 8
    line('step.started', U, { ordinal: 1, duty: 'investigate' }, 1), // 9
    line('step.report', U, { status: 'blocked', summary: 'The repository is not readable.' }, 1), // 10
  ];
  return {
    show: {
      [T]: showJson(t, { 1: { current: { state: 'done', starts: 1, started: 4, end: 5, done: 6, lastReport: 5, placed: 3 } }, 2: { current: {} }, 3: { current: {} } }),
      [U]: showJson(u, { 1: { current: { state: 'reported-blocked', starts: 1, started: 9, end: 10, lastReport: 10, placed: 8 } } }),
    },
    events: [...t, ...u].sort((a, b) => a.seq - b.seq),
  };
}

// A project, a skills root (a copy of this skill, fake duties and runtimes, the fake ledger unless ledger is null)
// and a harness home.
function setup({ duties = DUTY_NEEDS, runtimes = [CLAUDE_KINDS], ledger = ledgerData(), providers = [{ name: 'claude-main', kind: 'claude-subscription', models: [OPUS, SONNET, HAIKU] }], state = {}, jevKey = true, observedAt } = {}) {
  const root = makeRepo();
  writeJson(path.join(root, '.jevellan', 'project.json'), { name: 'fixture-project', guidance: 'Fixture guidance.' });
  const skills = path.join(tempDir('jh-route-skills-'), 'skills');
  const copy = copySkill(skills, { providersStub: STUB_NO_PROBE });
  for (const [duty, needs] of Object.entries(duties)) fakeDuty(skills, duty, needs);
  runtimes.forEach((kinds, i) => fakeRuntime(skills, String(i), kinds));
  const fake = ledger === null ? null : fakeLedger(skills, ledger);
  const { home } = harnessHome({ providers, state, jevKey: jevKey ? JEV_KEY : null, ...(observedAt ? { observedAt } : {}) });
  return { root, skills, copy, home, ledger: fake, route: path.join(copy, 'scripts', 'route.mjs'), policyFile: path.join(copy, 'SKILL.md') };
}

function run(fx, args, { env = {}, cwd } = {}) {
  return runNode(fx.route, args, { cwd: cwd ?? fx.root, env: { JH_HARNESS_HOME: fx.home, JH_JEV_URL: jev.url, ...env } });
}

const decisionsDir = (root) => path.join(root, '.jevellan', 'decisions');
const decisionFiles = (root) => (fs.existsSync(decisionsDir(root)) ? fs.readdirSync(decisionsDir(root)).sort() : []);
const argvOf = (fx) => fx.ledger.calls().map((c) => c.argv);
const withoutLatency = ({ latencyMs, ...rest }) => rest;

describe('placement through the ledger skill', () => {
  test('reads the task and the history through the public script, asks Jev, and records task.placed', async () => {
    jev.reset();
    const fx = setup();
    jev.picks = { model: 'Sonnet', effort: 'medium' };
    const r = await run(fx, ['--task', T, '--step', '2', '--duty', 'implement'], { env: { JH_SESSION: 'coord-session-1' } });
    assert.equal(r.status, 0, r.stderr);
    const policy = loadRouterPolicy(fx.policyFile);
    const out = r.json();
    assert.deepEqual(Object.keys(out), ['provider', 'model', 'effort', 'kind', 'probabilities', 'latencyMs', 'policyHash', 'step', 'duty', 'source']);
    assert.deepEqual(withoutLatency(out), {
      provider: 'claude-main',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      kind: 'claude-subscription',
      probabilities: out.probabilities,
      policyHash: policy.hash,
      step: 2,
      duty: 'implement',
      source: 'jev',
    });
    assert.equal(out.probabilities.model['claude-sonnet-5-5'], 0.7);

    // The ledger skill was asked, from the project root, for the task, the placements and their tasks' lines, and to
    // record the placement; nothing else.
    const calls = fx.ledger.calls();
    assert.deepEqual(calls.map((c) => c.argv), [
      ['show', T, '--json'],
      ['events', '--kind', 'task.placed', '--json'],
      ['events', '--task', T, '--task', U, '--json'],
      ['record', 'task.placed', '--task', T, '--step', '2', '--session', 'coord-session-1', '--data-file', '-', '--json'],
    ]);
    for (const c of calls) assert.equal(c.cwd, fx.root);
    const recorded = JSON.parse(calls[3].stdin);
    assert.match(recorded.decisionFile, new RegExp(`^\\.jevellan/decisions/${T}-s2-\\d{8}T\\d{9}Z\\.json$`));
    assert.deepEqual(recorded, {
      step: 2,
      duty: 'implement',
      provider: 'claude-main',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      kind: 'claude-subscription',
      probabilities: out.probabilities,
      latencyMs: out.latencyMs,
      policyHash: policy.hash,
      source: 'jev',
      jevModel: 'jev-test-1',
      decisionFile: recorded.decisionFile,
      attempt: 1,
    });
    assert.deepEqual(fx.ledger.data().events.at(-1).data, recorded, 'the fake ledger holds the line as recorded');

    // Jev got the state of 7.2 built from what the ledger printed.
    const [call] = jev.systemone();
    assert.equal(call.authorized, true);
    const state = JSON.parse(call.body.state);
    assert.deepEqual(Object.keys(state), ['project', 'task', 'step', 'duty', 'menu', 'history', 'rules']);
    assert.deepEqual(state.project, { name: 'fixture-project', guidance: 'Fixture guidance.' });
    assert.deepEqual(state.task, { id: T, kind: 'feature', title: 'Add a How to run section', text: 'Add a How to run section to the README.', parent: null });
    assert.deepEqual(state.step, {
      ordinal: 2,
      duty: 'implement',
      instructions: 'Follow plan.md when it exists. Commit on the task branch.',
      attempt: 1,
      previous: [{ duty: 'plan', status: 'done', summary: 'Plan written to plan.md: one section in the README.' }],
    });
    assert.deepEqual(state.duty, { needs: ['repo-write', 'shell'], kinds: ['claude-subscription', 'claude-endpoint'] });
    assert.deepEqual(state.history, {
      recent: [
        { duty: 'plan', model: 'claude-opus-5-5', effort: 'high', outcome: 'done', attempts: 1 },
        { duty: 'investigate', model: 'claude-haiku-5-5', effort: 'low', outcome: 'blocked', attempts: 1 },
      ],
    });
    assert.equal(state.rules, policy.rules);

    // The decision file holds what was sent and answered.
    const file = path.join(fx.root, recorded.decisionFile);
    const decision = readJson(file);
    assert.equal(decision.state, call.body.state);
    assert.deepEqual(decision.questions, call.body.questions);
    assert.equal(decision.chosen.model, 'claude-sonnet-5-5');
    assert.equal(decision.policyHash, policy.hash);
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  });

  test('two providers for the chosen model: the provider is asked in a second call; from a worktree the ledger is asked at the root', async () => {
    jev.reset();
    const fx = setup({
      providers: [
        { name: 'claude-main', kind: 'claude-subscription', models: [OPUS, HAIKU] },
        { name: 'claude-second', kind: 'claude-subscription', models: 'same as claude-main' },
      ],
      state: { 'claude-main': { weeklyPct: 50, fiveHourPct: 20 }, 'claude-second': { weeklyPct: 10, fiveHourPct: null } },
    });
    const worktree = path.join(tempDir('jh-wt-'), 'wt');
    git(fx.root, 'worktree', 'add', '-q', '-b', 'jh/wt', worktree);
    jev.picks = { model: 'Opus', effort: 'high', provider: 'claude-main' };
    const r = await run(fx, ['--task', U, '--step', '1', '--duty', 'investigate'], { cwd: worktree });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([r.json().provider, r.json().model, r.json().effort], ['claude-main', 'claude-opus-5-5', 'high']);
    const calls = jev.systemone();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body.questions.provider, {
      type: 'choice',
      instructions: PROVIDER_INSTRUCTIONS,
      criteria: { 'claude-second': 'claude-second: week 10% of 90%, five hours unknown', 'claude-main': 'claude-main: week 50% of 90%, five hours 20%' },
    });
    for (const c of fx.ledger.calls()) assert.equal(c.cwd, fx.root);
    assert.equal(argvOf(fx).at(-1)[0], 'record');
    assert.ok(!fs.existsSync(path.join(worktree, '.jevellan', 'decisions')), 'the decision is written at the project root');
    assert.equal(decisionFiles(fx.root).length, 1);
  });

  test('--questions reads the task through the ledger, asks the workflow questions and records nothing', async () => {
    jev.reset();
    const fx = setup();
    jev.picks = { needs_plan: 0.8, needs_docs: 0.3 };
    const r = await run(fx, ['--task', T, '--questions', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const policy = loadRouterPolicy(fx.policyFile);
    assert.deepEqual(withoutLatency(r.json()), { needs_plan: true, needs_docs: false, probabilities: { needs_plan: 0.8, needs_docs: 0.3 }, policyHash: policy.hash });
    assert.deepEqual(argvOf(fx), [['show', T, '--json']]);
    const state = JSON.parse(jev.systemone()[0].body.state);
    assert.deepEqual(Object.keys(state), ['project', 'task', 'rules']);
    const files = decisionFiles(fx.root);
    assert.equal(files.length, 1);
    assert.match(files[0], new RegExp(`^${T}-workflow-\\d{8}T\\d{9}Z\\.json$`));
    assert.equal(readJson(path.join(decisionsDir(fx.root), files[0])).kind, 'workflow');
  });

  test('--owner may place on a provider that is not offered to Jev, never on one whose projects list leaves the project out (H-044)', async () => {
    jev.reset();
    const GLM = { id: 'glm-5.3', label: 'GLM', efforts: ['low', 'medium', 'high'] };
    const fx = setup({ providers: [{ name: 'claude-main', kind: 'claude-subscription', models: [OPUS, SONNET, HAIKU] }, { name: 'hidden', kind: 'claude-endpoint', placement: false, models: [GLM] }] });
    let r = await run(fx, ['--task', T, '--step', '2', '--duty', 'implement', '--owner', 'hidden/glm-5.3/low']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().provider, 'hidden');
    assert.equal(JSON.parse(fx.ledger.calls()[1].stdin).providerReason, 'not-offered');
    assert.equal(jev.requests.length, 0);

    const elsewhere = tempDir('jh-owner-elsewhere-');
    const fy = setup({ providers: [{ name: 'claude-main', kind: 'claude-subscription', models: [OPUS, SONNET, HAIKU] }, { name: 'listed', kind: 'claude-endpoint', placement: false, projects: [elsewhere], models: [GLM] }] });
    r = await run(fy, ['--task', T, '--step', '2', '--duty', 'implement', '--owner', 'listed/glm-5.3/low']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /provider listed runs only in the projects its projects list in providers.json names, and .* is not one of them/);
    assert.deepEqual(fy.ledger.calls().map((c) => c.argv[0]), ['show'], 'nothing recorded');
  });

  test('--owner records task.placed with source owner and asks no Jev', async () => {
    jev.reset();
    const fx = setup({ state: { 'claude-main': { weeklyPct: 95 } } });
    const r = await run(fx, ['--task', T, '--step', '2', '--duty', 'implement', '--owner', 'claude-main/claude-haiku-5-5/max']);
    assert.equal(r.status, 0, r.stderr);
    const policyHash = loadRouterPolicy(fx.policyFile).hash;
    assert.deepEqual(r.json(), { provider: 'claude-main', model: 'claude-haiku-5-5', effort: 'medium', kind: 'claude-subscription', probabilities: {}, latencyMs: 0, policyHash, step: 2, duty: 'implement', source: 'owner' });
    const calls = fx.ledger.calls();
    assert.deepEqual(calls.map((c) => c.argv), [['show', T, '--json'], ['record', 'task.placed', '--task', T, '--step', '2', '--data-file', '-', '--json']]);
    assert.deepEqual(JSON.parse(calls[1].stdin), { step: 2, duty: 'implement', provider: 'claude-main', model: 'claude-haiku-5-5', effort: 'medium', kind: 'claude-subscription', probabilities: {}, latencyMs: 0, policyHash, source: 'owner', attempt: 1, effortRequested: 'max', providerReason: 'usage-ceiling' });
    assert.equal(jev.requests.length, 0);
    assert.deepEqual(decisionFiles(fx.root), []);
  });
});

describe('the task', () => {
  test('--task-file names the task, which is then read from the ledger: the same placement as --task', async () => {
    const file = path.join(tempDir('jh-task-file-'), 'task.json');
    writeJson(file, { ...ledgerData().show[T], step: 2, duty: 'implement', note: 'extra keys are ignored' });
    // One probe time for both projects, so the two states are equal to the character.
    const observedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    jev.reset();
    jev.picks = { model: 'Opus', effort: 'high' };
    const a = setup({ observedAt });
    const fromFile = await run(a, ['--task-file', file, '--step', '2', '--duty', 'implement']);
    assert.equal(fromFile.status, 0, fromFile.stderr);
    const bodiesA = jev.systemone().map((q) => q.body);
    jev.reset();
    jev.picks = { model: 'Opus', effort: 'high' };
    const b = setup({ observedAt });
    const fromTask = await run(b, ['--task', T, '--step', '2', '--duty', 'implement']);
    assert.equal(fromTask.status, 0, fromTask.stderr);
    assert.deepEqual(withoutLatency(fromFile.json()), withoutLatency(fromTask.json()));
    assert.deepEqual(bodiesA, jev.systemone().map((q) => q.body));
    assert.deepEqual(argvOf(a)[0], ['show', T, '--json']);
  });

  test('a task file is checked without the ledger skill; a good one then needs the ledger role', async () => {
    jev.reset();
    const fx = setup({ ledger: null });
    const dir = tempDir('jh-task-file-');
    const write = (name, text) => {
      fs.writeFileSync(path.join(dir, name), text);
      return path.join(dir, name);
    };
    const cases = [
      [['--task-file', path.join(dir, 'missing.json')], /^cannot read --task-file .*missing\.json: ENOENT$/],
      [['--task-file', write('bad.json', '{not json')], /is not JSON/],
      [['--task-file', write('list.json', '[]')], /must hold one JSON object/],
      [['--task-file', write('noid.json', '{"title":"x"}')], /names no task id \(a "task" field of T and six characters\)$/],
      [['--task', 'nope'], /^"nope" is not a task id \(T and six characters\)$/],
      [['--task-file', write('ok.json', JSON.stringify({ task: T }))], new RegExp(`^no installed skill has the role ledger; ${ADVICE}$`)],
    ];
    for (const [args, pattern] of cases) {
      const r = await run(fx, [...args, '--step', '2', '--duty', 'implement']);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr.trim(), pattern);
    }
    assert.equal(jev.requests.length, 0);
    assert.deepEqual(decisionFiles(fx.root), []);
  });

  test('a task the ledger does not have is exit 3; a refused record passes the ledger refusal through', async () => {
    jev.reset();
    const fx = setup();
    const missing = await run(fx, ['--task', 'TZZZZZ9', '--step', '1', '--duty', 'investigate', '--json']);
    assert.equal(missing.status, 3, missing.stderr);
    assert.equal(missing.stderr.trim(), `no task TZZZZZ9 in this project's ledger (${fx.root})`);
    assert.deepEqual(missing.json(), { error: `no task TZZZZZ9 in this project's ledger (${fx.root})`, exitCode: 3 });
    assert.equal(jev.requests.length, 0);

    const refusing = setup({ ledger: { ...ledgerData(), refuse: { record: { exitCode: 2, error: 'task.placed refused by the fixture ledger' } } } });
    const r = await run(refusing, ['--task', T, '--step', '2', '--duty', 'implement', '--json']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), 'task.placed refused by the fixture ledger');
    assert.deepEqual(r.json(), { error: 'task.placed refused by the fixture ledger', exitCode: 2 });
  });
});

describe('a missing role', () => {
  test('no ledger skill: exit 2 with the role-missing sentence, before Jev and before anything is written', async () => {
    jev.reset();
    const fx = setup({ ledger: null });
    for (const args of [['--task', T, '--step', '2', '--duty', 'implement'], ['--task', T, '--questions'], ['--task', T, '--step', '2', '--duty', 'implement', '--owner', 'claude-main/claude-opus-5-5/high']]) {
      const r = await run(fx, [...args, '--json']);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stderr, `no installed skill has the role ledger; ${ADVICE}\n`);
      assert.deepEqual(r.json(), { error: `no installed skill has the role ledger; ${ADVICE}`, exitCode: 2 });
    }
    assert.equal(jev.requests.length, 0);
    assert.deepEqual(decisionFiles(fx.root), []);
  });

  test('no runtime skill, or no duty skill for the duty: exit 2 naming the role, nothing recorded', async () => {
    jev.reset();
    const noRuntime = setup({ runtimes: [] });
    const r1 = await run(noRuntime, ['--task', T, '--step', '2', '--duty', 'implement']);
    assert.equal(r1.status, 2);
    assert.equal(r1.stderr, `no installed skill has the role runtime; ${ADVICE}\n`);
    assert.deepEqual(argvOf(noRuntime), [['show', T, '--json']]);

    const noDuty = setup({ duties: { plan: ['repo-read'], implement: ['repo-write', 'shell'] } });
    const r2 = await run(noDuty, ['--task', T, '--step', '3', '--duty', 'verify']);
    assert.equal(r2.status, 2);
    assert.equal(r2.stderr, `no installed skill has the role duty (duty verify); ${ADVICE}\n`);
    const wrong = await run(noDuty, ['--task', T, '--step', '2', '--duty', 'verify']);
    assert.equal(wrong.status, 2);
    assert.equal(wrong.stderr, `step 2 of ${T} is duty implement, not verify\n`);
    assert.ok(!argvOf(noDuty).some((a) => a[0] === 'record'));
    assert.equal(jev.requests.length, 0);
  });
});

describe('no Jev, no placement', () => {
  test('no Jev key: exit 2 "Jev: no key configured"; nothing recorded, no decision file', async () => {
    jev.reset();
    const fx = setup({ jevKey: false });
    const r = await run(fx, ['--task', T, '--step', '2', '--duty', 'implement', '--json']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), 'Jev: no key configured');
    assert.deepEqual(r.json(), { error: 'Jev: no key configured', exitCode: 2 });
    assert.ok(!argvOf(fx).some((a) => a[0] === 'record'));
    assert.deepEqual(decisionFiles(fx.root), []);
    assert.equal(jev.requests.length, 0);
  });
});
