// Placement (skills/jevellan-router/scripts/route.mjs) together with the real ledger skill, driven as a child process
// the way a coordinator runs it, against a fake Jev on 127.0.0.1 (JH_JEV_URL) that answers /models and /systemone
// with scripted answers and records every request. Each test builds a temporary project whose .claude/skills holds
// copies of the router and ledger skills, fixture duty skills (jh-needs) and runtime skills (jh-kinds), and a
// temporary JH_HARNESS_HOME with providers.json, providers-state.json and dummy secret files. The copied providers.mjs
// is replaced by a stub, so no test can probe a real provider. The router reaches the ledger only through its public
// script (show --json, events --json, record), so these tests are where the ledger's views, events and record meet
// the router's reading of them. The router's own pieces, and placement against a fake ledger, are tested in
// skills/jevellan-router/test/.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { NODE, REPO, addWorktree, childEnv, makeRepo, readLedger, tempDir, writeJson } from './helpers/ledger-fixture.mjs';
import { appendEvent } from '../skills/jevellan-ledger/scripts/lib/ledger.mjs';
import { newTaskId } from '../skills/jevellan-ledger/scripts/lib/ids.mjs';
import * as route from '../skills/jevellan-router/scripts/route.mjs';

const JEV_KEY = 'jev-fixture-key-0123456789';
const TOKENS = { 'claude-main': 'claude-main-fixture-token-abcdef', 'claude-second': 'claude-second-fixture-token-ghijkl', 'claude-third': 'claude-third-fixture-token-mnopqr' };
const GLM_KEY = 'glm-fixture-key-stuvwx';
const DEEPSEEK_KEY = 'deepseek-fixture-key-yz0123';
const SECRETS = [JEV_KEY, GLM_KEY, DEEPSEEK_KEY, ...Object.values(TOKENS)];

const OPUS = { id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
const SONNET = { id: 'claude-sonnet-5-5', label: 'Sonnet', efforts: ['low', 'medium', 'high'] };
const HAIKU = { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low', 'medium'] };
const HAIKU_LOW = { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low'] };
const GPT = { id: 'gpt-6-astra', label: 'GPT', efforts: ['low', 'medium', 'high', 'xhigh'] };
const GLM = { id: 'glm-5.3', label: 'GLM', efforts: ['low', 'medium', 'high'] };
const DEEPSEEK = { id: 'deepseek-chat', label: 'DeepSeek', efforts: ['low', 'medium', 'high'] };

const DUTY_NEEDS = { answer: [], investigate: ['repo-read'], plan: ['repo-read'], implement: ['repo-write', 'shell'], verify: ['repo-write', 'shell', 'browser'] };
const CLAUDE_RUNTIME = ['claude-subscription', 'claude-endpoint'];
const FRESH = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const STALE = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();

const FEATURE_STEPS = [
  { ordinal: 1, duty: 'plan', instructions: 'Write plan.md at the worktree root.', when: 'jev:needs_plan', onFail: null },
  { ordinal: 2, duty: 'implement', instructions: 'Follow plan.md when it exists. Commit on the task branch.', when: null, onFail: null },
  { ordinal: 3, duty: 'verify', instructions: 'Run the project test command.', when: null, onFail: { goto: 2, maxLoops: 2 } },
];

const STUB_NO_PROBE = "export async function checkProviders() { throw new Error('the fixture does not probe'); }\n";
const STUB_PROBE = `import fs from 'node:fs';
import path from 'node:path';
export async function checkProviders({ only = [], jev = true } = {}) {
  const home = process.env.JH_HARNESS_HOME;
  const file = path.join(home, 'providers-state.json');
  let state = { providers: {} };
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  state.providers ??= {};
  for (const name of only) state.providers[name] = { auth: 'ready', detail: 'stub probe', weeklyPct: 20, fiveHourPct: 3, weeklyResetsAt: null, fiveHourResetsAt: null, observedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(state));
  fs.writeFileSync(path.join(home, 'probe-calls.json'), JSON.stringify({ only, jev }));
  return state;
}
`;

// ---- the fake Jev ------------------------------------------------------------------------------------------------

function choiceAnswer(question, pick) {
  const keys = Object.keys(question.criteria);
  let choice = keys[0];
  if (pick !== undefined) choice = keys.find((k) => k === pick) ?? keys.find((k) => k.startsWith(`${pick} `)) ?? keys[0];
  const others = keys.filter((k) => k !== choice);
  const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? 0.7 : 0.3 / others.length]));
  return { type: 'choice', choice, probabilities, confidence: 0.8 };
}

