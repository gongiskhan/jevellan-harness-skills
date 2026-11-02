// The git skill's land.mjs and its evals, run as child processes from temporary projects the way a coordinator runs
// them: the git, placement and ledger skills are copied into the project's .claude/skills (land.mjs reaches the Jev
// client, the policy parser and the providers file through the placement role), the project has a bare "remote",
// tasks and their steps are written through the ledger library, worktrees are made with worktree.mjs, and Jev is a
// fake server on 127.0.0.1 (JH_JEV_URL) whose answer each test chooses.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HARNESS_HOME, NODE, REPO, TaskScript, childEnv, deadPid, git, makeRepo, readLedger, tempDir, writeJson } from './helpers/ledger-fixture.mjs';
import { newTaskId } from '../skills/jevellan-ledger/scripts/lib/ids.mjs';

const GITCONFIG = path.join(tempDir('jh-gitconfig-'), 'gitconfig');
fs.writeFileSync(GITCONFIG, '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n');
const GIT_ENV = { GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1' };

// The key is a fixture value in the temporary harness home, never a real one.
const KEY = `fixture-jev-key-${crypto.randomBytes(8).toString('hex')}`;
function writeProviders(home, keyFile) {
  writeJson(path.join(home, 'providers.json'), {
    jev: { keyFile, model: 'jev-test', timeoutMs: 15000 },
    providers: [{ name: 'claude-main', kind: 'claude-subscription', models: [{ id: 'claude-test', label: 'Test', efforts: ['low'] }] }],
  });
}
fs.mkdirSync(path.join(HARNESS_HOME, 'secrets'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(HARNESS_HOME, 'secrets', 'jev.key'), `${KEY}\n`, { mode: 0o600 });
writeProviders(HARNESS_HOME, path.join(HARNESS_HOME, 'secrets', 'jev.key'));

const POLICY = fs.readFileSync(path.join(REPO, 'skills', 'jevellan-git', 'SKILL.md'), 'utf8');
const POLICY_BODY = POLICY.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
const section = (name) => new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(POLICY_BODY)[1].trim();
const CRITERIA = Object.fromEntries(section('routes').split('\n').map((l) => /^([a-z-]+): (.*)$/.exec(l)).map((m) => [m[1], m[2]]));

// ---- the fake Jev ----------------------------------------------------------------------------------------------

const jev = { route: 'land', calls: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method !== 'POST' || req.url !== '/v1/systemone') {
      res.writeHead(404).end();
      return;
    }
    const request = JSON.parse(body);
    jev.calls.push({ request, authorized: req.headers.authorization === `Bearer ${KEY}` });
    const route = jev.route;
    const probabilities = { land: 0.1, 'verify-then-land': 0.1, 'ask-owner': 0.1, [route]: 0.8 };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-fake-1',
      answers: { landing_route: { type: 'choice', choice: route, probabilities, confidence: 0.8 } },
      usage: { input_tokens: 100, output_tokens: 3 },
    }));
  });
});
let JEV_URL = null;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  JEV_URL = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => server.close());

// ---- fixtures --------------------------------------------------------------------------------------------------

function makeProject({ config = {} } = {}) {
  const root = makeRepo();
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '.claude/\n.jevellan/\nplan.md\n');
  const bare = tempDir('jh-remote-');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', 'origin', 'main');
  writeJson(path.join(root, '.jevellan', 'project.json'), {
    name: path.basename(root), defaultBranch: 'main', testCommand: null, riskyPaths: [], checks: ['echo checks-ok'], pushAfterLanding: false, retentionDays: 3, ...config,
  });
  for (const skill of ['jevellan-git', 'jevellan-router', 'jevellan-ledger']) {
    fs.cpSync(path.join(REPO, 'skills', skill), path.join(root, '.claude', 'skills', skill), { recursive: true });
  }
  return { root, bare };
}

function newTask(root, { kind = 'feature', title = 'Add a How to run section', parent = null } = {}) {
  const t = Object.create(TaskScript.prototype);
  Object.assign(t, { root, session: 'coord-test', task: newTaskId(), kind });
  t.created = t.add('task.created', { kind, title, text: `Brief for ${title}`, parent, after: null, origin: 'owner' });
  return t;
}

