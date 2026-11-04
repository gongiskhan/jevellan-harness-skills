// Landing by pull request (project.json "landing": "pr", docs/decisions.md H-041), run as child processes the way a
// coordinator runs them. Each project has a bare repository as its origin, reached through the GitHub-style URL
// https://github.com/acme/widgets.git (url.<bare>.insteadOf maps it), so git fetches and pushes for real and gh is
// asked about acme/widgets. gh is a fake (JH_GH_BIN) that keeps its pull requests in a state file next to itself and
// logs every call with its arguments, stdin and environment. Jev is a fake server on 127.0.0.1, as in land.test.mjs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HARNESS_HOME, NODE, REPO, TaskScript, childEnv, git, makeRepo, readLedger, tempDir, writeJson } from './helpers/ledger-fixture.mjs';
import { newTaskId } from '../skills/jevellan-ledger/scripts/lib/ids.mjs';

const GITCONFIG = path.join(tempDir('jh-gitconfig-'), 'gitconfig');
fs.writeFileSync(GITCONFIG, '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n');
const GIT_ENV = { GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1' };
const ORIGIN_URL = 'https://github.com/acme/widgets.git';

const KEY = `fixture-jev-key-${crypto.randomBytes(8).toString('hex')}`;
fs.mkdirSync(path.join(HARNESS_HOME, 'secrets'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(HARNESS_HOME, 'secrets', 'jev.key'), `${KEY}\n`, { mode: 0o600 });
writeJson(path.join(HARNESS_HOME, 'providers.json'), {
  jev: { keyFile: path.join(HARNESS_HOME, 'secrets', 'jev.key'), model: 'jev-test', timeoutMs: 15000 },
  providers: [{ name: 'claude-main', kind: 'claude-subscription', models: [{ id: 'claude-test', label: 'Test', efforts: ['low'] }] }],
});

const POLICY_BODY = fs.readFileSync(path.join(REPO, 'skills', 'jevellan-git', 'SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
const section = (name) => new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(POLICY_BODY)[1].trim();
const CRITERIA = Object.fromEntries(section('routes').split('\n').map((l) => /^([a-z-]+): (.*)$/.exec(l)).map((m) => [m[1], m[2]]));

// ---- the fake Jev ----------------------------------------------------------------------------------------------

const jev = { route: 'land', calls: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    jev.calls.push(JSON.parse(body));
    const probabilities = { land: 0.1, 'verify-then-land': 0.1, 'ask-owner': 0.1, [jev.route]: 0.8 };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'jev-fake-1', answers: { landing_route: { type: 'choice', choice: jev.route, probabilities, confidence: 0.8 } }, usage: { input_tokens: 100, output_tokens: 3 } }));
  });
});
let JEV_URL = null;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  JEV_URL = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => server.close());

// ---- the fake gh -----------------------------------------------------------------------------------------------

const FAKE_GH = `#!${NODE}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gh-state.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const argv = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
state.calls.push({ argv, stdin, env: { ...process.env } });
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const done = (out, code = 0, err = '') => { save(); if (out) process.stdout.write(out); if (err) process.stderr.write(err); process.exit(code); };
if (state.fail) done('', 1, state.fail + '\\n');
const [a, b, n] = argv;
const find = () => state.prs.find((p) => String(p.number) === n);
if (a === 'pr' && b === 'list') {
  let list = state.prs;
  if (opt('--head')) list = list.filter((p) => p.headRefName === opt('--head'));
  const wanted = opt('--state') ?? 'open';
  if (wanted !== 'all') list = list.filter((p) => String(p.state).toLowerCase() === wanted);
  done(JSON.stringify(list));
}
if (a === 'pr' && b === 'create') {
  const number = state.next++;
  const pr = { number, url: 'https://github.com/acme/widgets/pull/' + number, state: 'OPEN', isDraft: argv.includes('--draft'), headRefName: opt('--head'), baseRefName: opt('--base'), title: opt('--title'), body: stdin, isCrossRepository: false };
  state.prs.push(pr);
  done(pr.url + '\\n', 0, 'Creating pull request for ' + pr.headRefName + ' into ' + pr.baseRefName + '\\n');
}
if (a === 'pr' && b === 'edit' && find()) { find().body = stdin; done(find().url + '\\n'); }
if (a === 'pr' && b === 'ready' && find()) { find().isDraft = false; done(''); }
done('', 1, 'fake gh: unknown command ' + argv.join(' ') + '\\n');
`;

function makeGh(prs = []) {
  const dir = tempDir('jh-gh-');
  const bin = path.join(dir, 'gh');
  fs.writeFileSync(bin, FAKE_GH, { mode: 0o755 });
  const file = path.join(dir, 'gh-state.json');
  fs.writeFileSync(file, JSON.stringify({ next: 1, prs, calls: [] }));
  return {
    bin,
    state: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    set: (change) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...change })),
  };
}

