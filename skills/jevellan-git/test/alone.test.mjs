// The git skill's scripts run alone, as child processes: a temporary skills folder holds a copy of this skill and,
// where a test wants them, a fake ledger skill and a fake placement skill written here. The fake ledger's ledger.mjs
// answers show, record and events from a state file (a record with --if-last-seq is refused with exit 6 when the
// task's newest line is another, and a test can make another writer get in first), and logs every call; the fake
// placement's jev.mjs answers decide with a canned landing route or a canned refusal. Nothing of any other skill is
// used, so these run with only this skill's folder present.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = path.basename(SKILL_DIR);
const BASE = process.env.JH_TEST_TMPDIR || os.tmpdir();
const ROLE_MISSING = (role) => `no installed skill has the role ${role}; tell the owner which role is missing and do not improvise it`;

const POLICY_BODY = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
const section = (name) => new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(POLICY_BODY)[1].trim();
// What the policy hash covers: the body without the "## Interface" section, which is last.
const POLICY_HASHED = POLICY_BODY.replace(/\n## Interface\n[\s\S]*$/, '');
const CRITERIA = Object.fromEntries(section('routes').split('\n').map((l) => /^([a-z-]+): (.*)$/.exec(l)).map((m) => [m[1], m[2]]));

// ---- the fakes ---------------------------------------------------------------------------------------------------

const FAKE_LEDGER = `#!/usr/bin/env node
// A fake ledger for the git skill's own tests: show, record and events from a state file; every call is logged.
import fs from 'node:fs';
const file = process.env.FAKE_LEDGER_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const argv = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(file + '.calls', JSON.stringify({ argv, stdin }) + '\\n');
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
const fail = (error, exitCode) => {
  process.stdout.write(JSON.stringify({ error, exitCode }) + '\\n');
  process.stderr.write(error + '\\n');
  process.exit(exitCode);
};
const lastSeq = (task) => task.events.reduce((m, e) => Math.max(m, e.seq), 0);
const add = (task, line) => {
  state.seq += 1;
  const event = { seq: state.seq, t: new Date().toISOString(), ...line, task: task.task };
  task.events.push(event);
  if (event.kind === 'task.worktree') task.worktree = event.data;
  if (event.kind === 'step.stopped') Object.assign(task, { state: 'stopped', reason: event.data.reason });
  if (event.kind === 'task.landed') task.state = 'done';
  return event;
};
const [command] = argv;
if (command === 'show') {
  const task = state.tasks[argv[1]];
  if (!task) fail('no task ' + argv[1] + " in this project's ledger", 3);
  process.stdout.write(JSON.stringify({ ...task, lastSeq: lastSeq(task) }) + '\\n');
} else if (command === 'record') {
  const task = state.tasks[opt('--task')];
  if (!task) fail('no task ' + opt('--task') + " in this project's ledger", 3);
  // Another writer that got in first.
  if (state.interfere.length) add(task, state.interfere.shift());
  save();
  const ifLastSeq = opt('--if-last-seq');
  if (ifLastSeq !== undefined && Number(ifLastSeq) !== lastSeq(task)) fail(task.task + ' changed after #' + ifLastSeq, 6);
  const step = opt('--step');
  const session = opt('--session');
  const event = add(task, { kind: argv[1], ...(step ? { step: Number(step) } : {}), ...(session ? { session } : {}), data: JSON.parse(stdin || '{}') });
  save();
  process.stdout.write(JSON.stringify(event) + '\\n');
} else if (command === 'events') {
  const events = Object.values(state.tasks).flatMap((t) => t.events).sort((a, b) => a.seq - b.seq);
  process.stdout.write(JSON.stringify({ lastSeq: state.seq, events }) + '\\n');
} else {
  fail('the fake ledger does not know ' + command, 2);
}
`;

const FAKE_PLACEMENT = `#!/usr/bin/env node
// A fake placement skill for the git skill's own tests: jev.mjs decide answers a canned landing route or refusal.
import fs from 'node:fs';
const file = process.env.FAKE_PLACEMENT_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(file + '.calls', JSON.stringify({ argv, input: stdin ? JSON.parse(stdin) : null }) + '\\n');
const refuse = (error) => {
  process.stdout.write(JSON.stringify({ error, exitCode: 2 }) + '\\n');
  process.stderr.write(error + '\\n');
  process.exit(2);
};
if (argv[0] !== 'decide') refuse('the fake placement does not know ' + argv[0]);
if (state.error) refuse(state.error);
const probabilities = { land: 0.1, 'verify-then-land': 0.1, 'ask-owner': 0.1 };
probabilities[state.route] = 0.8;
const answers = { landing_route: { type: 'choice', choice: state.route, probabilities, confidence: 0.8 } };
process.stdout.write(JSON.stringify({ jevModel: 'jev-canned', answeredBy: 'jev-fake-1', answers, usage: { input_tokens: 10, output_tokens: 1 }, latencyMs: 7 }) + '\\n');
`;

function tempDir(prefix) {
  fs.mkdirSync(BASE, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(BASE, prefix)));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? os.homedir(), GIT_CONFIG_NOSYSTEM: '1' },
  });
}