function runScript(root, relative, args, { env = {}, cwd } = {}) {
  const script = path.join(root, '.claude', 'skills', 'jevellan-git', ...relative.split('/'));
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [script, ...args], { cwd: cwd ?? root, env: childEnv({ ...GIT_ENV, JH_JEV_URL: JEV_URL, ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) }));
  });
}

const land = (root, task, extra = [], options) => runScript(root, 'scripts/land.mjs', ['--task', task, ...extra], options);
const sha = (cwd, ref) => git(cwd, 'rev-parse', ref).trim();
const commit = (cwd, files, message = 'work') => {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '--no-verify', '-m', message);
  return sha(cwd, 'HEAD');
};

async function worktree(root, task) {
  const r = await runScript(root, 'scripts/worktree.mjs', ['create', '--task', task, '--json']);
  assert.equal(r.status, 0, r.stderr);
  return r.json();
}

// A feature task whose worktree holds one commit and whose implement and verify steps are done.
async function readyTask(root, { title, parent, files = { 'docs/run.md': '# How to run\n\nnpm start\n' }, verifyPassed = true } = {}) {
  const t = newTask(root, { title, parent });
  const wt = await worktree(root, t.task);
  const head = commit(wt.path, files, `work on ${t.task}`);
  t.workflow([{ ordinal: 1, duty: 'implement' }, { ordinal: 2, duty: 'verify', onFail: { goto: 1, maxLoops: 2 } }]);
  t.stepDone(1, { duty: 'implement' });
  t.started(2, { duty: 'verify' });
  t.report(2, { summary: 'Verified the change.', testsRun: { command: 'npm test', passed: verifyPassed, summary: 'all passed' } });
  t.done(2);
  return { t, wt, head };
}

const kinds = (root, task) => readLedger(root).filter((e) => e.task === task).map((e) => e.kind);
const lastOf = (root, task, kind) => readLedger(root).filter((e) => e.task === task && e.kind === kind).at(-1);

// ---- refusals --------------------------------------------------------------------------------------------------

describe('land.mjs refusals', () => {
  test('steps that are not done refuse, naming them, before asking Jev', async () => {
    const { root } = makeProject();
    const t = newTask(root);
    const wt = await worktree(root, t.task);
    commit(wt.path, { 'a.txt': 'a\n' });
    t.workflow([{ ordinal: 1, duty: 'implement' }, { ordinal: 2, duty: 'verify' }, { ordinal: 3, duty: 'document' }], [3]);
    t.stepDone(1, { duty: 'implement' });
    t.started(2, { duty: 'verify', pid: deadPid() });
    const calls = jev.calls.length;
    const before = readLedger(root).length;
    const r = await land(root, t.task, ['--json']);
    assert.equal(r.status, 2);
    assert.match(r.json().error, new RegExp(`task ${t.task} has steps that are not done or skipped: 2 verify \\(running\\)$`));
    assert.equal(jev.calls.length, calls);
    assert.equal(readLedger(root).length, before);

    const noWorkflow = newTask(root, { title: 'No workflow' });
    const r2 = await land(root, noWorkflow.task);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /has no workflow yet/);
    const unknown = await land(root, 'T000000');
    assert.equal(unknown.status, 3);
  });

  test('uncommitted changes refuse, naming them; evidence, report, plan and the .claude link never count', async () => {
    const { root } = makeProject();
    const { t, wt } = await readyTask(root);
    fs.mkdirSync(path.join(wt.path, '.jevellan', 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(wt.path, '.jevellan', 'evidence', 'shot.png'), 'png');
    fs.writeFileSync(path.join(wt.path, '.jevellan', 'report.json'), '{}');
    fs.writeFileSync(path.join(wt.path, 'plan.md'), '# plan\n');
    fs.writeFileSync(path.join(wt.path, 'docs', 'run.md'), 'changed after the commit\n');
    fs.writeFileSync(path.join(wt.path, 'scratch.txt'), 'untracked\n');
    const before = readLedger(root).length;
    const r = await land(root, t.task);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `the worktree ${wt.path} has uncommitted changes: docs/run.md, scratch.txt. Commit or discard them first\n`);
    assert.equal(readLedger(root).length, before);
  });

  test('Jev without a key is exit 2 "Jev: no key configured" and nothing is written', async () => {
    const { root } = makeProject();
    const { t } = await readyTask(root);
    const home = tempDir('jh-harness-nokey-');
    writeProviders(home, path.join(home, 'secrets', 'missing.key'));
    const before = readLedger(root).length;
    const r = await land(root, t.task, ['--json'], { env: { JH_HARNESS_HOME: home } });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'Jev: no key configured\n');
    assert.deepEqual(r.json(), { error: 'Jev: no key configured', exitCode: 2 });
    assert.equal(readLedger(root).length, before);
    assert.equal(fs.existsSync(path.join(root, '.jevellan', 'decisions')), false);
    assert.equal(sha(root, 'main'), sha(root, 'origin/main'));
  });
});

