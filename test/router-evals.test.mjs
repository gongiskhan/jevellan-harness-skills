// The placement policy's evals (skills/jevellan-placement/evals/run.mjs): the hand cases shipped in evals/cases.json,
// the export of task.placed lines from project ledgers into cases, and the replay of the current policy against the
// cases through a fake Jev on 127.0.0.1 (JH_JEV_URL). Placements are made by route.mjs itself in temporary projects
// whose .claude/skills hold copies of the router and ledger skills plus fixture duty and runtime skills; the copied
// providers.mjs is a stub, so no test probes a real provider. The runner always writes into the fixture's copy of
// the skill (or a --results file), never into this repository's evals folder.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { NODE, REPO, childEnv, makeRepo, tempDir, writeJson } from './helpers/ledger-fixture.mjs';
import { appendEvent } from '../skills/jevellan-ledger/scripts/lib/ledger.mjs';
import { newTaskId } from '../skills/jevellan-ledger/scripts/lib/ids.mjs';
import * as evals from '../skills/jevellan-placement/evals/run.mjs';
import { loadRouterPolicy } from '../skills/jevellan-placement/scripts/route.mjs';

const JEV_KEY = 'jev-evals-fixture-key-0123456789';
const OPUS = { id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
const HAIKU = { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low', 'medium'] };
const HAIKU_LOW = { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low'] };
const NEEDS = { investigate: ['repo-read'], implement: ['repo-write', 'shell'], verify: ['repo-write', 'shell', 'browser'] };
const STEPS = [
  { ordinal: 1, duty: 'implement', instructions: 'Implement it.', when: null, onFail: null },
  { ordinal: 2, duty: 'verify', instructions: 'Verify it.', when: null, onFail: { goto: 1, maxLoops: 2 } },
];
const REPO_CASES = JSON.parse(fs.readFileSync(path.join(REPO, 'skills', 'jevellan-placement', 'evals', 'cases.json'), 'utf8'));
const handCase = (id) => structuredClone(REPO_CASES.cases.find((c) => c.id === id));

// ---- the fake Jev ------------------------------------------------------------------------------------------------

function choiceAnswer(question, pick) {
  const keys = Object.keys(question.criteria);
  const choice = (pick !== undefined && (keys.find((k) => k === pick) ?? keys.find((k) => k.startsWith(`${pick} `)))) || keys[0];
  const others = keys.filter((k) => k !== choice);
  return { type: 'choice', choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.7 : 0.3 / others.length])), confidence: 0.8 };
}