// ---- fixtures --------------------------------------------------------------------------------------------------

// A project that lands by pull request. Its local main is one commit behind origin and has a stray commit of its own
// plus an uncommitted change in the main checkout: landing must never read, move or touch it.
function makeProject({ config = {}, plainOrigin = false } = {}) {
  const root = makeRepo();
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '.claude/\n.jevellan/\nplan.md\n');
  const bare = tempDir('jh-remote-');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'config', `url.${bare}.insteadOf`, ORIGIN_URL);
  git(root, 'remote', 'add', 'origin', plainOrigin ? bare : ORIGIN_URL);
  git(root, 'push', '-q', 'origin', 'main');
  // Someone else's work reaches origin; the local main never fetches it.
  const other = tempDir('jh-other-');
  git(other, 'clone', '-q', bare, '.');
  commit(other, { 'CHANGELOG.md': '# Changelog\n\n- upstream work\n' }, 'upstream work');
  git(other, 'push', '-q', 'origin', 'main');
  commit(root, { 'local-only.txt': 'a stray local commit\n' }, 'stray local commit');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n\nan uncommitted edit in the main checkout\n');
  writeJson(path.join(root, '.jevellan', 'project.json'), {
    name: path.basename(root), defaultBranch: 'main', testCommand: null, riskyPaths: [], checks: ['echo checks-ok'], landing: 'pr', pushAfterLanding: false, retentionDays: 3, ...config,
  });
  for (const skill of ['jevellan-git', 'jevellan-placement', 'jevellan-ledger']) {
    fs.cpSync(path.join(REPO, 'skills', skill), path.join(root, '.claude', 'skills', skill), { recursive: true });
  }
  return { root, bare, other, localMain: sha(root, 'main') };
}

function newTask(root, { kind = 'feature', title = 'Add a How to run section', parent = null, text = null } = {}) {
  const t = Object.create(TaskScript.prototype);
  Object.assign(t, { root, session: 'coord-test', task: newTaskId(), kind });
  t.created = t.add('task.created', { kind, title, text: text ?? `Brief for ${title}`, parent, after: null, origin: 'owner' });
  return t;
}

function runScript(root, relative, args, { env = {} } = {}) {
  const script = path.join(root, '.claude', 'skills', 'jevellan-git', ...relative.split('/'));
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [script, ...args], { cwd: root, env: childEnv({ ...GIT_ENV, JH_JEV_URL: JEV_URL, ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) }));
  });
}

const sha = (cwd, ref) => git(cwd, 'rev-parse', ref).trim();
function commit(cwd, files, message = 'work') {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  }
  git(cwd, 'add', '-A', '--', ...Object.keys(files));
  git(cwd, 'commit', '-q', '--no-verify', '-m', message);
  return sha(cwd, 'HEAD');
}

const land = (root, task, gh, extra = [], env = {}) => runScript(root, 'scripts/land.mjs', ['--task', task, ...extra], { env: { JH_GH_BIN: gh.bin, ...env } });

async function worktree(root, task) {
  const r = await runScript(root, 'scripts/worktree.mjs', ['create', '--task', task, '--json']);
  assert.equal(r.status, 0, r.stderr);
  return r.json();
}