// ---- the land route --------------------------------------------------------------------------------------------

describe('land.mjs route land', () => {
  test('merges the moved default branch, runs the checks, fast-forwards the checked-out main and records it all', async () => {
    const { root, bare } = makeProject({ config: { riskyPaths: ['src/billing'], checks: ['echo checks-ok', { name: 'second', command: 'echo second-ok', timeoutMs: 60000 }] } });
    const { t, wt, head } = await readyTask(root, { files: { 'docs/run.md': '# How to run\n\nnpm start\n', 'src/billing/rates.js': 'export const rate = 1;\n' } });
    t.retrying(2, 1, 1, 'verify failed: one test was red');
    t.stepDone(1, { duty: 'implement' });
    t.started(2, { duty: 'verify' });
    t.report(2, { summary: 'Verified again.', testsRun: { command: 'npm test', passed: true, summary: '12 passed' } });
    t.done(2);
    const moved = commit(root, { 'CHANGELOG.md': 'main moved\n' }, 'main moves on');
    const remoteMain = sha(bare, 'main');
    jev.route = 'land';
    const calls = jev.calls.length;

    const r = await land(root, t.task, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = r.json();
    assert.equal(out.landed, true);
    assert.equal(out.target, 'main');
    assert.equal(out.method, 'merge --ff-only');
    assert.equal(out.forced, false);
    assert.deepEqual(out.checks.map((c) => [c.name, c.passed]), [['echo checks-ok', true], ['second', true]]);

    // main is the merge of main into the task branch, checked out in the project's own folder.
    assert.equal(sha(root, 'main'), out.commit);
    assert.equal(sha(root, 'HEAD'), out.commit);
    assert.equal(git(root, 'log', '-1', '--format=%P', out.commit).trim(), `${head} ${moved}`);
    assert.equal(git(root, 'log', '-1', '--format=%s|%an', out.commit).trim(), `Merge main into ${wt.branch}|Test`);
    assert.ok(fs.existsSync(path.join(root, 'docs', 'run.md')));
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.equal(sha(bare, 'main'), remoteMain, 'pushAfterLanding false never pushes');

    // One Jev call with the landing policy and the landing state.
    assert.equal(jev.calls.length, calls + 1);
    const call = jev.calls.at(-1);
    assert.equal(call.authorized, true);
    assert.equal(call.request.model, 'jev-test');
    assert.deepEqual(call.request.questions, { landing_route: { type: 'choice', instructions: section('landing_route'), criteria: CRITERIA } });
    const state = JSON.parse(call.request.state);
    assert.equal(state.schema, 'landing-route-state-v1');
    assert.deepEqual(state.project, { name: path.basename(root), guidance: '' });
    assert.equal(state.title, 'Add a How to run section');
    assert.deepEqual(state.task, { id: t.task, kind: 'feature', text: 'Brief for Add a How to run section' });
    assert.deepEqual(state.summaries, [{ duty: 'implement', summary: 'Step 1 finished.' }, { duty: 'verify', summary: 'Verified again.' }]);
    assert.deepEqual(state.riskyAreas, ['src/billing']);
    assert.deepEqual(state.files.map((f) => [f.path, f.additions, f.deletions, f.risky]), [['docs/run.md', 3, 0, false], ['src/billing/rates.js', 1, 0, true]]);
    assert.equal(state.files[0].bytes, '# How to run\n\nnpm start\n'.length);
    assert.deepEqual(state.totals, { files: 2, additions: 4, deletions: 0, filesOmitted: 0 });
    assert.deepEqual(state.checks.map((c) => [c.duty, c.command, c.passed, c.summary]), [['verify', 'npm test', true, '12 passed']]);
    assert.deepEqual(state.corrections, ['verify failed (attempt 1): verify failed: one test was red']);
    assert.equal(state.rules, section('rules'));

    // The ledger: landing.decided with the decision file, a landing.checked per check, task.landed.
    const decided = lastOf(root, t.task, 'landing.decided');
    assert.deepEqual(Object.keys(decided.data).sort(), ['decisionFile', 'jevModel', 'latencyMs', 'policyHash', 'probabilities', 'reason', 'route', 'source']);
    assert.equal(decided.data.route, 'land');
    assert.deepEqual(decided.data.probabilities, { land: 0.8, 'verify-then-land': 0.1, 'ask-owner': 0.1 });
    assert.equal(decided.data.reason, CRITERIA.land);
    assert.equal(decided.data.policyHash, crypto.createHash('sha256').update(POLICY_BODY).digest('hex'));
    assert.equal(decided.data.source, 'jev');
    assert.equal(decided.data.jevModel, 'jev-test');
    assert.ok(Number.isInteger(decided.data.latencyMs));
    assert.match(decided.data.decisionFile, new RegExp(`^\\.jevellan/decisions/${t.task}-landing-\\d{8}T\\d{9}Z\\.json$`));
    const decision = JSON.parse(fs.readFileSync(path.join(root, decided.data.decisionFile), 'utf8'));
    assert.equal(decision.kind, 'landing');
    assert.equal(decision.task, t.task);
    assert.equal(decision.answeredBy, 'jev-fake-1');
    assert.deepEqual(decision.state, state);
    assert.deepEqual(decision.chosen, { route: 'land', probabilities: decided.data.probabilities, reason: CRITERIA.land, source: 'jev' });
    assert.equal(JSON.stringify(decision).includes(KEY), false);

    const checked = readLedger(root).filter((e) => e.task === t.task && e.kind === 'landing.checked');
    assert.deepEqual(checked.map((e) => [e.data.command, e.data.passed, e.data.tail]), [['echo checks-ok', true, 'checks-ok\n'], ['echo second-ok', true, 'second-ok\n']]);
    assert.deepEqual(lastOf(root, t.task, 'task.landed').data, { commit: out.commit, target: 'main', method: 'merge --ff-only' });
    assert.deepEqual(kinds(root, t.task).slice(-4), ['landing.decided', 'landing.checked', 'landing.checked', 'task.landed']);

    // Landed is landed: a second call says so and asks nobody.
    const again = await land(root, t.task);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, `${t.task} already landed at ${out.commit.slice(0, 12)} on main.\n`);
    assert.equal(jev.calls.length, calls + 1);
  });

  test('a failing check is exit 2 with its tail, recorded, and main does not move', async () => {
    const { root } = makeProject({ config: { checks: ['echo first-ok', 'echo boom-out; echo boom-err >&2; exit 3'] } });
    const { t } = await readyTask(root);
    jev.route = 'land';
    const main = sha(root, 'main');
    const r = await land(root, t.task);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^check echo boom-out; echo boom-err >&2; exit 3 failed \(exit 3\); main did not move\. Output tail:\n/);
    assert.match(r.stderr, /boom-out\nboom-err\n/);
    const checked = readLedger(root).filter((e) => e.task === t.task && e.kind === 'landing.checked');
    assert.deepEqual(checked.map((e) => e.data.passed), [true, false]);
    assert.equal(sha(root, 'main'), main);
    assert.equal(kinds(root, t.task).includes('task.landed'), false);
    assert.equal(t.view().state, 'failed');
  });

  test('with another branch checked out, the main ref moves by push . and the working tree is left alone', async () => {
    const { root } = makeProject({ config: { checks: [], testCommand: 'echo tests-pass' } });
    const { t, head } = await readyTask(root);
    git(root, 'checkout', '-q', '-b', 'owner-side');
    jev.route = 'land';
    const r = await land(root, t.task, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().method, 'push .');
    assert.equal(sha(root, 'main'), head, 'a branch with everything of main fast-forwards, no merge commit');
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD').trim(), 'owner-side');
    assert.equal(fs.existsSync(path.join(root, 'docs', 'run.md')), false);
    assert.deepEqual(readLedger(root).filter((e) => e.task === t.task && e.kind === 'landing.checked').map((e) => e.data.command), ['echo tests-pass']);
    assert.deepEqual(lastOf(root, t.task, 'task.landed').data, { commit: head, target: 'main', method: 'push .' });
  });

  test('a checked-out main with uncommitted changes in the touched files refuses, naming them', async () => {
    const { root } = makeProject({ config: { checks: [] } });
    const { t } = await readyTask(root);
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'run.md'), 'the owner was writing this\n');
    const main = sha(root, 'main');
    jev.route = 'land';
    const r = await land(root, t.task);
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(`has main checked out with uncommitted changes in files the task changes: docs/run\\.md\\. Commit or move them away, then land again; main did not move`));
    assert.equal(sha(root, 'main'), main);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'run.md'), 'utf8'), 'the owner was writing this\n');
  });

  test('pushAfterLanding true pushes main to origin after landing', async () => {
    const { root, bare } = makeProject({ config: { pushAfterLanding: true, checks: [] } });
    const { t } = await readyTask(root);
    jev.route = 'land';
    const r = await land(root, t.task, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json().push, { pushed: true, detail: 'pushed main to origin' });
    assert.equal(sha(bare, 'main'), r.json().commit);
  });

  test('checks get only the base environment, the owner\'s HOME and the git identity; secrets in a tail are masked', async () => {
    const { root } = makeProject({ config: { checks: ['env', 'echo API_TOKEN=abcdefgh12345678'] } });
    const { t } = await readyTask(root);
    jev.route = 'land';
    const r = await land(root, t.task, [], { env: { LANG: 'C.UTF-8', SOME_PROVIDER_TOKEN: 'zzzzzzzzzzzzzzzz' } });
    assert.equal(r.status, 0, r.stderr);
    const [envCheck, secretCheck] = readLedger(root).filter((e) => e.task === t.task && e.kind === 'landing.checked');
    // The ledger's redactor writes NAME=value as NAME:[redacted] when the name says AUTH, so GIT_AUTHOR_* read that way.
    const vars = Object.fromEntries(envCheck.data.tail.trim().split('\n').map((l) => /^([A-Za-z_][A-Za-z0-9_]*)[=:](.*)$/.exec(l)).map((m) => [m[1], m[2]]));
    const allowed = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL', 'PLAYWRIGHT_BROWSERS_PATH', 'PWD', 'OLDPWD', 'SHLVL', '_'];
    assert.deepEqual(Object.keys(vars).filter((k) => !allowed.includes(k)), []);
    assert.equal(vars.HOME, os.userInfo().homedir);
    assert.equal(vars.LANG, 'C.UTF-8');
    assert.equal(vars.GIT_COMMITTER_NAME, 'Test');
    assert.equal(vars.GIT_COMMITTER_EMAIL, 'test@example.com');
    assert.ok('GIT_AUTHOR_NAME' in vars && 'GIT_AUTHOR_EMAIL' in vars);
    assert.equal(secretCheck.data.tail, 'API_TOKEN:[redacted]\n');
  });

  test('a dead holder\'s landing lock is taken over', async () => {
    const { root } = makeProject({ config: { checks: [] } });
    const { t } = await readyTask(root);
    fs.mkdirSync(path.join(root, '.jevellan', 'locks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.jevellan', 'locks', 'landing.lock'), `${deadPid()} ${Date.now()}`);
    jev.route = 'land';
    const r = await land(root, t.task);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(root, '.jevellan', 'locks', 'landing.lock')), false, 'released after landing');
  });
});