const sha = (cwd, ref) => git(cwd, 'rev-parse', ref).trim();

function commit(cwd, files, message = 'work') {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '--no-verify', '-m', message);
  return sha(cwd, 'HEAD');
}

function fakeSkill(skills, folder, role, word, script, source) {
  const dir = path.join(skills, folder);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${folder}\ndescription: "${word}. A fake for the git skill's own tests."\njh-role: ${role}\n---\n\n# ${word}\n`);
  fs.writeFileSync(path.join(dir, 'scripts', script), source);
}

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

// A project with one commit and .jevellan/project.json, a skills folder with a copy of this skill and the fakes
// asked for, and the helpers to drive them. inProject puts the skills folder at <project>/.claude/skills, where an
// installation into the project puts it.
function setup({ ledger = true, placement = true, config = {}, inProject = false } = {}) {
  const base = tempDir('jh-git-alone-');
  const skills = inProject ? path.join(base, 'project', '.claude', 'skills') : path.join(base, 'skills');
  fs.cpSync(SKILL_DIR, path.join(skills, SKILL_NAME), { recursive: true });
  const ledgerState = path.join(base, 'ledger-state.json');
  const placementState = path.join(base, 'placement-state.json');
  writeJson(ledgerState, { seq: 0, tasks: {}, interfere: [] });
  writeJson(placementState, { route: 'land', error: null });
  if (ledger) fakeSkill(skills, 'fake-ledger', 'ledger', 'Ledger', 'ledger.mjs', FAKE_LEDGER);
  if (placement) fakeSkill(skills, 'fake-placement', 'placement', 'Placement', 'jev.mjs', FAKE_PLACEMENT);

  const root = path.join(base, 'project');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  // An installation never commits the skills: install.mjs excludes .claude.
  if (inProject) fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '.claude\n');
  commit(root, { 'README.md': '# fixture\n' }, 'init');
  writeJson(path.join(root, '.jevellan', 'project.json'), { name: 'project', defaultBranch: 'main', checks: [], pushAfterLanding: false, ...config });
  const gitconfig = path.join(base, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n');
  const harness = path.join(base, 'harness');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? os.homedir(),
    JH_HARNESS_HOME: harness,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    FAKE_LEDGER_STATE: ledgerState,
    FAKE_PLACEMENT_STATE: placementState,
  };
  for (const key of ['USER', 'LANG', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];

  const edit = (fn) => {
    const state = readJson(ledgerState);
    const out = fn(state);
    writeJson(ledgerState, state);
    return out;
  };
  // Appends a line to a task in the fake's state, as the real ledger would have numbered it.
  const add = (state, id, line) => {
    state.seq += 1;
    const event = { seq: state.seq, t: new Date().toISOString(), task: id, ...line };
    state.tasks[id].events.push(event);
    return event;
  };
  const ctx = {
    base,
    skills,
    root,
    harness,
    env,
    run(script, args, extraEnv = {}) {
      const r = spawnSync(process.execPath, [path.join(skills, SKILL_NAME, 'scripts', script), ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
    },
    ledger: {
      edit,
      add,
      // A task as show --json prints it: the projection's fields and the task.created line.
      task(id, { kind = 'feature', title = 'Add a How to run section', parent = null, ...fields } = {}) {
        return edit((state) => {
          state.tasks[id] = { task: id, kind, title, parent, state: 'queued', reason: null, worktree: null, workflowResolved: false, steps: [], currentStep: null, views: [], events: [], ...fields };
          return add(state, id, { kind: 'task.created', session: 'coord-test', data: { kind, title, text: `Brief for ${title}`, parent, after: null, origin: 'owner' } });
        });
      },
      state: () => readJson(ledgerState),
      events: (id) => readJson(ledgerState).tasks[id].events,
      kinds: (id) => readJson(ledgerState).tasks[id].events.map((e) => e.kind),
      calls: () => readLines(`${ledgerState}.calls`),
      records: () => readLines(`${ledgerState}.calls`).filter((c) => c.argv[0] === 'record'),
    },
    placement: {
      answer: (value) => writeJson(placementState, { route: 'land', error: null, ...value }),
      calls: () => readLines(`${placementState}.calls`),
      // Archived, not deleted: the folder moves out of the skills folder, so the role is gone.
      remove: () => fs.renameSync(path.join(skills, 'fake-placement'), path.join(base, `fake-placement-archived-${crypto.randomUUID()}`)),
    },
  };
  return ctx;
}

const stepRow = (ordinal, duty, state, extra = {}) => ({ ordinal, duty, state, starts: state === 'pending' ? 0 : 1, model: null, effort: null, provider: null, pid: null, nativeSessionId: null, startedAt: null, ...extra });
const viewOf = (ordinal, seqs = {}) => {
  const v = { state: seqs.done ? 'done' : 'pending', starts: seqs.started ? 1 : 0, started: null, end: null, done: null, lastReport: null, placed: null, ...seqs };
  return { ordinal, resetSeq: 0, current: v, overall: v };
};

// A feature task whose worktree (made by worktree.mjs) holds one commit and whose implement and verify steps are done.
function readyTask(ctx, id, { title = 'Add a How to run section', files = { 'docs/run.md': '# How to run\n\nnpm start\n' }, parent = null, base } = {}) {
  ctx.ledger.task(id, { title, parent });
  const made = ctx.run('worktree.mjs', ['create', '--task', id, '--json', ...(base ? ['--base', base] : [])]);
  assert.equal(made.status, 0, made.stderr);
  const wt = made.json();
  const head = commit(wt.path, files, `work on ${id}`);
  ctx.ledger.edit((state) => {
    const add = (line) => ctx.ledger.add(state, id, line);
    add({ kind: 'task.workflow', data: { steps: [{ ordinal: 1, duty: 'implement' }, { ordinal: 2, duty: 'verify' }] } });
    const done1 = add({ kind: 'step.done', step: 1, data: { ordinal: 1 } });
    const started = add({ kind: 'step.started', step: 2, data: { duty: 'verify', pid: deadPid() } });
    const report = add({ kind: 'step.report', step: 2, data: { status: 'done', summary: 'Verified the change.', testsRun: { command: 'npm test', passed: true, summary: 'all passed' } } });
    const done2 = add({ kind: 'step.done', step: 2, data: { ordinal: 2 } });
    Object.assign(state.tasks[id], {
      workflowResolved: true,
      currentStep: 2,
      steps: [stepRow(1, 'implement', 'done'), stepRow(2, 'verify', 'done')],
      views: [viewOf(1, { done: done1.seq }), viewOf(2, { started: started.seq, end: report.seq, lastReport: report.seq, done: done2.seq })],
    });
  });
  return { wt, head };
}

// One more verify step, started after the landing decision and done.
function verifiedAgain(ctx, id) {
  ctx.ledger.edit((state) => {
    const add = (line) => ctx.ledger.add(state, id, line);
    const started = add({ kind: 'step.started', step: 3, data: { duty: 'verify', pid: deadPid() } });
    const report = add({ kind: 'step.report', step: 3, data: { status: 'done', summary: 'Full verification passed.', testsRun: { command: 'npm test', passed: true, summary: 'all 40 passed' } } });
    const done = add({ kind: 'step.done', step: 3, data: { ordinal: 3 } });
    const task = state.tasks[id];
    task.steps.push(stepRow(3, 'verify', 'done'));
    task.views.push(viewOf(3, { started: started.seq, end: report.seq, lastReport: report.seq, done: done.seq }));
    task.currentStep = 3;
  });
}

const lastOf = (ctx, id, kind) => ctx.ledger.events(id).filter((e) => e.kind === kind).at(-1);

// ---- worktree.mjs ------------------------------------------------------------------------------------------------

describe('worktree.mjs alone', () => {
  test('skills installed in the project (<project>/.claude/skills) link .claude into the worktree', () => {
    const ctx = setup({ inProject: true });
    ctx.ledger.task('T1AAAAB');
    const r = ctx.run('worktree.mjs', ['create', '--task', 'T1AAAAB', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const link = path.join(r.json().path, '.claude');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(ctx.root, '.claude')));
    assert.equal(git(r.json().path, 'status', '--porcelain').trim(), '', 'the link is excluded');
  });

  test('create reads the task, makes the worktree and records task.worktree with --if-last-seq; a second create records nothing', () => {
    const ctx = setup();
    ctx.ledger.task('T1AAAAA');
    const r = ctx.run('worktree.mjs', ['create', '--task', 'T1AAAAA', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const name = 'add-a-how-to-run-section-T1AAAAA';
    const where = path.join(ctx.harness, 'worktrees', 'project', name);
    assert.deepEqual(r.json(), { branch: `jh/${name}`, path: where, base: 'main', baseCommit: sha(ctx.root, 'main') });
    assert.equal(git(where, 'symbolic-ref', '--short', 'HEAD').trim(), `jh/${name}`);
    assert.equal(fs.existsSync(path.join(where, '.claude')), false, 'skills outside the project make no .claude link');
    assert.ok(fs.statSync(path.join(where, '.jevellan', 'evidence')).isDirectory());
    const exclude = fs.readFileSync(path.join(ctx.root, '.git', 'info', 'exclude'), 'utf8').split('\n');
    for (const line of ['.jevellan/', 'plan.md', '.claude']) assert.ok(exclude.includes(line), line);

    const calls = ctx.ledger.calls();
    assert.deepEqual(calls.map((c) => c.argv), [
      ['show', 'T1AAAAA', '--json'],
      ['show', 'T1AAAAA', '--json'],
      ['record', 'task.worktree', '--task', 'T1AAAAA', '--data-file', '-', '--if-last-seq', '1', '--json'],
    ]);
    assert.deepEqual(JSON.parse(calls[2].stdin), r.json());
    assert.deepEqual(lastOf(ctx, 'T1AAAAA', 'task.worktree').data, r.json());

    const again = ctx.run('worktree.mjs', ['create', '--task', 'T1AAAAA']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, `${where}\n`);
    assert.equal(ctx.ledger.records().length, 1);
  });

  test('a task that changed meanwhile is read and decided again (the ledger said exit 6 once)', () => {
    const ctx = setup();
    ctx.ledger.task('T1AAAAA');
    ctx.ledger.edit((state) => state.interfere.push({ kind: 'note', data: { text: 'another writer' } }));
    const r = ctx.run('worktree.mjs', ['create', '--task', 'T1AAAAA', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const records = ctx.ledger.records();
    assert.deepEqual(records.map((c) => c.argv.at(-2)), ['1', '2'], 'the second try compares against the new newest line');
    assert.equal(ctx.ledger.calls().map((c) => c.argv[0]).join(' '), 'show show record show record');
    assert.deepEqual(ctx.ledger.kinds('T1AAAAA'), ['task.created', 'note', 'task.worktree']);
  });

  test('a worktree recorded meanwhile at another path refuses on the fresh read', () => {
    const ctx = setup();
    ctx.ledger.task('T1AAAAA');
    ctx.ledger.edit((state) => state.interfere.push({ kind: 'task.worktree', data: { branch: 'jh/other', path: '/elsewhere/wt', base: 'main', baseCommit: null } }));
    const r = ctx.run('worktree.mjs', ['create', '--task', 'T1AAAAA', '--json']);
    assert.equal(r.status, 2);
    assert.deepEqual(r.json(), { error: 'task T1AAAAA got the worktree /elsewhere/wt meanwhile', exitCode: 2 });
    assert.equal(ctx.ledger.events('T1AAAAA').filter((e) => e.kind === 'task.worktree').length, 1);
  });

  test('an unknown task is exit 3 in the ledger\'s words; a bad id refuses without asking the ledger', () => {
    const ctx = setup();
    const unknown = ctx.run('worktree.mjs', ['create', '--task', 'T000000', '--json']);
    assert.equal(unknown.status, 3);
    assert.deepEqual(unknown.json(), { error: 'no task T000000 in this project\'s ledger', exitCode: 3 });
    const bad = ctx.run('worktree.mjs', ['archive', '--task', 'nope']);
    assert.equal(bad.status, 2);
    assert.equal(bad.stderr, '"nope" is not a task id (T and six characters)\n');
    assert.equal(ctx.ledger.calls().length, 1);
  });

  test('a child task starts from its parent\'s branch; a parent the ledger does not know refuses', () => {
    const ctx = setup();
    ctx.ledger.task('T1AAAAA', { title: 'Parent work' });
    const parent = ctx.run('worktree.mjs', ['create', '--task', 'T1AAAAA', '--json']).json();
    const head = commit(parent.path, { 'parent.txt': 'from the parent\n' });
    ctx.ledger.task('T2BBBBB', { title: 'Child work', parent: 'T1AAAAA' });
    const child = ctx.run('worktree.mjs', ['create', '--task', 'T2BBBBB', '--json']);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.json().base, parent.branch);
    assert.equal(child.json().baseCommit, head);

    ctx.ledger.task('T3CCCCC', { title: 'Orphan', parent: 'T9ZZZZZ' });
    const orphan = ctx.run('worktree.mjs', ['create', '--task', 'T3CCCCC']);
    assert.equal(orphan.status, 2);
    assert.equal(orphan.stderr, 'task T3CCCCC names the parent T9ZZZZZ, which is not in this project\'s ledger\n');
  });

  test('archive moves the worktree, keeps the branch and stops the task at its current step', () => {
    const ctx = setup();
    ctx.ledger.task('T1AAAAA', { title: 'Left alone' });
    const wt = ctx.run('worktree.mjs', ['create', '--task', 'T1AAAAA', '--json']).json();
    const head = commit(wt.path, { 'work.txt': 'committed\n' });
    ctx.ledger.edit((state) => {
      ctx.ledger.add(state, 'T1AAAAA', { kind: 'step.started', step: 2, data: { duty: 'implement', pid: deadPid() } });
      Object.assign(state.tasks.T1AAAAA, { currentStep: 2, steps: [stepRow(1, 'plan', 'done'), stepRow(2, 'implement', 'running', { pid: deadPid() })] });
    });
    const r = ctx.run('worktree.mjs', ['archive', '--task', 'T1AAAAA', '--reason', 'the owner said Leave it', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = r.json();
    assert.equal(path.dirname(out.to), path.join(ctx.harness, 'archive', 'worktrees', 'project'));
    assert.match(path.basename(out.to), /^left-alone-T1AAAAA-\d{8}T\d{9}Z$/);
    assert.equal(out.stopped, true);
    assert.equal(fs.existsSync(wt.path), false);
    assert.equal(fs.readFileSync(path.join(out.to, 'work.txt'), 'utf8'), 'committed\n');
    assert.equal(sha(ctx.root, wt.branch), head, 'the branch stays');
    const stop = ctx.ledger.records().at(-1);
    assert.deepEqual(stop.argv, ['record', 'step.stopped', '--task', 'T1AAAAA', '--step', '2', '--data-file', '-', '--if-last-seq', '3', '--json']);
    assert.deepEqual(JSON.parse(stop.stdin), { ordinal: 2, reason: 'the owner said Leave it' });

    const again = ctx.run('worktree.mjs', ['archive', '--task', 'T1AAAAA']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^T1AAAAA is already archived at .*; the branch jh\/left-alone-T1AAAAA stays\.\n$/);
    assert.equal(ctx.ledger.records().length, 2, 'a stopped task is not stopped again');
  });

  test('archive: a task stopped by another writer meanwhile is not stopped twice; a landed task is not stopped', () => {
    const ctx = setup();
    ctx.ledger.task('T1AAAAA');
    ctx.run('worktree.mjs', ['create', '--task', 'T1AAAAA']);
    ctx.ledger.edit((state) => state.interfere.push({ kind: 'step.stopped', step: 1, data: { ordinal: 1, reason: 'someone else' } }));
    const r = ctx.run('worktree.mjs', ['archive', '--task', 'T1AAAAA', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().stopped, false);
    assert.deepEqual(ctx.ledger.kinds('T1AAAAA'), ['task.created', 'task.worktree', 'step.stopped']);

    ctx.ledger.task('T2BBBBB', { title: 'Landed already' });
    ctx.run('worktree.mjs', ['create', '--task', 'T2BBBBB']);
    ctx.ledger.edit((state) => ctx.ledger.add(state, 'T2BBBBB', { kind: 'task.landed', data: { commit: 'abc', target: 'main', method: 'push .' } }));
    const records = ctx.ledger.records().length;
    const landed = ctx.run('worktree.mjs', ['archive', '--task', 'T2BBBBB', '--json']);
    assert.equal(landed.status, 0, landed.stderr);
    assert.equal(landed.json().stopped, false);
    assert.equal(ctx.ledger.records().length, records);
  });

  test('archive refuses while a step\'s process is alive; a task without a worktree is not found', () => {
    const ctx = setup();
    ctx.ledger.task('T1AAAAA');
    const wt = ctx.run('worktree.mjs', ['create', '--task', 'T1AAAAA', '--json']).json();
    ctx.ledger.edit((state) => Object.assign(state.tasks.T1AAAAA, { steps: [stepRow(1, 'implement', 'running', { pid: process.pid })] }));
    const r = ctx.run('worktree.mjs', ['archive', '--task', 'T1AAAAA', '--json']);
    assert.equal(r.status, 2);
    assert.deepEqual(r.json(), { error: `step 1 (implement) of T1AAAAA is running (pid ${process.pid}); stop it first, then archive the worktree`, exitCode: 2 });
    assert.ok(fs.existsSync(wt.path));
    assert.equal(ctx.ledger.records().length, 1);

    ctx.ledger.task('T2BBBBB');
    const none = ctx.run('worktree.mjs', ['archive', '--task', 'T2BBBBB']);
    assert.equal(none.status, 3);
    assert.equal(none.stderr, 'task T2BBBBB has no worktree\n');
  });
});

// ---- land.mjs ----------------------------------------------------------------------------------------------------

describe('land.mjs alone', () => {
  test('route land: asks the placement skill with the policy\'s three sections, records the landing and moves main', () => {
    const ctx = setup({ config: { checks: ['echo checks-ok'] } });
    const { head } = readyTask(ctx, 'T1AAAAA');
    const r = ctx.run('land.mjs', ['--task', 'T1AAAAA', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = r.json();
    assert.deepEqual({ ...out, checks: out.checks.map((c) => [c.name, c.passed]) }, {
      task: 'T1AAAAA', route: 'land', landed: true, commit: head, target: 'main', method: 'merge --ff-only', forced: false, reason: CRITERIA.land, checks: [['echo checks-ok', true]], push: null,
    });
    assert.equal(sha(ctx.root, 'main'), head);
    assert.equal(fs.readFileSync(path.join(ctx.root, 'docs', 'run.md'), 'utf8'), '# How to run\n\nnpm start\n');

    // One decide call: the landing_route question from "## landing_route" and "## routes", the state with "## rules".
    const [call, ...more] = ctx.placement.calls();
    assert.equal(more.length, 0);
    assert.deepEqual(call.argv, ['decide', '--json']);
    assert.deepEqual(call.input.questions, { landing_route: { type: 'choice', instructions: section('landing_route'), criteria: CRITERIA } });
    const state = JSON.parse(call.input.state);
    assert.equal(state.schema, 'landing-route-state-v1');
    assert.deepEqual(state.project, { name: 'project', guidance: '' });
    assert.deepEqual(state.task, { id: 'T1AAAAA', kind: 'feature', text: 'Brief for Add a How to run section' });
    assert.deepEqual(state.summaries, [{ duty: 'verify', summary: 'Verified the change.' }]);
    assert.deepEqual(state.checks.map((c) => [c.duty, c.command, c.passed]), [['verify', 'npm test', true]]);
    assert.deepEqual(state.files.map((f) => [f.path, f.additions, f.deletions, f.risky]), [['docs/run.md', 3, 0, false]]);
    assert.equal(state.rules, section('rules'));
    assert.equal(call.input.state.includes('## Interface'), false);

    // The ledger: landing.decided, landing.checked, task.landed, recorded without --if-last-seq.
    assert.deepEqual(ctx.ledger.kinds('T1AAAAA').slice(-3), ['landing.decided', 'landing.checked', 'task.landed']);
    for (const c of ctx.ledger.records().slice(-3)) assert.equal(c.argv.includes('--if-last-seq'), false);
    const decided = lastOf(ctx, 'T1AAAAA', 'landing.decided').data;
    assert.deepEqual({ ...decided, decisionFile: null }, {
      route: 'land',
      probabilities: { land: 0.8, 'verify-then-land': 0.1, 'ask-owner': 0.1 },
      reason: CRITERIA.land,
      policyHash: crypto.createHash('sha256').update(POLICY_HASHED).digest('hex'),
      source: 'jev',
      jevModel: 'jev-canned',
      latencyMs: 7,
      decisionFile: null,
    });
    assert.match(decided.decisionFile, /^\.jevellan\/decisions\/T1AAAAA-landing-\d{8}T\d{9}Z\.json$/);
    const decision = readJson(path.join(ctx.root, decided.decisionFile));
    assert.equal(decision.jevModel, 'jev-canned');
    assert.equal(decision.answeredBy, 'jev-fake-1');
    assert.deepEqual(decision.usage, { input_tokens: 10, output_tokens: 1 });
    assert.deepEqual(decision.state, state);
    assert.deepEqual(lastOf(ctx, 'T1AAAAA', 'landing.checked').data, { command: 'echo checks-ok', passed: true, tail: 'checks-ok\n' });
    assert.deepEqual(lastOf(ctx, 'T1AAAAA', 'task.landed').data, { commit: head, target: 'main', method: 'merge --ff-only' });

    const again = ctx.run('land.mjs', ['--task', 'T1AAAAA']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, `T1AAAAA already landed at ${head.slice(0, 12)} on main.\n`);
    assert.equal(ctx.placement.calls().length, 1);
  });

  test('verify-then-land exits 6; after one more verify step the next call lands with no placement skill installed', () => {
    const ctx = setup();
    const { head } = readyTask(ctx, 'T1AAAAA');
    ctx.placement.answer({ route: 'verify-then-land' });
    const r = ctx.run('land.mjs', ['--task', 'T1AAAAA']);
    assert.equal(r.status, 6, r.stderr);
    assert.equal(r.stdout, '{"route":"verify-then-land"}\n');
    assert.equal(lastOf(ctx, 'T1AAAAA', 'landing.decided').data.route, 'verify-then-land');

    const early = ctx.run('land.mjs', ['--task', 'T1AAAAA', '--json']);
    assert.equal(early.status, 6);
    assert.equal(early.json().again, true);
    assert.equal(ctx.placement.calls().length, 1, 'not asked again');

    ctx.placement.remove();
    verifiedAgain(ctx, 'T1AAAAA');
    const second = ctx.run('land.mjs', ['--task', 'T1AAAAA', '--json']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json().reason, 'verified before landing (step 3)');
    assert.equal(sha(ctx.root, 'main'), head);
    assert.equal(ctx.ledger.kinds('T1AAAAA').filter((k) => k === 'landing.decided').length, 1);
    assert.equal(lastOf(ctx, 'T1AAAAA', 'task.landed').data.commit, head);
  });

  test('ask-owner exits 7 with task.asked; --force then lands with no placement skill installed', () => {
    const ctx = setup();
    const { head } = readyTask(ctx, 'T1AAAAA', { title: 'Change the billing rounding' });
    ctx.placement.answer({ route: 'ask-owner' });
    const r = ctx.run('land.mjs', ['--task', 'T1AAAAA', '--json']);
    assert.equal(r.status, 7, r.stderr);
    const question = `Land Change the billing rounding? ${CRITERIA['ask-owner']}`;
    const asked = { question, options: ['Land now', 'Leave it'], reason: CRITERIA['ask-owner'] };
    assert.deepEqual(r.json(), { task: 'T1AAAAA', route: 'ask-owner', ...asked });
    assert.deepEqual(lastOf(ctx, 'T1AAAAA', 'task.asked').data, asked);
    assert.notEqual(sha(ctx.root, 'main'), head);

    ctx.placement.remove();
    const forced = ctx.run('land.mjs', ['--task', 'T1AAAAA', '--force', '--json']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(forced.json().forced, true);
    assert.deepEqual(lastOf(ctx, 'T1AAAAA', 'landing.decided').data, { route: 'land', source: 'owner', reason: 'the owner said Land now' });
    assert.equal(sha(ctx.root, 'main'), head);
    assert.equal(ctx.placement.calls().length, 1);
  });

  test('asking Jev with no placement skill installed is exit 2 naming the role, and nothing is written', () => {
    const ctx = setup({ placement: false });
    readyTask(ctx, 'T1AAAAA');
    const main = sha(ctx.root, 'main');
    const records = ctx.ledger.records().length;
    const r = ctx.run('land.mjs', ['--task', 'T1AAAAA']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `${ROLE_MISSING('placement')}\n`);
    const json = ctx.run('land.mjs', ['--task', 'T1AAAAA', '--json']);
    assert.deepEqual(json.json(), { error: ROLE_MISSING('placement'), exitCode: 2 });
    assert.equal(ctx.ledger.records().length, records);
    assert.equal(sha(ctx.root, 'main'), main);
    assert.equal(fs.existsSync(path.join(ctx.root, '.jevellan', 'decisions')), false);
    assert.equal(fs.existsSync(path.join(ctx.root, '.jevellan', 'locks', 'landing.lock')), false, 'the landing lock is released');
  });

  test('a refusal of the placement skill is the refusal, word for word, and nothing is written', () => {
    const ctx = setup();
    readyTask(ctx, 'T1AAAAA');
    const records = ctx.ledger.records().length;
    ctx.placement.answer({ error: 'Jev: no key configured' });
    const r = ctx.run('land.mjs', ['--task', 'T1AAAAA', '--json']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'Jev: no key configured\n');
    assert.deepEqual(r.json(), { error: 'Jev: no key configured', exitCode: 2 });
    ctx.placement.answer({ error: '/home/x/.jevellan-harness/providers.json is not valid JSON' });
    const other = ctx.run('land.mjs', ['--task', 'T1AAAAA']);
    assert.equal(other.status, 2);
    assert.equal(other.stderr, '/home/x/.jevellan-harness/providers.json is not valid JSON\n');
    assert.equal(ctx.ledger.records().length, records);
    assert.equal(fs.existsSync(path.join(ctx.root, '.jevellan', 'decisions')), false);
  });

  test('preconditions refuse before asking anyone: open steps, no workflow, a stopped task, a dirty tree, a parent the ledger does not know', () => {
    const ctx = setup();
    const { wt } = readyTask(ctx, 'T1AAAAA');
    ctx.ledger.edit((state) => {
      state.tasks.T1AAAAA.steps.push(stepRow(3, 'document', 'running'));
    });
    const open = ctx.run('land.mjs', ['--task', 'T1AAAAA', '--json']);
    assert.equal(open.status, 2);
    assert.equal(open.json().error, 'task T1AAAAA has steps that are not done or skipped: 3 document (running)');
    ctx.ledger.edit((state) => {
      state.tasks.T1AAAAA.steps.pop();
    });

    fs.writeFileSync(path.join(wt.path, 'loose.txt'), 'x\n');
    fs.writeFileSync(path.join(wt.path, 'plan.md'), '# plan\n');
    const dirty = ctx.run('land.mjs', ['--task', 'T1AAAAA', '--force']);
    assert.equal(dirty.status, 2);
    assert.equal(dirty.stderr, `the worktree ${wt.path} has uncommitted changes: loose.txt. Commit or discard them first\n`);

    ctx.ledger.task('T2BBBBB', { title: 'No workflow' });
    const noWorkflow = ctx.run('land.mjs', ['--task', 'T2BBBBB']);
    assert.equal(noWorkflow.status, 2);
    assert.match(noWorkflow.stderr, /^task T2BBBBB has no workflow yet/);

    ctx.ledger.task('T3CCCCC', { title: 'Stopped', state: 'stopped', reason: 'left by the owner' });
    const stopped = ctx.run('land.mjs', ['--task', 'T3CCCCC']);
    assert.equal(stopped.status, 2);
    assert.equal(stopped.stderr, 'task T3CCCCC was stopped (left by the owner); there is nothing to land\n');

    readyTask(ctx, 'T4DDDDD', { title: 'Orphan child', parent: 'T9ZZZZZ', base: 'main', files: { 'child.txt': 'c\n' } });
    const orphan = ctx.run('land.mjs', ['--task', 'T4DDDDD']);
    assert.equal(orphan.status, 2);
    assert.equal(orphan.stderr, 'task T4DDDDD lands into its parent\'s branch, but the parent T9ZZZZZ is not in the ledger\n');

    assert.equal(ctx.placement.calls().length, 0);
    assert.equal(ctx.ledger.kinds('T1AAAAA').includes('landing.decided'), false);
  });

  test('a child task lands into its parent\'s branch in the parent\'s worktree', () => {
    const ctx = setup();
    ctx.ledger.task('T1AAAAA', { title: 'Parent feature' });
    const pwt = ctx.run('worktree.mjs', ['create', '--task', 'T1AAAAA', '--json']).json();
    commit(pwt.path, { 'parent.txt': 'parent work\n' });
    const { head } = readyTask(ctx, 'T2BBBBB', { title: 'Child piece', parent: 'T1AAAAA', files: { 'child.txt': 'child work\n' } });
    const main = sha(ctx.root, 'main');
    const r = ctx.run('land.mjs', ['--task', 'T2BBBBB', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json().target, pwt.branch);
    assert.equal(sha(ctx.root, pwt.branch), head);
    assert.equal(fs.readFileSync(path.join(pwt.path, 'child.txt'), 'utf8'), 'child work\n');
    assert.equal(sha(ctx.root, 'main'), main);
  });

  test('an unknown task is exit 3', () => {
    const ctx = setup();
    const r = ctx.run('land.mjs', ['--task', 'T000000', '--json']);
    assert.equal(r.status, 3);
    assert.deepEqual(r.json(), { error: 'no task T000000 in this project\'s ledger', exitCode: 3 });
  });
});

// ---- no ledger skill ---------------------------------------------------------------------------------------------

describe('without a ledger skill', () => {
  test('every command is exit 2 naming the missing role; --help still answers', () => {
    const ctx = setup({ ledger: false, placement: false });
    for (const [script, args] of [['worktree.mjs', ['create', '--task', 'T1AAAAA']], ['worktree.mjs', ['archive', '--task', 'T1AAAAA']], ['land.mjs', ['--task', 'T1AAAAA']], ['land.mjs', ['--task', 'T1AAAAA', '--force']]]) {
      const r = ctx.run(script, args);
      assert.equal(r.status, 2, `${script} ${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stderr, `${ROLE_MISSING('ledger')}\n`);
      const json = ctx.run(script, [...args, '--json']);
      assert.deepEqual(json.json(), { error: ROLE_MISSING('ledger'), exitCode: 2 });
    }
    for (const [script, args] of [['worktree.mjs', ['--help']], ['land.mjs', ['--help']]]) {
      const r = ctx.run(script, args);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /--task T/);
    }
    assert.equal(fs.existsSync(path.join(ctx.harness, 'worktrees')), false, 'nothing was made');
  });
});