// A feature task whose worktree holds one commit, with implement and verify done; the verify report carries a
// screenshot and the worktree a test log under .jevellan/evidence/.
async function readyTask(root, { title, parent, text, files = { 'docs/run.md': '# How to run\n\nnpm start\n' }, implement = {}, verify = {}, plan = null } = {}) {
  const t = newTask(root, { title, parent, text });
  const wt = await worktree(root, t.task);
  const head = commit(wt.path, files, `work on ${t.task}`);
  fs.mkdirSync(path.join(wt.path, '.jevellan', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(wt.path, '.jevellan', 'evidence', 'tests.txt'), '12 passed\n');
  fs.writeFileSync(path.join(wt.path, '.jevellan', 'evidence', 'run-phone.png'), 'png');
  t.workflow([{ ordinal: 1, duty: 'implement' }, { ordinal: 2, duty: 'verify', onFail: { goto: 1, maxLoops: 2 } }]);
  if (plan) fs.writeFileSync(path.join(wt.path, 'plan.md'), plan);
  t.started(1, { duty: 'implement' });
  t.report(1, { summary: 'Added a How to run section to docs/run.md.', ...implement });
  t.done(1);
  t.started(2, { duty: 'verify' });
  t.report(2, {
    summary: 'Verified: the section renders and npm start works.',
    testsRun: { command: 'npm test', passed: true, summary: '12 passed' },
    screenshots: [{ path: `${wt.path}/.jevellan/evidence/run-phone.png`, caption: 'The How to run section at 390 px' }],
    ...verify,
  });
  t.done(2);
  return { t, wt, head };
}

const ledgerOf = (root, task) => readLedger(root).filter((e) => e.task === task);
const kinds = (root, task) => ledgerOf(root, task).map((e) => e.kind);
const lastOf = (root, task, kind) => ledgerOf(root, task).filter((e) => e.kind === kind).at(-1);
const ghCalls = (gh, verb) => gh.state().calls.filter((c) => c.argv[0] === 'pr' && c.argv[1] === verb);
const ATTRIBUTION = /co-authored|generated with|claude|anthropic|jevellan|🤖/i;

// The local default branch and the main checkout are exactly as the fixture left them.
function assertLocalMainUntouched(project) {
  assert.equal(sha(project.root, 'main'), project.localMain, 'the local main did not move');
  assert.equal(git(project.root, 'status', '--porcelain', '--', 'README.md'), ' M README.md\n', 'the uncommitted edit is still there');
  assert.equal(git(project.root, 'symbolic-ref', '--short', 'HEAD').trim(), 'main');
}

// ---- worktrees -------------------------------------------------------------------------------------------------

describe('worktree.mjs with "landing": "pr"', () => {
  test('a task branch starts from a freshly fetched origin/main, never from the stale local main', async () => {
    const project = makeProject();
    const { root, bare } = project;
    const t = newTask(root);
    const wt = await worktree(root, t.task);
    assert.equal(wt.base, 'origin/main');
    assert.equal(wt.baseCommit, sha(bare, 'main'));
    assert.notEqual(wt.baseCommit, project.localMain);
    assert.ok(fs.existsSync(path.join(wt.path, 'CHANGELOG.md')), 'upstream work is in the worktree');
    assert.equal(fs.existsSync(path.join(wt.path, 'local-only.txt')), false, 'the stray local commit is not');
    assert.deepEqual(lastOf(root, t.task, 'task.worktree').data, { branch: wt.branch, path: wt.path, base: 'origin/main', baseCommit: wt.baseCommit });
    assertLocalMainUntouched(project);
  });

  test('a failed fetch refuses and creates nothing; a child task still starts from its parent\'s branch', async () => {
    const project = makeProject();
    const { root } = project;
    const t = newTask(root);
    git(root, 'remote', 'set-url', 'origin', 'https://github.com/acme/gone.git');
    git(root, 'config', `url.${path.join(tempDir('jh-gone-'), 'missing.git')}.insteadOf`, 'https://github.com/acme/gone.git');
    const r = await runScript(root, 'scripts/worktree.mjs', ['create', '--task', t.task]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^git fetch origin failed \(.+\); with "landing": "pr" a task starts from a fresh origin\/main, so nothing was created\n$/);
    assert.deepEqual(kinds(root, t.task), ['task.created']);
    assert.equal(git(root, 'branch', '--list', 'jh/*'), '');

    const ok = makeProject();
    const parent = newTask(ok.root, { title: 'Parent feature' });
    const pwt = await worktree(ok.root, parent.task);
    commit(pwt.path, { 'parent.txt': 'parent work\n' });
    const child = newTask(ok.root, { title: 'Child piece', parent: parent.task });
    const cwt = await worktree(ok.root, child.task);
    assert.equal(cwt.base, pwt.branch);
    assert.equal(cwt.baseCommit, sha(pwt.path, 'HEAD'));
  });

  test('project.json: an unknown landing mode refuses', async () => {
    const { root } = makeProject({ config: { landing: 'github' } });
    const t = newTask(root);
    const r = await runScript(root, 'scripts/worktree.mjs', ['create', '--task', t.task]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /project\.json: landing must be "local" or "pr", not "github"\n$/);
  });
});

// ---- landing ---------------------------------------------------------------------------------------------------

describe('land.mjs with "landing": "pr"', () => {
  test('route land: merges origin/main, runs the checks, pushes the branch and opens a ready pull request', async () => {
    const project = makeProject({ config: { checks: ['echo checks-ok', { name: 'lint', command: 'echo lint-ok' }] } });
    const { root, bare, other } = project;
    const { t, wt, head } = await readyTask(root);
    // origin moves on after the task started: landing merges the new origin/main into the branch.
    const upstream = commit(other, { 'NOTES.md': 'more upstream work\n' }, 'more upstream work');
    git(other, 'push', '-q', 'origin', 'main');
    const gh = makeGh();
    jev.route = 'land';
    const calls = jev.calls.length;

    const r = await land(root, t.task, gh, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = r.json();
    assert.equal(out.landed, true);
    assert.equal(out.pr, 'https://github.com/acme/widgets/pull/1');
    assert.equal(out.draft, false);
    assert.equal(out.method, 'pr');
    assert.equal(out.target, 'main');
    assert.deepEqual(out.push, { pushed: true, detail: `pushed ${wt.branch} to origin` });
    assert.deepEqual(out.checks.map((c) => [c.name, c.passed]), [['echo checks-ok', true], ['lint', true]]);

    // The branch on origin is the merge of origin/main into the task's work; origin/main itself did not move.
    assert.equal(sha(bare, wt.branch), out.commit);
    assert.equal(git(root, 'log', '-1', '--format=%P', out.commit).trim(), `${head} ${upstream}`);
    assert.equal(git(root, 'log', '-1', '--format=%s', out.commit).trim(), `Merge origin/main into ${wt.branch}`);
    assert.equal(sha(bare, 'main'), upstream);
    assertLocalMainUntouched(project);

    // Jev saw the files against origin/main: the task's own file, not the upstream ones or the stray local commit.
    assert.equal(jev.calls.length, calls + 1);
    const state = JSON.parse(jev.calls.at(-1).state);
    assert.deepEqual(state.files.map((f) => f.path), ['docs/run.md']);

    // gh: one list, one create, with --repo from origin's URL, the owner's HOME and nothing of Jev's.
    const [list] = ghCalls(gh, 'list');
    assert.deepEqual(list.argv.slice(0, 8), ['pr', 'list', '--head', wt.branch, '--base', 'main', '--state', 'all']);
    assert.deepEqual(list.argv.slice(-2), ['--repo', 'acme/widgets']);
    const creates = ghCalls(gh, 'create');
    assert.equal(creates.length, 1);
    const create = creates[0];
    assert.deepEqual(create.argv, ['pr', 'create', '--base', 'main', '--head', wt.branch, '--title', 'Add a How to run section', '--body-file', '-', '--repo', 'acme/widgets']);
    assert.equal(create.env.HOME, childEnv().HOME);
    assert.equal(create.env.GH_PROMPT_DISABLED, '1');
    assert.equal(create.env.JH_JEV_URL, undefined);
    assert.equal(create.env.JH_HARNESS_HOME, undefined);

    // The body: the summaries, the checks and their results, the steps' tests, the evidence; no attribution.
    const body = create.stdin;
    assert.match(body, /^## Summary\n\n### Implement\n\nAdded a How to run section to docs\/run\.md\.\n\n### Verify\n\nVerified: the section renders and npm start works\.\n\n## Checks\n\n- `echo checks-ok`: passed in \d+ s\n- `echo lint-ok`: passed in \d+ s\n\nTests the task's steps ran:\n\n- verify: `npm test` passed: 12 passed\n\n## Evidence\n\n/);
    assert.match(body, /## Evidence\n\n- `run-phone\.png`: The How to run section at 390 px\n- `tests\.txt`\n\nThese files are in the task's evidence folder on the machine that ran it; they are not part of this branch\.\n$/);
    assert.doesNotMatch(body, ATTRIBUTION);
    assert.doesNotMatch(create.argv.join(' '), ATTRIBUTION);
    assert.equal(body.includes(wt.path), false, 'no machine paths');

    // The ledger: the decision, the checks, task.landed with the pull request.
    assert.deepEqual(kinds(root, t.task).slice(-4), ['landing.decided', 'landing.checked', 'landing.checked', 'task.landed']);
    assert.deepEqual(lastOf(root, t.task, 'task.landed').data, { pr: out.pr, commit: out.commit, target: 'main', method: 'pr' });

    // The ledger's view: done, with the pull request.
    const show = await new Promise((resolve) => {
      const c = spawn(NODE, [path.join(root, '.claude', 'skills', 'jevellan-ledger', 'scripts', 'ledger.mjs'), 'show', t.task, '--json'], { cwd: root, env: childEnv(GIT_ENV) });
      let s = '';
      c.stdout.on('data', (d) => { s += d; });
      c.on('close', () => resolve(JSON.parse(s)));
    });
    assert.equal(show.state, 'done');
    assert.equal(show.landedPr, out.pr);

    // Landed is landed: a second call says so and asks nobody.
    const again = await land(root, t.task, gh);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, `${t.task} already landed at ${out.commit.slice(0, 12)} in the pull request ${out.pr}.\n`);
    // The branch's pull request, the overlap check's open and merged lists, and pr create; nothing after landing.
    assert.deepEqual(gh.state().calls.map((c) => `${c.argv[1]} ${c.argv.includes('--head') ? 'head' : c.argv[c.argv.indexOf('--state') + 1] ?? ''}`), ['list head', 'list open', 'list merged', 'create head']);
  });

  test('ask-owner opens a draft and asks; Land now checks again and marks it ready', async () => {
    const project = makeProject();
    const { root, bare } = project;
    const { t, wt } = await readyTask(root);
    const gh = makeGh();
    jev.route = 'ask-owner';

    const r = await land(root, t.task, gh, ['--json']);
    assert.equal(r.status, 7, r.stderr);
    const out = r.json();
    const url = 'https://github.com/acme/widgets/pull/1';
    assert.equal(out.route, 'ask-owner');
    assert.equal(out.pr, url);
    assert.equal(out.draft, true);
    assert.deepEqual(out.options, ['Land now', 'Leave it']);
    assert.equal(out.question, `Land Add a How to run section? ${CRITERIA['ask-owner']} It waits in a draft pull request: ${url}`);
    const [create] = ghCalls(gh, 'create');
    assert.equal(create.argv.includes('--draft'), true);
    assert.match(create.stdin, new RegExp(`^\\*\\*Draft for review\\.\\*\\* ${CRITERIA['ask-owner'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n\n## Summary\n`));
    assert.equal(sha(bare, wt.branch), sha(wt.path, 'HEAD'));
    const asked = lastOf(root, t.task, 'task.asked');
    assert.deepEqual(asked.data, { question: out.question, options: ['Land now', 'Leave it'], reason: CRITERIA['ask-owner'], pr: url });
    assert.equal(kinds(root, t.task).includes('task.landed'), false);
    assertLocalMainUntouched(project);

    // The owner says Land now.
    const forced = await land(root, t.task, gh, ['--force', '--json']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(forced.json().pr, url);
    assert.equal(forced.json().forced, true);
    assert.equal(ghCalls(gh, 'create').length, 1, 'no second pull request');
    const [edit] = ghCalls(gh, 'edit');
    assert.deepEqual(edit.argv, ['pr', 'edit', '1', '--body-file', '-', '--repo', 'acme/widgets']);
    assert.doesNotMatch(edit.stdin, /Draft for review/);
    assert.deepEqual(ghCalls(gh, 'ready')[0].argv, ['pr', 'ready', '1', '--repo', 'acme/widgets']);
    assert.equal(gh.state().prs[0].isDraft, false);
    assert.deepEqual(lastOf(root, t.task, 'task.landed').data, { pr: url, commit: sha(wt.path, 'HEAD'), target: 'main', method: 'pr' });
    assert.equal(lastOf(root, t.task, 'landing.decided').data.source, 'owner');
    assertLocalMainUntouched(project);
  });

  test('a merge conflict with origin/main pushes the branch as it is, opens a draft that says so, and asks', async () => {
    const project = makeProject();
    const { root, bare, other } = project;
    const { t, wt, head } = await readyTask(root);
    commit(other, { 'docs/run.md': '# Running\n\nyarn start\n' }, 'upstream rewrites docs/run.md');
    git(other, 'push', '-q', 'origin', 'main');
    const gh = makeGh();
    jev.route = 'land';

    const r = await land(root, t.task, gh, ['--json']);
    assert.equal(r.status, 7, r.stderr);
    assert.equal(r.json().reason, 'merge conflict in docs/run.md');
    assert.equal(sha(bare, wt.branch), head, 'the branch as it was, without a merge');
    assert.equal(sha(wt.path, 'HEAD'), head, 'the merge was aborted');
    const [create] = ghCalls(gh, 'create');
    assert.equal(create.argv.includes('--draft'), true);
    assert.match(create.stdin, /^\*\*Draft: the merge conflicts\.\*\* Merging origin\/main into this branch conflicts in docs\/run\.md, so the checks did not run\.\n/);
    assert.match(create.stdin, /## Checks\n\nNot run: the merge conflicts\./);
    assert.equal(kinds(root, t.task).includes('landing.checked'), false);
    assert.equal(lastOf(root, t.task, 'task.asked').data.pr, 'https://github.com/acme/widgets/pull/1');

    // Land now with the conflict still there: one implement step resolves it, then --force again.
    const forced = await land(root, t.task, gh, ['--force']);
    assert.equal(forced.status, 2);
    assert.match(forced.stderr, /^merging origin\/main into jh\/.+ conflicts in docs\/run\.md; the merge was aborted and nothing was pushed\. The owner said Land now/);
    assert.match(forced.stderr, /Run git merge origin\/main in this worktree/);
    assert.match(forced.stderr, /Never touch the default branch and push nothing: landing pushes jh\//);
    assertLocalMainUntouched(project);
  });

  test('verify-then-land exits 6; after the verify step the next call opens the pull request without Jev', async () => {
    const { root } = makeProject();
    const { t } = await readyTask(root);
    const gh = makeGh();
    jev.route = 'verify-then-land';
    const first = await land(root, t.task, gh);
    assert.equal(first.status, 6, first.stderr);
    assert.equal(ghCalls(gh, 'create').length, 0);
    t.started(3, { duty: 'verify' });
    t.report(3, { summary: 'Full verification passed.' });
    t.done(3);
    const calls = jev.calls.length;
    jev.route = 'ask-owner';
    const second = await land(root, t.task, gh, ['--json']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(jev.calls.length, calls);
    assert.equal(ghCalls(gh, 'create')[0].argv.includes('--draft'), false);
    assert.match(second.json().reason, /^verified before landing \(step 3\)$/);
  });

  test('a pull request merged on GitHub is recorded as landed; one closed without merging refuses', async () => {
    const { root } = makeProject();
    const { t, wt } = await readyTask(root);
    const gh = makeGh([{ number: 7, url: 'https://github.com/acme/widgets/pull/7', state: 'MERGED', isDraft: false, headRefName: wt.branch, isCrossRepository: false, mergeCommit: { oid: 'f'.repeat(40) } }]);
    const calls = jev.calls.length;
    const r = await land(root, t.task, gh, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().merged, true);
    assert.deepEqual(lastOf(root, t.task, 'task.landed').data, { pr: 'https://github.com/acme/widgets/pull/7', commit: sha(wt.path, 'HEAD'), target: 'main', method: 'pr', merged: true, mergeCommit: 'f'.repeat(40) });
    assert.equal(jev.calls.length, calls);

    const second = await readyTask(root, { title: 'Second task' });
    const closed = makeGh([
      { number: 8, url: 'https://github.com/acme/widgets/pull/8', state: 'CLOSED', isDraft: false, headRefName: second.wt.branch, isCrossRepository: false },
      { number: 9, url: 'https://github.com/fork/widgets/pull/9', state: 'OPEN', isDraft: false, headRefName: second.wt.branch, isCrossRepository: true },
    ]);
    const before = readLedger(root).length;
    const refused = await land(root, second.t.task, closed);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /^the pull request https:\/\/github\.com\/acme\/widgets\/pull\/8 of jh\/.+ was closed without merging\. Reopen it on GitHub and land again, or leave the task/);
    assert.equal(readLedger(root).length, before);
  });

  test('refusals before anything moves: no new commits, gh missing or failing, a push origin rejects, an origin gh cannot name', async () => {
    const project = makeProject();
    const { root, bare } = project;
    const before = () => readLedger(root).length;

    // A branch with nothing beyond origin/main.
    const empty = newTask(root, { title: 'Nothing to do' });
    await worktree(root, empty.task);
    empty.workflow([{ ordinal: 1, duty: 'implement' }]);
    empty.stepDone(1, { duty: 'implement' });
    let n = before();
    const gh = makeGh();
    const calls = jev.calls.length;
    let r = await land(root, empty.task, gh);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^jh\/.+ has no commits that origin\/main does not have; there is nothing to open a pull request for\n$/);
    assert.equal(jev.calls.length, calls);
    assert.equal(before(), n);

    // gh not installed, and gh failing.
    const { t, wt } = await readyTask(root, { title: 'Real work' });
    n = before();
    r = await land(root, t.task, { bin: path.join(tempDir('jh-nogh-'), 'gh') });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'gh is not installed or not on PATH; "landing": "pr" opens the pull request with it\n');
    const failing = makeGh();
    failing.set({ fail: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' });
    r = await land(root, t.task, failing);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'gh pr list failed: HTTP 401: Bad credentials (https://api.github.com/graphql)\n');
    assert.equal(before(), n);
    assert.equal(git(bare, 'branch', '--list', wt.branch), '');

    // origin already holds a different branch of that name: the push is refused and no pull request opens.
    const clash = tempDir('jh-clash-');
    git(clash, 'clone', '-q', bare, '.');
    git(clash, 'checkout', '-q', '-b', wt.branch);
    commit(clash, { 'other.txt': 'someone else\n' }, 'someone else');
    git(clash, 'push', '-q', 'origin', wt.branch);
    jev.route = 'land';
    const pushGh = makeGh();
    r = await land(root, t.task, pushGh);
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(`^git push origin ${wt.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed: .+\\. No pull request was opened or changed\n$`));
    assert.equal(ghCalls(pushGh, 'create').length, 0);
    assert.equal(kinds(root, t.task).includes('task.landed'), false);
    assertLocalMainUntouched(project);
  });

  test('settings and origins: pushAfterLanding true refuses, an origin gh cannot name refuses, no origin refuses', async () => {
    const pushing = makeProject({ config: { pushAfterLanding: true } });
    const p = await readyTask(pushing.root);
    let r = await land(pushing.root, p.t.task, makeGh());
    assert.equal(r.status, 2);
    assert.match(r.stderr, /project\.json: pushAfterLanding pushes the default branch, which "landing": "pr" never does; set it to false\n$/);

    const plain = makeProject({ plainOrigin: true });
    const q = await readyTask(plain.root);
    const n = readLedger(plain.root).length;
    const gh = makeGh();
    r = await land(plain.root, q.t.task, gh);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^origin's URL ".+jh-remote-.+" names no host, owner and repository; "landing": "pr" opens the pull request there with gh\n$/);
    assert.equal(readLedger(plain.root).length, n);
    assert.equal(gh.state().calls.length, 0);

    const none = makeProject();
    git(none.root, 'remote', 'remove', 'origin');
    const t = newTask(none.root);
    r = await runScript(none.root, 'scripts/worktree.mjs', ['create', '--task', t.task]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /project\.json sets "landing": "pr", but .+ has no remote named origin\n$/);
  });
});

// ---- 0.4.0: the overlap check, the landing guards and the report's extras ----------------------------------------

const overlap = (root, task, gh, extra = []) => runScript(root, 'scripts/overlap.mjs', ['--task', task, '--json', ...extra], { env: { JH_GH_BIN: gh.bin } });
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

describe('overlap.mjs and the landing guards', () => {
  test('intake lists a merged pull request on the same files with its commit and records it; a later check looks only at what is new', async () => {
    const project = makeProject();
    const { root, other } = project;
    const merged = commit(other, { 'web/panel.mjs': 'export const replace = true;\n' }, 'Credentials can be replaced in the panel (#7)');
    git(other, 'push', '-q', 'origin', 'main');
    const gh = makeGh([{ number: 7, title: 'Credentials can be replaced in the panel', state: 'MERGED', mergedAt: minutesAgo(30), createdAt: minutesAgo(90), updatedAt: minutesAgo(30), headRefName: 'feat/credentials', body: 'Replace re-posts the form.', files: [{ path: 'web/panel.mjs' }], mergeCommit: { oid: merged } }]);
    const t = newTask(root, { title: 'Replace and remove a stored credential', text: 'In the integrations panel (web/panel.mjs) add Substituir and Remover for a stored credential.' });
    await worktree(root, t.task);
    let r = await overlap(root, t.task, gh);
    assert.equal(r.status, 0, r.stderr);
    let out = r.json();
    assert.equal(out.verdict, 'possible');
    assert.equal(out.base, 'origin/main');
    const pr = out.items.find((i) => i.number === 7);
    assert.equal(pr.kind, 'merged-pr');
    assert.equal(pr.commit, merged);
    assert.deepEqual(pr.filesOverlap, ['web/panel.mjs']);
    assert.ok(!out.items.some((i) => i.kind === 'commit' && i.commit === merged), 'the merge commit is folded into its pull request');
    const note = lastOf(root, t.task, 'note');
    assert.equal(note.seq, out.recorded);
    assert.match(note.data.text, new RegExp(`#7 ${merged.slice(0, 9)} Credentials can be replaced in the panel`));
    assert.equal(note.data.overlap.originHead, out.originHead);

    // Nothing new: no commit, the merged pull request is older than the last check.
    out = (await overlap(root, t.task, gh, ['--checkpoint', 'step'])).json();
    assert.equal(out.verdict, 'none');
    assert.equal(out.since, out.originHead);
    // A new unrelated commit, then a related one: only what is new since the last check is looked at.
    commit(other, { 'README.md': '# readme\n' }, 'Readme wording');
    git(other, 'push', '-q', 'origin', 'main');
    out = (await overlap(root, t.task, gh, ['--checkpoint', 'step'])).json();
    assert.equal(out.verdict, 'none');
    assert.equal(out.newCommits.length, 1);
    const related = commit(other, { 'web/panel.mjs': 'export const remove = true;\n' }, 'Remover in the panel');
    git(other, 'push', '-q', 'origin', 'main');
    out = (await overlap(root, t.task, gh, ['--checkpoint', 'step'])).json();
    assert.equal(out.verdict, 'possible');
    assert.deepEqual(out.items.map((i) => i.commit), [related]);
    assert.equal(gh.state().calls.every((c) => c.argv[0] === 'pr' && c.argv[1] === 'list'), true, 'gh is only read');
  });

  test('an open pull request on the same files is listed; gh failing is reported and the rest still runs', async () => {
    const project = makeProject();
    const { root } = project;
    const gh = makeGh([{ number: 8, title: 'Substituir e remover credenciais no painel', state: 'OPEN', createdAt: minutesAgo(60), updatedAt: minutesAgo(10), headRefName: 'claude/thread-xyz', body: 'Work in progress.', files: [{ path: 'web/panel.mjs' }] }]);
    const t = newTask(root, { title: 'Replace a credential', text: 'Change web/panel.mjs so a credential can be replaced.' });
    await worktree(root, t.task);
    const out = (await overlap(root, t.task, gh)).json();
    assert.equal(out.items[0].kind, 'open-pr');
    assert.equal(out.items[0].number, 8);
    gh.set({ fail: 'HTTP 502' });
    const r = await overlap(root, t.task, gh, ['--checkpoint', 'step']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().gh.available, false);
    assert.match(r.json().gh.reason, /HTTP 502/);
  });

  test('files outside the plan\'s scope make landing the owner\'s question, with a draft that lists them', async () => {
    const project = makeProject();
    const gh = makeGh();
    const plan = '# Plan\n\nThe section.\n\n```scope\ndocs/run.md\n```\n';
    const { t } = await readyTask(project.root, { plan, files: { 'docs/run.md': '# How to run\n', 'src/cache.mjs': 'export const x = 1;\n' } });
    const r = await land(project.root, t.task, gh, ['--json']);
    assert.equal(r.status, 7, r.stderr);
    const out = r.json();
    assert.equal(out.route, 'ask-owner');
    assert.match(out.reason, /^1 changed file\(s\) outside the plan's scope: src\/cache\.mjs/);
    assert.equal(lastOf(project.root, t.task, 'landing.decided').data.source, 'scope');
    assert.equal(jev.calls.length >= 0, true);
    const created = gh.state().prs.at(-1);
    assert.equal(created.isDraft, true);
    assert.match(created.body, /## Outside the plan's scope\n\n- `src\/cache\.mjs`/);
    assertLocalMainUntouched(project);
  });

  test('up to two tests outside the scope are tolerated and listed', async () => {
    const project = makeProject();
    const gh = makeGh();
    jev.route = 'land';
    const plan = '# Plan\n\n```scope\ndocs/**\n```\n';
    const { t } = await readyTask(project.root, { plan, files: { 'docs/run.md': '# How to run\n', 'tests/run.test.mjs': 'x\n' } });
    const r = await land(project.root, t.task, gh, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(gh.state().prs.at(-1).body, /## Outside the plan's scope\n\n- `tests\/run\.test\.mjs`/);
  });

  test('work on the same files that reached origin since the last check makes landing the owner\'s question', async () => {
    const project = makeProject();
    const { root, other } = project;
    const gh = makeGh();
    const { t } = await readyTask(root, { text: 'Write docs/run.md.' });
    assert.equal((await overlap(root, t.task, gh)).json().verdict, 'none');
    const upstream = commit(other, { 'docs/run.md': '# How to run, by someone else\n' }, 'A How to run section in the docs (#9)');
    git(other, 'push', '-q', 'origin', 'main');
    gh.set({ prs: [{ number: 9, title: 'A How to run section in the docs', state: 'MERGED', mergedAt: new Date(Date.now() + 1000).toISOString(), createdAt: minutesAgo(5), headRefName: 'other/run', files: [{ path: 'docs/run.md' }], mergeCommit: { oid: upstream } }] });
    const r = await land(root, t.task, gh, ['--json']);
    assert.equal(r.status, 7, r.stderr);
    assert.match(r.json().reason, /^overlap: work on the same files reached origin\/main or a pull request since the task's last check: #9 /);
    const note = lastOf(root, t.task, 'note');
    assert.equal(note.data.overlap.checkpoint, 'landing');
    assert.match(note.data.text, /#9/);
    assert.equal(gh.state().prs.at(-1).isDraft, true);
  });

  test('a check that fails for a reason the reports put outside the scope asks, with the follow-ups in the draft; any other failure refuses', async () => {
    const project = makeProject({ config: { checks: ['echo "not ok 3 - tests/unrelated.test.mjs"; exit 1'] } });
    const gh = makeGh();
    jev.route = 'land';
    const followUps = [{ kind: 'unrelated-failure', title: 'tests/unrelated.test.mjs fails on main too', evidence: 'daysBetween: 3 !== 2', cause: 'An off-by-one in utils/dates.mjs, which this task does not touch.' }];
    const decisions = [{ question: 'Where does the button go?', choice: 'next to Ver', reason: 'the other actions are there', reversible: true }];
    const { t } = await readyTask(project.root, { implement: { decisions }, verify: { followUps } });
    const r = await land(project.root, t.task, gh, ['--json']);
    assert.equal(r.status, 7, r.stderr);
    assert.match(r.json().reason, /^a check fails outside this task's scope: tests\/unrelated\.test\.mjs fails on main too/);
    assert.equal(lastOf(project.root, t.task, 'landing.decided').data.source, 'checks');
    const body = gh.state().prs.at(-1).body;
    assert.match(body, /## Decisions taken\n\n- next to Ver \(Where does the button go\?\): the other actions are there/);
    assert.match(body, /## Follow-ups\n\n- Outside this change: tests\/unrelated\.test\.mjs fails on main too\. An off-by-one/);
    assert.match(body, /failed/);

    // The same failing check without a follow-up that names it is the task's own: refused, nothing pushed.
    const plain = makeProject({ config: { checks: ['echo "not ok 3 - tests/unrelated.test.mjs"; exit 1'] } });
    const gh2 = makeGh();
    const { t: t2 } = await readyTask(plain.root);
    const r2 = await land(plain.root, t2.task, gh2);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /check .+ failed/);
    assert.equal(gh2.state().prs.length, 0);
  });
});