// ---- the other routes ------------------------------------------------------------------------------------------

describe('land.mjs routes verify-then-land and ask-owner, --force and conflicts', () => {
  test('verify-then-land exits 6; after one more verify step the next call lands without asking Jev again', async () => {
    const { root } = makeProject();
    const { t } = await readyTask(root);
    jev.route = 'verify-then-land';
    const calls = jev.calls.length;
    const r = await land(root, t.task);
    assert.equal(r.status, 6, r.stderr);
    assert.equal(r.stdout, '{"route":"verify-then-land"}\n');
    assert.equal(jev.calls.length, calls + 1);
    assert.equal(lastOf(root, t.task, 'landing.decided').data.reason, CRITERIA['verify-then-land']);

    // Before the verify step ran: exit 6 again, and Jev is not asked again.
    const early = await land(root, t.task, ['--json']);
    assert.equal(early.status, 6);
    assert.deepEqual(early.json(), { route: 'verify-then-land', task: t.task, reason: CRITERIA['verify-then-land'], instructions: 'Full verification before landing: run the whole test command and every browser journey the change could affect.', again: true });

    // A verify step that started and is still running: refused, nothing moves.
    t.started(3, { duty: 'verify', pid: deadPid() });
    const running = await land(root, t.task);
    assert.equal(running.status, 2);
    assert.match(running.stderr, /steps that are not done or skipped: 3 verify \(running\)/);

    t.report(3, { summary: 'Full verification passed.', testsRun: { command: 'npm test', passed: true, summary: 'all 40 passed' } });
    t.done(3);
    jev.route = 'ask-owner'; // would be wrong if asked: the second call must not ask
    const second = await land(root, t.task, ['--json']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json().reason, 'verified before landing (step 3)');
    assert.equal(jev.calls.length, calls + 1);
    assert.equal(readLedger(root).filter((e) => e.task === t.task && e.kind === 'landing.decided').length, 1);
    assert.equal(lastOf(root, t.task, 'task.landed').data.target, 'main');
    assert.equal(t.view().state, 'done');
  });

  test('ask-owner exits 7 with task.asked; --force then lands without Jev', async () => {
    const { root } = makeProject();
    const { t } = await readyTask(root, { title: 'Change the billing rounding' });
    jev.route = 'ask-owner';
    const calls = jev.calls.length;
    const r = await land(root, t.task, ['--json']);
    assert.equal(r.status, 7, r.stderr);
    const question = `Land Change the billing rounding? ${CRITERIA['ask-owner']}`;
    assert.deepEqual(r.json(), { task: t.task, route: 'ask-owner', question, options: ['Land now', 'Leave it'], reason: CRITERIA['ask-owner'] });
    assert.deepEqual(lastOf(root, t.task, 'task.asked').data, { question, options: ['Land now', 'Leave it'], reason: CRITERIA['ask-owner'] });
    assert.equal(t.view().state, 'waiting-owner');
    const main = sha(root, 'main');
    assert.equal(main, sha(root, 'origin/main'), 'nothing moved');

    const forced = await land(root, t.task, ['--force', '--json']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(forced.json().forced, true);
    assert.equal(jev.calls.length, calls + 1, '--force asks nobody');
    assert.deepEqual(lastOf(root, t.task, 'landing.decided').data, { route: 'land', source: 'owner', reason: 'the owner said Land now' });
    assert.equal(sha(root, 'main'), forced.json().commit);
    assert.equal(t.view().state, 'done');
  });

  test('--force still refuses steps that are not done and a dirty worktree', async () => {
    const { root } = makeProject();
    const { t, wt } = await readyTask(root);
    fs.writeFileSync(path.join(wt.path, 'loose.txt'), 'x\n');
    const r = await land(root, t.task, ['--force']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /uncommitted changes: loose\.txt/);
    fs.renameSync(path.join(wt.path, 'loose.txt'), path.join(tempDir('jh-moved-'), 'loose.txt'));
    t.started(3, { duty: 'document' });
    const r2 = await land(root, t.task, ['--force']);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /3 document \(running\)/);
    assert.equal(kinds(root, t.task).includes('landing.decided'), false);
  });

  test('a merge conflict aborts the merge and asks the owner; under --force it asks for an implement step', async () => {
    const { root } = makeProject();
    const { t, wt, head } = await readyTask(root, { files: { 'README.md': '# fixture\n\nfrom the task\n' } });
    commit(root, { 'README.md': '# fixture\n\nfrom main\n' }, 'main edits the README');
    const main = sha(root, 'main');
    jev.route = 'land';
    const r = await land(root, t.task, ['--json']);
    assert.equal(r.status, 7, r.stderr);
    assert.equal(r.json().reason, 'merge conflict in README.md');
    assert.equal(r.json().question, 'Land Add a How to run section? merge conflict in README.md');
    assert.equal(lastOf(root, t.task, 'task.asked').data.reason, 'merge conflict in README.md');
    assert.equal(sha(wt.path, 'HEAD'), head, 'the merge was aborted');
    assert.equal(fs.existsSync(path.join(root, '.git', 'worktrees', path.basename(wt.path), 'MERGE_HEAD')), false);
    assert.equal(git(wt.path, 'status', '--porcelain'), '');
    assert.equal(sha(root, 'main'), main);

    const forced = await land(root, t.task, ['--force']);
    assert.equal(forced.status, 2);
    assert.match(forced.stderr, new RegExp(`^merging main into ${wt.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} conflicts in README\\.md; the merge was aborted and nothing moved\\.`));
    assert.match(forced.stderr, /run one implement step in the task's worktree with these instructions, record its step\.done, then run land\.mjs --task T.{6} --force again/);
    assert.equal(sha(wt.path, 'HEAD'), head);
    assert.equal(git(wt.path, 'status', '--porcelain'), '');
    assert.equal(sha(root, 'main'), main);
  });

  test('a child task lands into its parent\'s branch in the parent\'s worktree, never onto main', async () => {
    const { root, bare } = makeProject({ config: { pushAfterLanding: true, checks: [] } });
    const parent = newTask(root, { title: 'Parent feature' });
    const pwt = await worktree(root, parent.task);
    commit(pwt.path, { 'parent.txt': 'parent work\n' });
    const { t, head } = await readyTask(root, { title: 'Child piece', parent: parent.task, files: { 'child.txt': 'child work\n' } });
    const main = sha(root, 'main');
    jev.route = 'land';
    const r = await land(root, t.task, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = r.json();
    assert.equal(out.target, pwt.branch);
    assert.equal(out.method, 'merge --ff-only');
    assert.equal(out.commit, head);
    assert.equal(out.push, null, 'a child is never pushed');
    assert.equal(sha(root, pwt.branch), head);
    assert.equal(fs.readFileSync(path.join(pwt.path, 'child.txt'), 'utf8'), 'child work\n');
    assert.equal(sha(root, 'main'), main);
    assert.equal(sha(bare, 'main'), main);
    assert.equal(fs.existsSync(path.join(root, 'child.txt')), false);
    assert.deepEqual(lastOf(root, t.task, 'task.landed').data, { commit: head, target: pwt.branch, method: 'merge --ff-only' });

    // A child whose parent landed already is refused.
    const late = await readyTask(root, { title: 'Late child', parent: parent.task, files: { 'late.txt': 'late\n' } });
    parent.landed(sha(root, pwt.branch));
    const refused = await land(root, late.t.task);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, new RegExp(`lands into its parent's branch, but the parent ${parent.task} already landed`));
  });
});

// ---- evals -----------------------------------------------------------------------------------------------------

describe('evals/run.mjs', () => {
  test('--export turns landed Jev decisions into cases; the replay scores them against the current policy', async () => {
    const { root } = makeProject({ config: { checks: [] } });
    const landed = await readyTask(root, { title: 'Landed one' });
    jev.route = 'land';
    assert.equal((await land(root, landed.t.task)).status, 0);
    const failing = await readyTask(root, { title: 'Failing one', files: { 'f.txt': 'f\n' } });
    writeJson(path.join(root, '.jevellan', 'project.json'), { name: 'p', defaultBranch: 'main', checks: ['exit 1'] });
    assert.equal((await land(root, failing.t.task)).status, 2);
    const asked = await readyTask(root, { title: 'Asked one', files: { 'g.txt': 'g\n' } });
    jev.route = 'ask-owner';
    assert.equal((await land(root, asked.t.task)).status, 7);
    writeJson(path.join(root, '.jevellan', 'project.json'), { name: 'p', defaultBranch: 'main', checks: [] });
    assert.equal((await land(root, asked.t.task, ['--force'])).status, 0);

    const dir = tempDir('jh-evals-');
    const casesFile = path.join(dir, 'cases.json');
    writeJson(casesFile, { skill: 'jevellan-git', cases: [] });
    const exported = await runScript(root, 'evals/run.mjs', ['--export', '--project', root, '--cases', casesFile, '--json']);
    assert.equal(exported.status, 0, exported.stderr);
    assert.deepEqual({ ...exported.json(), casesFile: null, projects: null }, {
      casesFile: null, exported: 2, outcome: 1, failed: 1, skipped: { owner: 1, unreadable: 0, pending: 0, stopped: 1 }, total: 2, projects: null,
    });
    const { cases } = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
    const byTitle = (title) => cases.find((c) => c.state.title === title);
    assert.deepEqual(byTitle('Landed one').expected, { landing_route: 'land' });
    assert.equal(byTitle('Landed one').source, 'outcome');
    assert.equal(byTitle('Failing one').expected, null);
    assert.equal(byTitle('Failing one').source, 'failed');
    assert.ok(cases.every((c) => c.kind === 'landing' && c.split === 'dev' && c.id === c.decisionId && c.questions.landing_route));

    // Replay: Jev now answers land for everything; one scored dev case agrees, the unlabelled one is not scored.
    jev.route = 'land';
    const results = path.join(dir, 'RESULTS.md');
    const replay = await runScript(root, 'evals/run.mjs', ['--cases', casesFile, '--results', results]);
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /2 cases \(1 scored, 1 unlabelled, 0 stale\), split all/);
    assert.match(replay.stdout, /^held-out agreement: n\/a$/m);
    const md = fs.readFileSync(results, 'utf8');
    assert.match(md, /^# Eval results: jevellan-git$/m);
    assert.match(md, /^\| landing_route \| 1\/1 \(100%\) \| - \| 1\/1 \(100%\) \|$/m);

    // A held-out case Jev now disagrees with fails the threshold: exit 1.
    const held = { ...byTitle('Landed one'), id: 'held-1', decisionId: null, source: 'hand', split: 'held-out' };
    writeJson(casesFile, { skill: 'jevellan-git', cases: [held] });
    jev.route = 'ask-owner';
    const failed = await runScript(root, 'evals/run.mjs', ['--cases', casesFile, '--results', results]);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout, /Held-out agreement: 0% \(threshold 60%\): FAIL/);
    assert.match(failed.stdout, /held-1 \(held-out, hand\) landing_route: expected land, Jev ask-owner \[ask-owner 0\.80/);

    // No key: exit 2.
    const home = tempDir('jh-harness-nokey-');
    writeProviders(home, path.join(home, 'secrets', 'missing.key'));
    const nokey = await runScript(root, 'evals/run.mjs', ['--cases', casesFile, '--results', results], { env: { JH_HARNESS_HOME: home } });
    assert.equal(nokey.status, 2);
    assert.match(nokey.stderr, /^Jev: no key configured \(case held-1\)$/m);
  });
});