async function startJev() {
  const jev = { requests: [], queue: [], picks: {} };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      jev.requests.push({ path: req.url, authorized: req.headers.authorization === `Bearer ${JEV_KEY}`, body: parsed });
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const next = jev.queue.shift();
      if (typeof next === 'number') return send(next, { error: 'scripted failure' });
      if (req.url === '/models') return send(200, { models: [{ name: 'jev-latest', description: '', release_date: '2026-10-22' }] });
      const answers = {};
      for (const [id, q] of Object.entries(parsed.questions)) answers[id] = q.type === 'noul' ? { type: 'noul', noul: jev.picks[id] ?? 0.5 } : choiceAnswer(q, jev.picks[id]);
      return send(200, { model: 'jev-test-1', answers, usage: { input_tokens: 100, output_tokens: 5 } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  jev.url = `http://127.0.0.1:${server.address().port}`;
  jev.reset = () => {
    jev.requests.length = 0;
    jev.queue.length = 0;
    jev.picks = {};
  };
  jev.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  return jev;
}

let jev;
before(async () => {
  jev = await startJev();
});
after(async () => {
  await jev.close();
});

// ---- the fixture -------------------------------------------------------------------------------------------------

function skillFile(dir, lines) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${lines.join('\n')}\n---\n\nFixture skill.\n`);
}

function makeFixture({ models = [OPUS, HAIKU], jevKey = true, policy } = {}) {
  const root = makeRepo();
  writeJson(path.join(root, '.jevellan', 'project.json'), { name: 'evals-fixture', guidance: '' });
  const skills = path.join(root, '.claude', 'skills');
  // The repository's own RESULTS.md is not copied, so a test can tell whether the runner wrote one.
  const results = path.join(REPO, 'skills', 'jevellan-placement', 'evals', 'RESULTS.md');
  fs.cpSync(path.join(REPO, 'skills', 'jevellan-placement'), path.join(skills, 'jevellan-placement'), { recursive: true, filter: (source) => source !== results });
  fs.cpSync(path.join(REPO, 'skills', 'jevellan-ledger'), path.join(skills, 'jevellan-ledger'), { recursive: true });
  const router = path.join(skills, 'jevellan-placement');
  fs.writeFileSync(path.join(router, 'scripts', 'providers.mjs'), "export async function checkProviders() { throw new Error('the fixture does not probe'); }\n");
  if (policy) fs.writeFileSync(path.join(router, 'SKILL.md'), policy(fs.readFileSync(path.join(router, 'SKILL.md'), 'utf8')));
  for (const [duty, needs] of Object.entries(NEEDS)) {
    skillFile(path.join(skills, `fixture-duty-${duty}`), [`name: fixture-duty-${duty}`, `description: Duty ${duty}.`, 'jh-role: duty', `jh-duty: ${duty}`, `jh-needs: [${needs.join(', ')}]`]);
  }
  skillFile(path.join(skills, 'fixture-runtime'), ['name: fixture-runtime', 'description: Runtime fixture.', 'jh-role: runtime', 'jh-kinds: [claude-subscription, claude-endpoint]']);
  const home = tempDir('jh-evals-home-');
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true, mode: 0o700 });
  const keyFile = path.join(home, 'secrets', 'jev.key');
  if (jevKey) fs.writeFileSync(keyFile, `${JEV_KEY}\n`, { mode: 0o600 });
  const tokenFile = path.join(home, 'secrets', 'claude-main.token');
  fs.writeFileSync(tokenFile, 'claude-main-evals-token-abcdef\n', { mode: 0o600 });
  writeJson(path.join(home, 'providers.json'), { jev: { keyFile, model: 'jev-latest', timeoutMs: 4000 }, providers: [{ name: 'claude-main', kind: 'claude-subscription', tokenFile, ceilingPct: 90, models }] });
  const observedAt = new Date(Date.now() - 60 * 1000).toISOString();
  writeJson(path.join(home, 'providers-state.json'), { providers: { 'claude-main': { auth: 'ready', detail: 'fixture', weeklyPct: 10, fiveHourPct: 5, weeklyResetsAt: null, fiveHourResetsAt: null, observedAt } } });
  return {
    root,
    home,
    router,
    route: path.join(router, 'scripts', 'route.mjs'),
    runner: path.join(router, 'evals', 'run.mjs'),
    casesFile: path.join(router, 'evals', 'cases.json'),
  };
}

function runNode(script, args, { cwd, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [script, ...args], { cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) }));
  });
}

const envOf = (fx) => ({ JH_HARNESS_HOME: fx.home, JH_JEV_URL: jev.url });
const runEvals = (fx, args, cwd = fx.root) => runNode(fx.runner, args, { cwd, env: envOf(fx) });

async function place(fx, task, step, duty, picks = {}, extra = []) {
  jev.picks = picks;
  const r = await runNode(fx.route, ['--task', task, '--step', String(step), '--duty', duty, ...extra], { cwd: fx.root, env: envOf(fx) });
  assert.equal(r.status, 0, r.stderr);
  return r.json();
}

function addTask(root, { kind = 'single', duty = 'investigate', title = 'Find the port' } = {}) {
  const task = newTaskId();
  const data = { kind, title, text: `${title}: the brief.`, parent: null, after: null, origin: 'owner' };
  if (kind === 'single') data.duty = duty;
  appendEvent(root, { kind: 'task.created', task, data });
  return task;
}

const add = (root, task, kind, data, step) => appendEvent(root, { kind, task, step, data });
const started = (root, task, step, duty) => add(root, task, 'step.started', { ordinal: step, duty, runtime: 'claude', provider: 'claude-main', model: 'm', effort: 'high', cwd: '/wt', nativeSessionId: 'n', pid: 1 }, step);
const report = (root, task, step, data = {}) => add(root, task, 'step.report', { status: 'done', summary: `Step ${step} done.`, ...data }, step);
const readCases = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).cases;

// ---- the shipped cases ------------------------------------------------------------------------------------------

describe('the cases shipped with the policy', () => {
  test('are valid, in this repository state shape, and every one can be asked with the current policy', () => {
    const { cases } = evals.readCasesFile(evals.CASES_FILE);
    const policy = loadRouterPolicy();
    assert.ok(cases.length >= 10);
    assert.ok(cases.filter((c) => c.source === 'hand').length >= 10);
    assert.ok(cases.filter((c) => c.split === 'held-out' && c.expected !== null).length >= 3, 'held-out cases are scored');
    assert.ok(!JSON.stringify(cases).includes('"runtime'), 'no state or option still names a runtime');
    for (const c of cases) {
      const rebuilt = evals.rebuildCase(policy, c);
      assert.ok(rebuilt.calls.length >= 1, c.id);
      if (c.kind === 'placement') {
        assert.ok(Array.isArray(c.state.duty.kinds), c.id);
        for (const key of Object.keys(c.questions.model?.criteria ?? {})) assert.ok(evals.stateModelKeys(c.state).has(key), `${c.id}: ${key}`);
        assert.deepEqual(Object.keys(c.state), ['project', 'task', 'step', 'duty', 'menu', 'history', 'rules'], c.id);
        assert.deepEqual(Object.keys(c.state.task), ['id', 'kind', 'title', 'text', 'parent'], c.id);
      } else assert.deepEqual(Object.keys(c.state), ['project', 'task', 'rules'], c.id);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(evals.THRESHOLD_FILE, 'utf8')), { heldOut: 0.6 });
    assert.equal(evals.readThreshold(), 0.6);
  });
});

// ---- export --------------------------------------------------------------------------------------------------------

describe('--export', () => {
  test('labels placed work by how it ended, holds out every fifth line, skips what has not ended, and merges', async () => {
    jev.reset();
    const fx = makeFixture();
    const hand = readCases(fx.casesFile);
    const root = fx.root;
    // 1: a single step done on its first attempt.
    const a = addTask(root);
    await place(fx, a, 1, 'investigate', { model: 'Haiku', effort: 'low' });
    started(root, a, 1, 'investigate');
    report(root, a, 1);
    // 2 to 4: implement done; verify fails its tests and goes back; implement placed again and done on attempt 2.
    const b = addTask(root, { kind: 'feature', title: 'Add a page' });
    add(root, b, 'task.workflow', { steps: STEPS, skipped: [], questions: { needs_plan: false, needs_docs: false } });
    await place(fx, b, 1, 'implement', { model: 'Opus', effort: 'high' });
    started(root, b, 1, 'implement');
    report(root, b, 1);
    add(root, b, 'step.done', { ordinal: 1 }, 1);
    await place(fx, b, 2, 'verify', { model: 'Opus', effort: 'xhigh' });
    started(root, b, 2, 'verify');
    report(root, b, 2, { summary: 'One test fails.', testsRun: { command: 'npm test', passed: false, summary: '1 failing' } });
    add(root, b, 'step.retrying', { ordinal: 2, attempt: 1, gotoOrdinal: 1, reason: 'tests failed' }, 2);
    const b1again = await place(fx, b, 1, 'implement', { model: 'Opus', effort: 'max' });
    assert.equal(b1again.effort, 'max');
    started(root, b, 1, 'implement');
    report(root, b, 1);
    add(root, b, 'step.done', { ordinal: 1 }, 1);
    // An owner placement is not a Jev decision: not eligible, not counted.
    const c = addTask(root);
    await place(fx, c, 1, 'investigate', {}, ['--owner', 'claude-main/claude-opus-5-5/high']);
    // 5: held-out, done.
    const e = addTask(root);
    await place(fx, e, 1, 'investigate', { model: 'Opus', effort: 'medium' });
    started(root, e, 1, 'investigate');
    report(root, e, 1);
    // 6: verify placed again and still running.
    await place(fx, b, 2, 'verify', { model: 'Opus', effort: 'high' });
    started(root, b, 2, 'verify');
    // 7: blocked.
    const f = addTask(root);
    await place(fx, f, 1, 'investigate', { model: 'Haiku', effort: 'medium' });
    started(root, f, 1, 'investigate');
    report(root, f, 1, { status: 'blocked', summary: 'The repository is not readable.' });

    // A second project whose only placement asked Jev nothing.
    const other = makeFixture({ models: [HAIKU_LOW] });
    const g = addTask(other.root);
    await place(other, g, 1, 'investigate');
    started(other.root, g, 1, 'investigate');
    report(other.root, g, 1);

    const r = await runEvals(fx, ['--export', root, other.root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json(), {
      casesFile: fx.casesFile,
      exported: 6,
      outcome: 4,
      unlabelled: 2,
      heldOut: 1,
      skipped: { 'not-ended': 1, stopped: 0, 'nothing-asked': 1, unreadable: 0 },
      total: hand.length + 6,
    });
    const cases = readCases(fx.casesFile);
    assert.deepEqual(cases.slice(0, hand.length), hand, 'hand cases are kept as they were');
    const exported = cases.slice(hand.length);
    const byTask = (task, step) => exported.filter((x) => x.task === task && x.step === step);
    const [ca] = byTask(a, 1);
    assert.deepEqual(ca.expected, { model: 'claude-haiku-5-5', effort: 'low' });
    assert.equal(ca.source, 'outcome');
    assert.equal(ca.split, 'dev');
    assert.equal(ca.kind, 'placement');
    assert.match(ca.id, new RegExp(`^${a}-s1-\\d{8}T\\d{9}Z$`));
    assert.equal(ca.decisionFile, `${ca.id}.json`);
    const decision = JSON.parse(fs.readFileSync(path.join(root, '.jevellan', 'decisions', ca.decisionFile), 'utf8'));
    assert.deepEqual(ca.state, JSON.parse(decision.state));
    assert.deepEqual(ca.questions, decision.questions);
    const [b1, b1second] = byTask(b, 1);
    assert.deepEqual([b1.source, b1.expected], ['outcome', { model: 'claude-opus-5-5', effort: 'high' }]);
    assert.deepEqual([b1second.source, b1second.expected, b1second.state.step.attempt], ['outcome', { model: 'claude-opus-5-5', effort: 'max' }, 2]);
    const [b2] = byTask(b, 2);
    assert.deepEqual([b2.source, b2.expected, b2.outcome], ['failed', null, 'failed']);
    const [ce] = byTask(e, 1);
    assert.deepEqual([ce.split, ce.source, ce.expected], ['held-out', 'outcome', { model: 'claude-opus-5-5', effort: 'medium' }]);
    const [cf] = byTask(f, 1);
    assert.deepEqual([cf.split, cf.source, cf.expected, cf.outcome], ['dev', 'failed', null, 'blocked']);
    assert.equal(byTask(c, 1).length, 0);

    // A person labels the blocked case; a later export keeps the label, and the finished verify step joins.
    const labelled = readCases(fx.casesFile).map((x) => (x.id === cf.id ? { ...x, expected: { model: 'claude-opus-5-5' } } : x));
    writeJson(fx.casesFile, { skill: 'jevellan-placement', cases: labelled });
    report(root, b, 2);
    const again = await runEvals(fx, ['--export', root]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^Exported 7 cases \(5 labelled by their outcome, 2 unlabelled, 1 held-out\); skipped: none\. .* holds 17 cases\.$/m);
    const after = readCases(fx.casesFile);
    assert.equal(after.length, hand.length + 7);
    assert.deepEqual(after.find((x) => x.id === cf.id).expected, { model: 'claude-opus-5-5' });
    const b2second = after.filter((x) => x.task === b && x.step === 2).at(-1);
    assert.deepEqual([b2second.split, b2second.source, b2second.expected], ['dev', 'outcome', { model: 'claude-opus-5-5', effort: 'high' }]);
  });

  test('reads each named project through the ledger skill even when JH_PROJECT names another one', async () => {
    jev.reset();
    const fx = makeFixture();
    const other = makeFixture();
    const a = addTask(fx.root);
    await place(fx, a, 1, 'investigate', { model: 'Haiku', effort: 'low' });
    started(fx.root, a, 1, 'investigate');
    report(fx.root, a, 1);
    // The ledger finds its project from JH_PROJECT first; the export points it at each root it names.
    const r = await runNode(fx.runner, ['--export', fx.root, '--json'], { cwd: other.root, env: { ...envOf(fx), JH_PROJECT: other.root } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().exported, 1);
    assert.equal(readCases(fx.casesFile).at(-1).task, a);
  });

  test('refuses an export without a project root, and a project without a ledger', async () => {
    const fx = makeFixture();
    const none = await runEvals(fx, ['--export']);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /--export needs at least one project root/);
    const empty = tempDir('jh-no-ledger-');
    const missing = await runEvals(fx, ['--export', empty]);
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /no ledger at /);
  });
});

// ---- replay --------------------------------------------------------------------------------------------------------

describe('replay', () => {
  const NEW_OPUS = 'Fixture text: the default for every kind of work.';
  function replayFixture(options = {}) {
    const fx = makeFixture({ policy: (text) => text.replace(/^claude-opus-5-5: .*$/m, `claude-opus-5-5: ${NEW_OPUS}`), ...options });
    const stale = handCase('hand-plan-rate-limit');
    stale.id = 'stale-model';
    stale.state.menu.models[1].id = 'mystery-model-1';
    const unlabelled = handCase('hand-readme-typo');
    unlabelled.id = 'unlabelled-one';
    unlabelled.expected = null;
    const cases = [handCase('hand-ui-feature-implement'), handCase('hand-provider-headroom'), handCase('hand-wf-port-flag'), unlabelled, stale];
    const casesFile = path.join(tempDir('jh-evals-cases-'), 'cases.json');
    writeJson(casesFile, { skill: 'jevellan-placement', cases });
    const results = path.join(path.dirname(casesFile), 'RESULTS.md');
    return { ...fx, cases: casesFile, results };
  }
  const PICKS = { model: 'Opus', effort: 'high', provider: 'claude-second', needs_plan: 0.2, needs_docs: 0.3 };

  test('asks the stored state with questions from the current policy and reports agreement per split', async () => {
    jev.reset();
    const fx = replayFixture();
    jev.picks = PICKS;
    const r = await runEvals(fx, ['--cases', fx.cases, '--results', fx.results]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^held-out agreement: 67%$/m);
    assert.match(r.stdout, /^dev agreement: 50%$/m);
    assert.match(r.stdout, /^all agreement: 60%$/m);
    assert.match(r.stdout, /^agreement: 60%$/m);
    assert.match(r.stdout, /Held-out agreement: 67% \(threshold 60%\): pass/);
    assert.match(r.stdout, /hand-ui-feature-implement \(dev, hand\) effort: expected xhigh, Jev high \[high 0\.70, /);
    assert.match(r.stdout, /hand-wf-port-flag \(held-out, hand\) needs_docs: expected true, Jev false \[true 0\.30\]/);
    assert.match(r.stdout, /stale-model: the policy's "## model descriptions" has no line for mystery-model-1/);
    assert.match(r.stdout, /Unlabelled \(not scored; set "expected" to label\): unlabelled-one/);

    // Every call carries the current policy: refreshed descriptions, current instructions and rules.
    const policy = loadRouterPolicy(path.join(fx.router, 'SKILL.md'));
    const ui = jev.requests.find((q) => q.body?.questions?.model && JSON.parse(q.body.state).task.id === 'T4K2M9Q');
    assert.equal(ui.authorized, true);
    assert.equal(ui.body.questions.model.criteria['Opus via claude-main (claude-subscription)'], NEW_OPUS);
    assert.equal(ui.body.questions.model.instructions, policy.modelInstructions);
    const sent = JSON.parse(ui.body.state);
    assert.equal(sent.menu.models[0].description, NEW_OPUS);
    assert.equal(sent.rules, policy.rules);
    const providerCall = jev.requests.find((q) => q.body?.questions?.provider);
    assert.deepEqual(Object.keys(providerCall.body.questions), ['provider']);
    assert.deepEqual(Object.keys(providerCall.body.questions.provider.criteria), ['claude-main', 'claude-second']);
    assert.equal(jev.requests.length, 4, 'two calls for the provider case, one each for the other scored cases');

    const md = fs.readFileSync(fx.results, 'utf8');
    assert.match(md, /^# Eval results: jevellan-placement$/m);
    assert.match(md, new RegExp(`^- Policy hash: \`${policy.hash}\`$`, 'm'));
    assert.match(md, /^- Date: \d{4}-\d{2}-\d{2}T/m);
    assert.match(md, /^\| needs_docs \| - \| 0\/1 \(0%\) \| 0\/1 \(0%\) \|$/m);
    assert.match(md, /^\| \*\*all questions\*\* \| 1\/2 \(50%\) \| 2\/3 \(67%\) \| 3\/5 \(60%\) \|$/m);
    assert.match(md, /^- hand-ui-feature-implement \(dev, hand\) effort: expected xhigh, Jev high/m);
    assert.match(md, /^- stale-model: /m);
    assert.ok(!fs.existsSync(path.join(fx.router, 'evals', 'RESULTS.md')), '--results moves the report');
  });

  test('exit 1 below the threshold; --split narrows the cases; RESULTS.md defaults to the evals folder', async () => {
    jev.reset();
    const fx = replayFixture();
    jev.picks = PICKS;
    const strict = await runEvals(fx, ['--cases', fx.cases, '--threshold', '0.9']);
    assert.equal(strict.status, 1, strict.stderr);
    assert.match(strict.stdout, /Held-out agreement: 67% \(threshold 90%\): FAIL/);
    assert.ok(fs.existsSync(path.join(fx.router, 'evals', 'RESULTS.md')));
    jev.reset();
    jev.picks = PICKS;
    const dev = await runEvals(fx, ['--cases', fx.cases, '--split', 'dev', '--threshold', '0.9', '--results', fx.results, '--json']);
    assert.equal(dev.status, 0, dev.stderr);
    const out = dev.json();
    assert.equal(out.split, 'dev');
    assert.deepEqual(out.heldOut, { rate: null, pass: null });
    assert.deepEqual(out.cases.map((c) => c.id), ['hand-ui-feature-implement', 'unlabelled-one', 'stale-model']);
  });

  test('exit 2 when the run cannot be made: no key, Jev failing, a bad cases file or argument', async () => {
    jev.reset();
    const noKey = replayFixture({ jevKey: false });
    const r1 = await runEvals(noKey, ['--cases', noKey.cases, '--results', noKey.results]);
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /^evals: Jev: no key configured$/m);
    assert.equal(jev.requests.length, 0);

    const fx = replayFixture();
    jev.queue.push(...Array(20).fill(500));
    const r2 = await runEvals(fx, ['--cases', fx.cases, '--results', fx.results]);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /^evals: Jev: service unavailable$/m);
    jev.reset();

    const bad = path.join(tempDir('jh-evals-bad-'), 'cases.json');
    writeJson(bad, { cases: [{ id: 'x', kind: 'landing', state: {}, questions: {}, expected: null, source: 'hand', split: 'dev' }] });
    const r3 = await runEvals(fx, ['--cases', bad]);
    assert.equal(r3.status, 2);
    assert.match(r3.stderr, /case 1 has kind landing \(placement or workflow\)/);
    const r4 = await runEvals(fx, ['--threshold', '60']);
    assert.equal(r4.status, 2);
    assert.match(r4.stderr, /--threshold is a number from 0 to 1, not 60/);
    const r5 = await runEvals(fx, ['--split', 'train']);
    assert.equal(r5.status, 2);
    const r6 = await runEvals(fx, ['--cases', path.join(tempDir('jh-evals-none-'), 'none.json')]);
    assert.equal(r6.status, 2);
    assert.match(r6.stderr, /no cases file at /);
  });
});