async function startJev() {
  const jev = { requests: [], queue: [], picks: {}, models: ['jev-latest', 'jev-preview'] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      // The key is compared here and never stored: requests keep only whether it was right.
      jev.requests.push({ method: req.method, path: req.url, authorized: req.headers.authorization === `Bearer ${JEV_KEY}`, body: parsed });
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof value === 'string' ? value : JSON.stringify(value));
      };
      const next = jev.queue.shift();
      if (typeof next === 'number') return send(next, { error: 'scripted failure' });
      if (typeof next === 'function') return next(parsed, send);
      if (req.url === '/models') return send(200, { models: jev.models.map((name) => ({ name, description: '', release_date: '2026-10-22' })) });
      if (req.url === '/systemone') {
        const answers = {};
        for (const [id, q] of Object.entries(parsed.questions)) {
          answers[id] = q.type === 'noul' ? { type: 'noul', noul: jev.picks[id] ?? 0.5 } : choiceAnswer(q, jev.picks[id]);
        }
        return send(200, { model: 'jev-test-1', answers, usage: { input_tokens: 120, output_tokens: 8 } });
      }
      return send(404, { error: 'no such route' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  jev.url = `http://127.0.0.1:${server.address().port}`;
  jev.systemone = () => jev.requests.filter((r) => r.path === '/systemone');
  jev.reset = () => {
    jev.requests.length = 0;
    jev.queue.length = 0;
    jev.picks = {};
    jev.models = ['jev-latest', 'jev-preview'];
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

function skillFile(dir, frontmatter, body = 'Fixture skill.\n') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter.join('\n')}\n---\n\n${body}`);
}

// providers: specs {name, kind, models, ...}; a claude-subscription gets a tokenFile with a dummy token (noSecret
// leaves the file out), a claude-endpoint or openai-compatible a keyFile. state: name -> partial entry, or null to
// leave the provider out of providers-state.json.
function makeFixture({
  providers = [{ name: 'claude-main', kind: 'claude-subscription', models: [OPUS, SONNET, HAIKU] }],
  state = {},
  runtimes = [CLAUDE_RUNTIME],
  duties = Object.keys(DUTY_NEEDS),
  jevKey = true,
  policy,
  stub = STUB_NO_PROBE,
} = {}) {
  const root = makeRepo();
  writeJson(path.join(root, '.jevellan', 'project.json'), { name: 'fixture-project', guidance: 'Fixture guidance.' });
  const skills = path.join(root, '.claude', 'skills');
  fs.cpSync(path.join(REPO, 'skills', 'jevellan-router'), path.join(skills, 'jevellan-router'), { recursive: true });
  fs.cpSync(path.join(REPO, 'skills', 'jevellan-ledger'), path.join(skills, 'jevellan-ledger'), { recursive: true });
  const policyFile = path.join(skills, 'jevellan-router', 'SKILL.md');
  if (policy) fs.writeFileSync(policyFile, policy(fs.readFileSync(policyFile, 'utf8')));
  fs.writeFileSync(path.join(skills, 'jevellan-router', 'scripts', 'providers.mjs'), stub);
  for (const duty of duties) {
    skillFile(path.join(skills, `fixture-duty-${duty}`), [`name: fixture-duty-${duty}`, `description: Duty ${duty}. Fixture.`, 'jh-role: duty', `jh-duty: ${duty}`, `jh-needs: [${DUTY_NEEDS[duty].join(', ')}]`]);
  }
  runtimes.forEach((kinds, i) => {
    skillFile(path.join(skills, `fixture-runtime-${i}`), [`name: fixture-runtime-${i}`, 'description: Runtime fixture.', 'jh-role: runtime', `jh-kinds: [${kinds.join(', ')}]`]);
  });

  const home = tempDir('jh-route-home-');
  const secrets = path.join(home, 'secrets');
  fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const secret = (name, value) => {
    const file = path.join(secrets, name);
    fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
    return file;
  };
  const jevKeyFile = path.join(secrets, 'jev.key');
  if (jevKey) secret('jev.key', JEV_KEY);
  const list = providers.map((spec) => {
    const { noSecret, ...p } = spec;
    if (p.kind === 'claude-subscription' && !p.tokenFile) {
      p.tokenFile = path.join(secrets, `${p.name}.token`);
      if (!noSecret) secret(`${p.name}.token`, TOKENS[p.name] ?? `${p.name}-fixture-token-000000`);
    }
    if ((p.kind === 'claude-endpoint' || p.kind === 'openai-compatible') && !p.keyFile) {
      p.keyFile = path.join(secrets, `${p.name}.key`);
      if (!noSecret) secret(`${p.name}.key`, p.name === 'glm' ? GLM_KEY : p.name === 'deepseek' ? DEEPSEEK_KEY : `${p.name}-fixture-key-000000`);
    }
    if (p.kind === 'claude-endpoint' || p.kind === 'openai-compatible') p.baseUrl ??= 'https://endpoint.invalid/v1';
    return p;
  });
  writeJson(path.join(home, 'providers.json'), { jev: { keyFile: jevKeyFile, model: 'jev-latest', timeoutMs: 4000 }, providers: list });
  const entries = {};
  for (const p of list) {
    const override = Object.hasOwn(state, p.name) ? state[p.name] : {};
    if (override === null) continue;
    entries[p.name] = { auth: 'ready', detail: 'fixture', weeklyPct: 10, fiveHourPct: 5, weeklyResetsAt: null, fiveHourResetsAt: null, observedAt: FRESH, ...override };
  }
  writeJson(path.join(home, 'providers-state.json'), { checkedAt: FRESH, jev: null, providers: entries });
  return {
    root,
    home,
    skills,
    policyFile,
    route: path.join(skills, 'jevellan-router', 'scripts', 'route.mjs'),
    ledgerCli: path.join(skills, 'jevellan-ledger', 'scripts', 'ledger.mjs'),
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

function run(fx, args, { env = {}, cwd } = {}) {
  return runNode(fx.route, args, { cwd: cwd ?? fx.root, env: { JH_HARNESS_HOME: fx.home, JH_JEV_URL: jev.url, ...env } });
}

function addTask(root, { kind = 'feature', duty, title = 'Add a How to run section', text = 'Add a How to run section to the README listing the commands in package.json.', id = newTaskId() } = {}) {
  const data = { kind, title, text, parent: null, after: null, origin: 'owner' };
  if (kind === 'single') data.duty = duty;
  appendEvent(root, { kind: 'task.created', task: id, data });
  return id;
}

const add = (root, task, kind, data = {}, step) => appendEvent(root, { kind, task, step, data });
const started = (root, task, ordinal, duty) => add(root, task, 'step.started', { ordinal, duty, runtime: 'claude', provider: 'claude-main', model: 'claude-opus-5-5', effort: 'high', cwd: '/wt', nativeSessionId: `native-${ordinal}`, pid: 1 }, ordinal);
const report = (root, task, ordinal, data = {}) => add(root, task, 'step.report', { status: 'done', summary: `Step ${ordinal} finished.`, ...data }, ordinal);
const placedLine = (root, task, ordinal, duty, data = {}) => add(root, task, 'task.placed', { step: ordinal, duty, provider: 'claude-main', model: 'claude-opus-5-5', effort: 'high', kind: 'claude-subscription', probabilities: {}, latencyMs: 5, policyHash: 'h', source: 'jev', attempt: 1, ...data });

// A feature task whose plan step ran, was placed and is done.
function featureAfterPlan(root) {
  const task = addTask(root);
  add(root, task, 'task.workflow', { steps: FEATURE_STEPS, skipped: [], questions: { needs_plan: true, needs_docs: false } });
  placedLine(root, task, 1, 'plan');
  started(root, task, 1, 'plan');
  report(root, task, 1, { summary: 'Plan written to plan.md: one section in the README.' });
  add(root, task, 'step.done', { ordinal: 1 }, 1);
  return task;
}

const lastLine = (root) => readLedger(root).at(-1);
const decisionsDir = (root) => path.join(root, '.jevellan', 'decisions');
const decisionFiles = (root) => (fs.existsSync(decisionsDir(root)) ? fs.readdirSync(decisionsDir(root)).sort() : []);
const readDecision = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const withoutLatency = ({ latencyMs, ...rest }) => rest;

function assertNoSecrets(...texts) {
  for (const text of texts) for (const value of SECRETS) assert.ok(!text.includes(value), 'a secret value appeared in the output');
}

// ---- placement ---------------------------------------------------------------------------------------------------

describe('placement through Jev', () => {
  test('appends task.placed with probabilities and writes the decision file', async () => {
    jev.reset();
    const fx = makeFixture({
      providers: [
        { name: 'claude-main', kind: 'claude-subscription', models: [OPUS, SONNET, HAIKU] },
        { name: 'codex', kind: 'codex-subscription', models: [GPT] },
      ],
    });
    const task = featureAfterPlan(fx.root);
    const before = readLedger(fx.root).length;
    jev.picks = { model: 'Sonnet', effort: 'medium' };
    const r = await run(fx, ['--task', task, '--step', '2', '--duty', 'implement']);
    assert.equal(r.status, 0, r.stderr);
    const policy = route.loadRouterPolicy(fx.policyFile);
    const out = r.json();
    assert.deepEqual(Object.keys(out), ['provider', 'model', 'effort', 'kind', 'probabilities', 'latencyMs', 'policyHash', 'step', 'duty', 'source']);
    assert.equal(out.provider, 'claude-main');
    assert.equal(out.model, 'claude-sonnet-5-5');
    assert.equal(out.effort, 'medium');
    assert.equal(out.kind, 'claude-subscription');
    assert.equal(out.policyHash, policy.hash);
    assert.equal(out.step, 2);
    assert.equal(out.duty, 'implement');
    assert.equal(out.source, 'jev');
    assert.ok(Number.isInteger(out.latencyMs) && out.latencyMs >= 0);
    assert.deepEqual(Object.keys(out.probabilities.model), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    assert.equal(out.probabilities.model['claude-sonnet-5-5'], 0.7);
    assert.equal(out.probabilities.effort.medium, 0.7);
    assert.equal(out.probabilities.provider, undefined);

    // One call: the model and effort questions, built from the policy, over the state of 7.2.
    const calls = jev.systemone();
    assert.equal(calls.length, 1);
    assert.equal(jev.requests.length, 1);
    assert.equal(calls[0].authorized, true);
    const body = calls[0].body;
    assert.equal(body.model, 'jev-latest');
    assert.deepEqual(Object.keys(body.questions), ['model', 'effort']);
    assert.equal(body.questions.model.instructions, policy.modelInstructions);
    assert.deepEqual(body.questions.model.criteria, {
      'Opus via claude-main (claude-subscription)': policy.modelDescriptions.get('claude-opus-5-5'),
      'Sonnet via claude-main (claude-subscription)': policy.modelDescriptions.get('claude-sonnet-5-5'),
      'Haiku via claude-main (claude-subscription)': policy.modelDescriptions.get('claude-haiku-5-5'),
    });
    assert.equal(body.questions.effort.instructions, policy.effortInstructions);
    assert.deepEqual(Object.keys(body.questions.effort.criteria), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(body.questions.effort.criteria.high, policy.effortGuide.get('high'));
    const state = JSON.parse(body.state);
    assert.deepEqual(Object.keys(state), ['project', 'task', 'step', 'duty', 'menu', 'history', 'rules']);
    assert.deepEqual(state.project, { name: 'fixture-project', guidance: 'Fixture guidance.' });
    assert.deepEqual(state.task, { id: task, kind: 'feature', title: 'Add a How to run section', text: 'Add a How to run section to the README listing the commands in package.json.', parent: null });
    assert.deepEqual(state.step, {
      ordinal: 2,
      duty: 'implement',
      instructions: 'Follow plan.md when it exists. Commit on the task branch.',
      attempt: 1,
      previous: [{ duty: 'plan', status: 'done', summary: 'Plan written to plan.md: one section in the README.' }],
    });
    assert.deepEqual(state.duty, { needs: ['repo-write', 'shell'], kinds: ['claude-subscription', 'claude-endpoint'] });
    assert.deepEqual(state.menu.models.map((m) => [m.id, m.label, m.provider, m.kind]), [
      ['claude-opus-5-5', 'Opus', 'claude-main', 'claude-subscription'],
      ['claude-sonnet-5-5', 'Sonnet', 'claude-main', 'claude-subscription'],
      ['claude-haiku-5-5', 'Haiku', 'claude-main', 'claude-subscription'],
    ]);
    assert.deepEqual(state.menu.models[2].efforts, ['low', 'medium']);
    assert.equal(state.menu.models[0].description, policy.modelDescriptions.get('claude-opus-5-5'));
    assert.deepEqual(state.menu.providers, [{ name: 'claude-main', kind: 'claude-subscription', weeklyPct: 10, fiveHourPct: 5, ceilingPct: 90, observedAt: FRESH }]);
    assert.deepEqual(state.history, { recent: [{ duty: 'plan', model: 'claude-opus-5-5', effort: 'high', outcome: 'done', attempts: 1 }] });
    assert.equal(state.rules, policy.rules);

    // The ledger line names the decision file, which holds what was sent and answered.
    const lines = readLedger(fx.root);
    assert.equal(lines.length, before + 1);
    const placed = lines.at(-1);
    assert.equal(placed.kind, 'task.placed');
    assert.equal(placed.task, task);
    assert.equal(placed.step, 2);
    assert.match(placed.data.decisionFile, new RegExp(`^\\.jevellan/decisions/${task}-s2-\\d{8}T\\d{9}Z\\.json$`));
    assert.deepEqual(withoutLatency({ ...placed.data, decisionFile: 'x' }), {
      step: 2,
      duty: 'implement',
      provider: 'claude-main',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      kind: 'claude-subscription',
      probabilities: out.probabilities,
      policyHash: policy.hash,
      source: 'jev',
      jevModel: 'jev-test-1',
      decisionFile: 'x',
      attempt: 1,
    });
    assert.equal(placed.data.latencyMs, out.latencyMs);
    const decision = readDecision(fx.root, placed.data.decisionFile);
    assert.equal(decision.kind, 'placement');
    assert.equal(decision.task, task);
    assert.equal(decision.step, 2);
    assert.equal(decision.state, body.state);
    assert.deepEqual(decision.questions, body.questions);
    assert.deepEqual(Object.keys(decision.answers), ['model', 'effort']);
    assert.equal(decision.chosen.model, 'claude-sonnet-5-5');
    assert.equal(decision.chosen.effortRequested, 'medium');
    assert.deepEqual(decision.chosen.choices.provider, { source: 'only-option', option: 'claude-main' });
    assert.deepEqual(decision.chosen.candidates.map((c) => [c.name, c.eligible, c.reason]), [['claude-main', true, 'eligible'], ['codex', false, 'unsupported']]);
    assert.equal(decision.jevModel, 'jev-test-1');
    assert.deepEqual(decision.usage, { input_tokens: 120, output_tokens: 8 });
    assert.equal(decision.calls.length, 1);
    assert.deepEqual(decision.calls[0].questions, ['model', 'effort']);
    assert.equal(decision.policyHash, policy.hash);
    assert.equal(decision.latencyMs, out.latencyMs);
    assert.equal((fs.statSync(path.join(fx.root, placed.data.decisionFile)).mode & 0o777).toString(8), '600');
    assertNoSecrets(r.stdout, r.stderr, fs.readFileSync(path.join(fx.root, '.jevellan', 'ledger.jsonl'), 'utf8'), fs.readFileSync(path.join(fx.root, placed.data.decisionFile), 'utf8'));
  });

  test('asks the provider in a second call when two providers serve the chosen model, from a worktree too', async () => {
    jev.reset();
    const fx = makeFixture({
      providers: [
        { name: 'claude-main', kind: 'claude-subscription', models: [OPUS, HAIKU] },
        { name: 'claude-second', kind: 'claude-subscription', models: 'same as claude-main' },
      ],
      state: { 'claude-main': { weeklyPct: 50, fiveHourPct: 20 }, 'claude-second': { weeklyPct: 10, fiveHourPct: null } },
    });
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    const worktree = addWorktree(fx.root);
    jev.picks = { model: 'Opus', effort: 'high', provider: 'claude-main' };
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate'], { cwd: worktree });
    assert.equal(r.status, 0, r.stderr);
    const out = r.json();
    assert.equal(out.provider, 'claude-main');
    assert.equal(out.model, 'claude-opus-5-5');
    assert.equal(out.effort, 'high');
    assert.equal(out.probabilities.provider['claude-main'], 0.7);
    const calls = jev.systemone();
    assert.equal(calls.length, 2);
    // The menu names each model by its best-ranked provider: claude-second has the lower usage.
    assert.deepEqual(Object.keys(calls[0].body.questions.model.criteria), ['Opus via claude-second (claude-subscription)', 'Haiku via claude-second (claude-subscription)']);
    assert.deepEqual(Object.keys(calls[1].body.questions), ['provider']);
    assert.equal(calls[1].body.state, calls[0].body.state);
    assert.deepEqual(calls[1].body.questions.provider, {
      type: 'choice',
      instructions: route.PROVIDER_INSTRUCTIONS,
      criteria: {
        'claude-second': 'claude-second: week 10% of 90%, five hours unknown',
        'claude-main': 'claude-main: week 50% of 90%, five hours 20%',
      },
    });
    const placed = lastLine(fx.root);
    assert.equal(placed.kind, 'task.placed');
    assert.equal(placed.data.provider, 'claude-main');
    assert.ok(!fs.existsSync(path.join(worktree, '.jevellan', 'ledger.jsonl')), 'the worktree has no ledger of its own');
    const decision = readDecision(fx.root, placed.data.decisionFile);
    assert.deepEqual(Object.keys(decision.questions), ['model', 'effort', 'provider']);
    assert.equal(decision.calls.length, 2);
    assert.deepEqual(decision.usage, { input_tokens: 240, output_tokens: 16 });
    assert.deepEqual(decision.chosen.choices.provider.source, 'jev');
  });

  test('a provider at or over its ceiling in either window is left out; a window that reset no longer counts', async () => {
    jev.reset();
    const providers = [
      { name: 'claude-main', kind: 'claude-subscription', models: [OPUS, HAIKU] },
      { name: 'claude-second', kind: 'claude-subscription', models: 'same as claude-main' },
      { name: 'claude-third', kind: 'claude-subscription', models: 'same as claude-main' },
    ];
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const fx = makeFixture({
      providers,
      state: {
        'claude-main': { weeklyPct: 95, fiveHourPct: 10 },
        'claude-second': { weeklyPct: 20, fiveHourPct: 90 },
        'claude-third': { weeklyPct: 99, weeklyResetsAt: past, fiveHourPct: 1 },
      },
    });
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().provider, 'claude-third');
    assert.equal(jev.systemone().length, 1, 'one provider serves the model: no provider question');
    const decision = readDecision(fx.root, lastLine(fx.root).data.decisionFile);
    assert.deepEqual(decision.chosen.candidates.map((c) => [c.name, c.reason, c.weeklyPct]), [
      ['claude-third', 'eligible', null],
      ['claude-second', 'usage-ceiling', 20],
      ['claude-main', 'usage-ceiling', 95],
    ]);
    assert.deepEqual(JSON.parse(decision.state).menu.providers.map((p) => p.name), ['claude-third']);

    const none = makeFixture({ providers: providers.slice(0, 1), state: { 'claude-main': { weeklyPct: 95 } } });
    const task2 = addTask(none.root, { kind: 'single', duty: 'investigate' });
    const lines = readLedger(none.root).length;
    const refused = await run(none, ['--task', task2, '--step', '1', '--duty', 'investigate']);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /no provider can run this step \(kinds claude-subscription, claude-endpoint\): claude-main usage-ceiling/);
    assert.equal(readLedger(none.root).length, lines);
  });

  test('a provider whose last probe says needs-login, or whose token file is empty, is left out', async () => {
    jev.reset();
    const fx = makeFixture({
      providers: [
        { name: 'claude-main', kind: 'claude-subscription', models: [OPUS, HAIKU] },
        { name: 'claude-second', kind: 'claude-subscription', models: 'same as claude-main' },
        { name: 'claude-third', kind: 'claude-subscription', models: 'same as claude-main', noSecret: true },
      ],
      state: { 'claude-main': { auth: 'needs-login', weeklyPct: 1 }, 'claude-second': { weeklyPct: 60 } },
    });
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().provider, 'claude-second');
    const decision = readDecision(fx.root, lastLine(fx.root).data.decisionFile);
    assert.deepEqual(decision.chosen.candidates.map((c) => [c.name, c.reason]), [['claude-second', 'eligible'], ['claude-main', 'needs-login'], ['claude-third', 'no-key']]);
    assert.equal(fs.existsSync(path.join(fx.home, 'probe-calls.json')), false, 'a fresh needs-login entry is not probed again');
  });

  test('a missing or stale login state is probed again through providers.mjs before the menu is built', async () => {
    jev.reset();
    const fx = makeFixture({
      providers: [
        { name: 'claude-main', kind: 'claude-subscription', models: [OPUS, HAIKU] },
        { name: 'claude-second', kind: 'claude-subscription', models: 'same as claude-main' },
        { name: 'claude-third', kind: 'claude-subscription', models: 'same as claude-main' },
      ],
      state: { 'claude-main': null, 'claude-second': { observedAt: STALE }, 'claude-third': { auth: 'needs-login' } },
      stub: STUB_PROBE,
    });
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    jev.picks = { provider: 'claude-second' };
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.home, 'probe-calls.json'), 'utf8')), { only: ['claude-main', 'claude-second'], jev: false });
    assert.equal(r.json().provider, 'claude-second');
    const state = JSON.parse(jev.systemone()[0].body.state);
    assert.deepEqual(state.menu.providers.map((p) => [p.name, p.weeklyPct]), [['claude-main', 20], ['claude-second', 20]]);

    // Without a working probe those providers count as needs-login, and the refusal says why.
    const broken = makeFixture({ providers: [{ name: 'claude-main', kind: 'claude-subscription', models: [OPUS] }], state: { 'claude-main': null } });
    const task2 = addTask(broken.root, { kind: 'single', duty: 'investigate' });
    const refused = await run(broken, ['--task', task2, '--step', '1', '--duty', 'investigate']);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /claude-main needs-login; the login probe failed: the fixture does not probe/);
  });

  test('a kind no installed runtime skill lists is left out; duties without needs run on the one-turn kinds', async () => {
    jev.reset();
    const providers = [
      { name: 'claude-main', kind: 'claude-subscription', models: [OPUS, HAIKU] },
      { name: 'codex', kind: 'codex-subscription', models: [GPT] },
      { name: 'glm', kind: 'claude-endpoint', models: [GLM] },
      { name: 'deepseek', kind: 'openai-compatible', models: [DEEPSEEK] },
    ];
    const claudeOnly = makeFixture({ providers });
    const t1 = addTask(claudeOnly.root, { kind: 'single', duty: 'implement' });
    const r1 = await run(claudeOnly, ['--task', t1, '--step', '1', '--duty', 'implement']);
    assert.equal(r1.status, 0, r1.stderr);
    const s1 = JSON.parse(jev.systemone()[0].body.state);
    assert.deepEqual(s1.duty.kinds, ['claude-subscription', 'claude-endpoint']);
    assert.deepEqual(s1.menu.models.map((m) => `${m.id}:${m.kind}`), ['claude-opus-5-5:claude-subscription', 'claude-haiku-5-5:claude-subscription', 'glm-5.3:claude-endpoint']);
    const d1 = readDecision(claudeOnly.root, lastLine(claudeOnly.root).data.decisionFile);
    assert.deepEqual(Object.fromEntries(d1.chosen.candidates.map((c) => [c.name, c.reason])), { 'claude-main': 'eligible', glm: 'eligible', codex: 'unsupported', deepseek: 'unsupported' });

    jev.reset();
    const withCodex = makeFixture({ providers, runtimes: [CLAUDE_RUNTIME, ['codex-subscription']] });
    const t2 = addTask(withCodex.root, { kind: 'single', duty: 'implement' });
    jev.picks = { model: 'GPT', effort: 'xhigh' };
    const r2 = await run(withCodex, ['--task', t2, '--step', '1', '--duty', 'implement']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual([r2.json().provider, r2.json().model, r2.json().kind, r2.json().effort], ['codex', 'gpt-6-astra', 'codex-subscription', 'xhigh']);
    assert.ok(Object.keys(jev.systemone()[0].body.questions.model.criteria).includes('GPT via codex (codex-subscription)'));

    // answer has no needs: Claude kinds, and openai-compatible only once a runtime lists it; never Codex.
    jev.reset();
    const t3 = addTask(withCodex.root, { kind: 'single', duty: 'answer', title: 'Which port', text: 'Which port does the dev server use?' });
    const r3 = await run(withCodex, ['--task', t3, '--step', '1', '--duty', 'answer']);
    assert.equal(r3.status, 0, r3.stderr);
    const s3 = JSON.parse(jev.systemone()[0].body.state);
    assert.deepEqual(s3.duty, { needs: [], kinds: ['claude-subscription', 'claude-endpoint'] });
    assert.deepEqual(s3.menu.models.map((m) => m.id), ['claude-opus-5-5', 'claude-haiku-5-5', 'glm-5.3']);

    jev.reset();
    const withLlm = makeFixture({ providers, runtimes: [CLAUDE_RUNTIME, ['openai-compatible']] });
    const t4 = addTask(withLlm.root, { kind: 'single', duty: 'answer', title: 'Which port', text: 'Which port does the dev server use?' });
    const r4 = await run(withLlm, ['--task', t4, '--step', '1', '--duty', 'answer']);
    assert.equal(r4.status, 0, r4.stderr);
    const s4 = JSON.parse(jev.systemone()[0].body.state);
    assert.deepEqual(s4.duty.kinds, ['claude-subscription', 'claude-endpoint', 'openai-compatible']);
    assert.ok(s4.menu.models.some((m) => m.id === 'deepseek-chat' && m.kind === 'openai-compatible'));
  });
});

// ---- Jev refusals ------------------------------------------------------------------------------------------------

describe('no Jev, no placement', () => {
  test('no key file: exit 2 "Jev: no key configured", nothing appended, nothing written', async () => {
    jev.reset();
    const fx = makeFixture({ jevKey: false });
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    const lines = readLedger(fx.root).length;
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate', '--json']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), 'Jev: no key configured');
    assert.deepEqual(r.json(), { error: 'Jev: no key configured', exitCode: 2 });
    assert.equal(readLedger(fx.root).length, lines);
    assert.deepEqual(decisionFiles(fx.root), []);
    assert.equal(jev.requests.length, 0);
  });

  test('Jev answering 500 twice is exit 2 "Jev: service unavailable" after one retry; 401 is not retried', async () => {
    jev.reset();
    const fx = makeFixture();
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    const lines = readLedger(fx.root).length;
    jev.queue.push(500, 500);
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^Jev: service unavailable$/m);
    assert.equal(jev.systemone().length, 2);
    assert.equal(readLedger(fx.root).length, lines);
    assert.deepEqual(decisionFiles(fx.root), []);

    jev.reset();
    jev.queue.push(401);
    const auth = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(auth.status, 2);
    assert.match(auth.stderr, /^Jev: authentication failed$/m);
    assert.equal(jev.requests.length, 1);
    assert.equal(readLedger(fx.root).length, lines);
  });

  test('an invalid Jev answer is exit 2 "Jev: invalid response"', async () => {
    jev.reset();
    const fx = makeFixture();
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    const lines = readLedger(fx.root).length;
    jev.queue.push((body, send) => send(200, { model: 'jev-test-1', answers: { model: { type: 'choice', choice: 'Nobody via nowhere (none)', probabilities: { 'Nobody via nowhere (none)': 1 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } }));
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^Jev: invalid response$/m);
    jev.queue.push((body, send) => send(200, 'not json'));
    const r2 = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /^Jev: invalid response$/m);
    assert.equal(readLedger(fx.root).length, lines);
    assert.deepEqual(decisionFiles(fx.root), []);
  });

  test('nothing left to ask: GET /v1/models still checks Jev, and its failure is exit 2', async () => {
    jev.reset();
    const fx = makeFixture({ providers: [{ name: 'claude-main', kind: 'claude-subscription', models: [HAIKU_LOW] }] });
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(withoutLatency(r.json()), { provider: 'claude-main', model: 'claude-haiku-5-5', effort: 'low', kind: 'claude-subscription', probabilities: {}, policyHash: route.loadRouterPolicy(fx.policyFile).hash, step: 1, duty: 'investigate', source: 'jev' });
    assert.deepEqual(jev.requests.map((q) => `${q.method} ${q.path} ${q.authorized}`), ['GET /models true']);
    const placed = lastLine(fx.root);
    assert.equal(placed.data.source, 'jev');
    assert.deepEqual(placed.data.probabilities, {});
    const decision = readDecision(fx.root, placed.data.decisionFile);
    assert.deepEqual(decision.questions, {});
    assert.deepEqual(decision.answers, {});
    assert.equal(decision.calls.length, 1);
    assert.equal(decision.calls[0].check, 'GET /v1/models');
    assert.deepEqual(decision.chosen.choices.model, { source: 'only-option', option: 'Haiku via claude-main (claude-subscription)' });
    assert.deepEqual(decision.chosen.choices.effort, { source: 'only-option', option: 'low' });

    const lines = readLedger(fx.root).length;
    const files = decisionFiles(fx.root);
    jev.reset();
    jev.queue.push(500, 500);
    const down = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(down.status, 2);
    assert.match(down.stderr, /^Jev: service unavailable$/m);
    jev.reset();
    jev.models = ['jev-preview'];
    const unlisted = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(unlisted.status, 2);
    assert.match(unlisted.stderr, /^Jev: the configured model jev-latest is not listed by GET \/v1\/models \(listed: jev-preview\)$/m);
    assert.equal(readLedger(fx.root).length, lines);
    assert.deepEqual(decisionFiles(fx.root), files);
  });

  test('one model with one effort on two providers asks only the provider, with no models check', async () => {
    jev.reset();
    const fx = makeFixture({
      providers: [
        { name: 'claude-main', kind: 'claude-subscription', models: [HAIKU_LOW] },
        { name: 'claude-second', kind: 'claude-subscription', models: 'same as claude-main' },
      ],
    });
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    jev.picks = { provider: 'claude-second' };
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().provider, 'claude-second');
    assert.deepEqual(Object.keys(r.json().probabilities), ['provider']);
    assert.deepEqual(jev.requests.map((q) => q.path), ['/systemone']);
    assert.deepEqual(Object.keys(jev.requests[0].body.questions), ['provider']);
  });
});

// ---- the policy ---------------------------------------------------------------------------------------------------

describe('the policy cannot drift from the providers', () => {
  test('a menu model without a description line is exit 2 before Jev is asked', async () => {
    jev.reset();
    const fx = makeFixture({ policy: (text) => text.replace(/^claude-haiku-5-5: .*\n/m, '') });
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    const lines = readLedger(fx.root).length;
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /has no line in "## model descriptions" for claude-haiku-5-5; add "<model id>: <text>" lines/);
    assert.equal(jev.requests.length, 0);
    assert.equal(readLedger(fx.root).length, lines);
  });

  test('a missing section is exit 2 naming it; an effort in the menu without a guide line is exit 2', async () => {
    jev.reset();
    const noGuide = makeFixture({ policy: (text) => text.replace('## effort guide', '## effort notes') });
    const t1 = addTask(noGuide.root, { kind: 'single', duty: 'investigate' });
    const r1 = await run(noGuide, ['--task', t1, '--step', '1', '--duty', 'investigate']);
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /the section "## effort guide" is missing or empty/);
    const noRules = makeFixture({ policy: (text) => text.replace('## rules', '## notes') });
    const t2 = addTask(noRules.root, { kind: 'single', duty: 'investigate' });
    const r2 = await run(noRules, ['--task', t2, '--step', '1', '--duty', 'investigate']);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /the section "## rules" is missing or empty/);
    const noXhigh = makeFixture({ policy: (text) => text.replace(/^xhigh: .*\n/m, '') });
    const t3 = addTask(noXhigh.root, { kind: 'single', duty: 'investigate' });
    const r3 = await run(noXhigh, ['--task', t3, '--step', '1', '--duty', 'investigate']);
    assert.equal(r3.status, 2);
    assert.match(r3.stderr, /has no line in "## effort guide" for xhigh/);
    assert.equal(jev.requests.length, 0);
  });
});

// ---- efforts and the state --------------------------------------------------------------------------------------

describe('effort mapping', () => {
  test("Jev's effort is mapped onto the chosen model's efforts after the answer", async () => {
    jev.reset();
    const fx = makeFixture({ providers: [{ name: 'claude-main', kind: 'claude-subscription', models: [OPUS, HAIKU] }] });
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    jev.picks = { model: 'Haiku', effort: 'max' };
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().model, 'claude-haiku-5-5');
    assert.equal(r.json().effort, 'medium');
    assert.equal(r.json().probabilities.effort.max, 0.7);
    const placed = lastLine(fx.root);
    assert.equal(placed.data.effort, 'medium');
    const decision = readDecision(fx.root, placed.data.decisionFile);
    assert.equal(decision.chosen.effortRequested, 'max');
    assert.equal(decision.chosen.effort, 'medium');
  });
});

describe('the state', () => {
  test('is capped at 60 000 characters with the task text shortened last', async () => {
    jev.reset();
    const fx = makeFixture();
    const text = `${'The brief goes on. '.repeat(3200)}END`;
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate', text });
    const r = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate']);
    assert.equal(r.status, 0, r.stderr);
    const sent = jev.systemone()[0].body.state;
    assert.ok(sent.length <= 60000, `${sent.length}`);
    assert.ok(sent.length > 59900, `the cut keeps as much text as fits (${sent.length})`);
    const state = JSON.parse(sent);
    assert.ok(state.task.text.endsWith('[Task shortened.]'));
    assert.ok(text.startsWith(state.task.text.slice(0, -'[Task shortened.]'.length)));
    assert.equal(state.rules, route.loadRouterPolicy(fx.policyFile).rules);
    assert.equal(readDecision(fx.root, lastLine(fx.root).data.decisionFile).state, sent);
  });

  test('a retry carries the attempt and the failing report; history holds the last ten placements', async () => {
    jev.reset();
    const fx = makeFixture();
    const other = addTask(fx.root, { title: 'Earlier work' });
    for (let i = 1; i <= 11; i += 1) placedLine(fx.root, other, 1, 'plan', { model: `old-${i}` });
    const task = featureAfterPlan(fx.root);
    placedLine(fx.root, task, 2, 'implement', { model: 'claude-sonnet-5-5', effort: 'medium' });
    started(fx.root, task, 2, 'implement');
    report(fx.root, task, 2, { summary: 'Implemented the README section.' });
    add(fx.root, task, 'step.done', { ordinal: 2 }, 2);
    placedLine(fx.root, task, 3, 'verify');
    started(fx.root, task, 3, 'verify');
    report(fx.root, task, 3, { summary: 'Two tests fail: the totals are off by one.', testsRun: { command: 'npm test', passed: false, summary: '2 failing' } });
    add(fx.root, task, 'step.retrying', { ordinal: 3, attempt: 1, gotoOrdinal: 2, reason: 'tests failed' }, 3);
    const r = await run(fx, ['--task', task, '--step', '2', '--duty', 'implement']);
    assert.equal(r.status, 0, r.stderr);
    const state = JSON.parse(jev.systemone()[0].body.state);
    assert.equal(state.step.attempt, 2);
    assert.equal(state.step.failure, 'Two tests fail: the totals are off by one.');
    assert.deepEqual(state.step.previous.map((p) => p.duty), ['plan']);
    assert.equal(state.history.recent.length, 10);
    assert.deepEqual(state.history.recent.slice(-3), [
      { duty: 'plan', model: 'claude-opus-5-5', effort: 'high', outcome: 'done', attempts: 1 },
      { duty: 'implement', model: 'claude-sonnet-5-5', effort: 'medium', outcome: 'done', attempts: 1 },
      { duty: 'verify', model: 'claude-opus-5-5', effort: 'high', outcome: 'failed', attempts: 1 },
    ]);
    assert.equal(state.history.recent[0].model, 'old-5');
    assert.equal(lastLine(fx.root).data.attempt, 2);
  });
});

// ---- workflow questions -------------------------------------------------------------------------------------------

describe('--questions', () => {
  test('one noul question per line of the questions section; a decision file of kind workflow; nothing appended', async () => {
    jev.reset();
    const fx = makeFixture();
    const task = addTask(fx.root);
    const lines = readLedger(fx.root).length;
    jev.picks = { needs_plan: 0.8, needs_docs: 0.3 };
    const r = await run(fx, ['--task', task, '--questions']);
    assert.equal(r.status, 0, r.stderr);
    const policy = route.loadRouterPolicy(fx.policyFile);
    const out = r.json();
    assert.deepEqual(withoutLatency(out), { needs_plan: true, needs_docs: false, probabilities: { needs_plan: 0.8, needs_docs: 0.3 }, policyHash: policy.hash });
    assert.ok(Number.isInteger(out.latencyMs));
    const calls = jev.systemone();
    assert.equal(calls.length, 1);
    const plan = policy.questions.get('needs_plan');
    assert.deepEqual(calls[0].body.questions.needs_plan, { type: 'noul', instructions: plan.question, criteria: { true: plan.true, false: plan.false } });
    assert.deepEqual(Object.keys(calls[0].body.questions), [...policy.questions.keys()]);
    const state = JSON.parse(calls[0].body.state);
    assert.deepEqual(Object.keys(state), ['project', 'task', 'rules']);
    assert.equal(state.task.id, task);
    assert.equal(readLedger(fx.root).length, lines);
    const files = decisionFiles(fx.root);
    assert.equal(files.length, 1);
    assert.match(files[0], new RegExp(`^${task}-workflow-\\d{8}T\\d{9}Z\\.json$`));
    const decision = readDecision(fx.root, path.join('.jevellan', 'decisions', files[0]));
    assert.equal(decision.kind, 'workflow');
    assert.equal(decision.state, calls[0].body.state);
    assert.deepEqual(decision.chosen.answers.needs_plan, { value: true, probability: 0.8 });

    jev.reset();
    jev.picks = { needs_plan: 0.5, needs_docs: 0.49 };
    const edge = await run(fx, ['--task', task, '--questions']);
    assert.equal(edge.status, 0, edge.stderr);
    assert.equal(edge.json().needs_plan, true, 'a noul at 0.5 is true');
    assert.equal(edge.json().needs_docs, false);

    const bad = await run(fx, ['--task', task, '--questions', '--step', '1']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--questions takes no --step, --duty or --owner/);
  });
});

// ---- the owner's placement ---------------------------------------------------------------------------------------

describe('--owner', () => {
  test('is validated against providers.json, asks no Jev and writes task.placed with source owner', async () => {
    jev.reset();
    const fx = makeFixture({
      providers: [
        { name: 'claude-main', kind: 'claude-subscription', models: [OPUS, HAIKU] },
        { name: 'codex', kind: 'codex-subscription', models: [GPT] },
      ],
      state: { 'claude-main': { weeklyPct: 95 } },
    });
    const task = featureAfterPlan(fx.root);
    const r = await run(fx, ['--task', task, '--step', '2', '--duty', 'implement', '--owner', 'claude-main/claude-opus-5-5/xhigh']);
    assert.equal(r.status, 0, r.stderr);
    const policyHash = route.loadRouterPolicy(fx.policyFile).hash;
    assert.deepEqual(r.json(), { provider: 'claude-main', model: 'claude-opus-5-5', effort: 'xhigh', kind: 'claude-subscription', probabilities: {}, latencyMs: 0, policyHash, step: 2, duty: 'implement', source: 'owner' });
    const placed = lastLine(fx.root);
    assert.equal(placed.kind, 'task.placed');
    assert.deepEqual(placed.data, { step: 2, duty: 'implement', provider: 'claude-main', model: 'claude-opus-5-5', effort: 'xhigh', kind: 'claude-subscription', probabilities: {}, latencyMs: 0, policyHash, source: 'owner', attempt: 1, providerReason: 'usage-ceiling' });
    assert.equal(jev.requests.length, 0);
    assert.deepEqual(decisionFiles(fx.root), []);

    const mapped = await run(fx, ['--task', task, '--step', '2', '--duty', 'implement', '--owner', 'claude-main/claude-haiku-5-5/max']);
    assert.equal(mapped.status, 0, mapped.stderr);
    assert.equal(mapped.json().effort, 'medium');
    assert.equal(lastLine(fx.root).data.effortRequested, 'max');

    const lines = readLedger(fx.root).length;
    const refusals = [
      ['nobody/claude-opus-5-5/high', 3, /no provider nobody in /],
      ['claude-main/gpt-6-astra/high', 2, /provider claude-main does not serve the model gpt-6-astra/],
      ['codex/gpt-6-astra/high', 2, /provider codex is kind codex-subscription, which cannot run the duty implement here/],
      ['claude-main/claude-opus-5-5', 2, /--owner needs <provider>\/<model>\/<effort>/],
      ['claude-main/claude-opus-5-5/huge', 2, /unknown effort huge/],
    ];
    for (const [owner, code, pattern] of refusals) {
      const bad = await run(fx, ['--task', task, '--step', '2', '--duty', 'implement', '--owner', owner]);
      assert.equal(bad.status, code, `${owner}: ${bad.stderr}`);
      assert.match(bad.stderr, pattern);
    }
    assert.equal(readLedger(fx.root).length, lines);
  });
});

// ---- the task input ------------------------------------------------------------------------------------------------

describe('the task', () => {
  test('--task and --task-file give the same result', async () => {
    const id = 'TFXD0K1';
    const build = () => {
      const fx = makeFixture({
        providers: [
          { name: 'claude-main', kind: 'claude-subscription', models: [OPUS, HAIKU] },
          { name: 'claude-second', kind: 'claude-subscription', models: 'same as claude-main' },
        ],
        state: { 'claude-second': { weeklyPct: 30 } },
      });
      addTask(fx.root, { id });
      add(fx.root, id, 'task.workflow', { steps: FEATURE_STEPS, skipped: [1], questions: { needs_plan: false, needs_docs: false } });
      return fx;
    };
    const a = build();
    const b = build();
    const show = await runNode(a.ledgerCli, ['show', id, '--json'], { cwd: a.root, env: { JH_HARNESS_HOME: a.home } });
    assert.equal(show.status, 0, show.stderr);
    const file = path.join(tempDir('jh-task-file-'), 'task.json');
    writeJson(file, { ...show.json(), step: 2, duty: 'implement', note: 'extra keys are ignored' });

    jev.reset();
    jev.picks = { model: 'Opus', effort: 'high', provider: 'claude-second' };
    const fromFile = await run(a, ['--task-file', file, '--step', '2', '--duty', 'implement']);
    assert.equal(fromFile.status, 0, fromFile.stderr);
    const bodiesA = jev.systemone().map((q) => q.body);
    jev.reset();
    jev.picks = { model: 'Opus', effort: 'high', provider: 'claude-second' };
    const fromLedger = await run(b, ['--task', id, '--step', '2', '--duty', 'implement']);
    assert.equal(fromLedger.status, 0, fromLedger.stderr);
    const bodiesB = jev.systemone().map((q) => q.body);
    assert.deepEqual(withoutLatency(fromFile.json()), withoutLatency(fromLedger.json()));
    assert.equal(bodiesA.length, 2);
    assert.deepEqual(bodiesA, bodiesB);
    const state = JSON.parse(bodiesA[0].state);
    assert.deepEqual(state.step.previous, [{ duty: 'plan', status: 'skipped', summary: 'Jev: not needed' }]);
    const strip = (e) => ({ ...e.data, latencyMs: 0, decisionFile: e.data.decisionFile.replace(/-s2-.*$/, '') });
    assert.deepEqual(strip(lastLine(a.root)), strip(lastLine(b.root)));
  });

  test('refuses a task file that cannot be read or names no task of this ledger, and a missing or second task flag', async () => {
    jev.reset();
    const fx = makeFixture();
    const dir = tempDir('jh-task-file-');
    const write = (name, text) => {
      fs.writeFileSync(path.join(dir, name), text);
      return path.join(dir, name);
    };
    const task = addTask(fx.root, { kind: 'single', duty: 'investigate' });
    const cases = [
      [['--task-file', path.join(dir, 'missing.json')], 2, /cannot read --task-file .*missing\.json: ENOENT/],
      [['--task-file', write('bad.json', '{not json')], 2, /is not JSON/],
      [['--task-file', write('list.json', '[]')], 2, /must hold one JSON object/],
      [['--task-file', write('noid.json', '{"title":"x"}')], 2, /names no task id/],
      [['--task-file', write('other.json', '{"task":"T000000"}')], 3, /no task T000000 in this project's ledger/],
      [['--task', 'T000000'], 3, /no task T000000 in this project's ledger/],
      [['--task', 'nope'], 2, /"nope" is not a task id/],
      [['--task', task, '--task-file', write('ok.json', JSON.stringify({ task }))], 2, /give --task-file <file> or --task T, one of them/],
      [[], 2, /give --task-file <file> or --task T, one of them/],
    ];
    for (const [args, code, pattern] of cases) {
      const r = await run(fx, [...args, '--step', '1', '--duty', 'investigate']);
      assert.equal(r.status, code, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, pattern);
    }
    const noStep = await run(fx, ['--task', task, '--duty', 'investigate']);
    assert.equal(noStep.status, 2);
    assert.match(noStep.stderr, /--step must be a positive integer/);
    const unknown = await run(fx, ['--task', task, '--step', '1', '--duty', 'investigate', '--colour', 'blue']);
    assert.equal(unknown.status, 2);
    assert.equal(jev.requests.length, 0);
  });

  test('refuses a duty with no installed skill, no runtime skill at all, and a duty the workflow does not give the step', async () => {
    jev.reset();
    const fx = makeFixture({ duties: ['plan', 'implement'] });
    const task = featureAfterPlan(fx.root);
    const noDuty = await run(fx, ['--task', task, '--step', '3', '--duty', 'verify']);
    assert.equal(noDuty.status, 2);
    assert.equal(noDuty.stderr.trim(), 'no installed skill has the role duty (duty verify); tell the owner which role is missing and do not improvise it');
    const wrong = await run(fx, ['--task', task, '--step', '2', '--duty', 'verify']);
    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, new RegExp(`step 2 of ${task} is duty implement, not verify`));
    const noRuntime = makeFixture({ runtimes: [] });
    const t2 = addTask(noRuntime.root, { kind: 'single', duty: 'investigate' });
    const r = await run(noRuntime, ['--task', t2, '--step', '1', '--duty', 'investigate']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), 'no installed skill has the role runtime; tell the owner which role is missing and do not improvise it');
    assert.equal(jev.requests.length, 0);
  });
});
