// The git skill's worktree.mjs, run as a child process from a temporary project the way a coordinator runs it: the
// skills are copied into the project's .claude/skills (so the script finds the ledger through its role), the project
// has a bare "remote", and tasks are written through the ledger library.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HARNESS_HOME, NODE, REPO, TaskScript, childEnv, deadPid, git, livePid, makeRepo, readLedger, tempDir, writeJson } from './helpers/ledger-fixture.mjs';
import { newTaskId } from '../skills/jevellan-ledger/scripts/lib/ids.mjs';

// A global git config of its own, so the scripts' merges and the identity they resolve never depend on the machine.
const GITCONFIG = path.join(tempDir('jh-gitconfig-'), 'gitconfig');
fs.writeFileSync(GITCONFIG, '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n');
const GIT_ENV = { GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1' };

// A project as install.mjs leaves it: .jevellan/project.json, the exclude lines, the skills in .claude/skills, and
// (by default) a bare origin that has main.
function makeProject({ remote = true, config = {} } = {}) {
  const root = makeRepo();
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '.claude/\n.jevellan/\nplan.md\n');
  let bare = null;
  if (remote) {
    bare = tempDir('jh-remote-');
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', 'origin', 'main');
  }
  writeJson(path.join(root, '.jevellan', 'project.json'), {
    name: path.basename(root), defaultBranch: 'main', testCommand: null, riskyPaths: [], checks: [], pushAfterLanding: false, retentionDays: 3, ...config,
  });
  for (const skill of ['jevellan-git', 'jevellan-router', 'jevellan-ledger']) {
    fs.cpSync(path.join(REPO, 'skills', skill), path.join(root, '.claude', 'skills', skill), { recursive: true });
  }
  return { root, bare };
}

// A task written through the ledger library, as the ledger skill's task create would.
function newTask(root, { kind = 'feature', title = 'Add a How to run section!', parent = null, duty } = {}) {
  const t = Object.create(TaskScript.prototype);
  Object.assign(t, { root, session: 'coord-test', task: newTaskId(), kind, duty });
  const data = { kind, title, text: `Brief for ${title}`, parent, after: null, origin: 'owner' };
  if (kind === 'single') data.duty = duty;
  t.created = t.add('task.created', data);
  return t;
}

function run(root, args, { env = {}, cwd } = {}) {
  const script = path.join(root, '.claude', 'skills', 'jevellan-git', 'scripts', 'worktree.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [script, ...args], { cwd: cwd ?? root, env: childEnv({ ...GIT_ENV, ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) }));
  });
}

async function create(root, task, extra = []) {
  const r = await run(root, ['create', '--task', task, '--json', ...extra]);
  assert.equal(r.status, 0, r.stderr);
  return r.json();
}

const sha = (cwd, ref) => git(cwd, 'rev-parse', ref).trim();
const exclude = (root) => fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').split('\n');
const commit = (cwd, file, text, message = `add ${file}`) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-q', '--no-verify', '-m', message);
  return sha(cwd, 'HEAD');
};

describe('worktree.mjs create', () => {
  test('makes the branch, the folder, the .claude link, the evidence folder and the exclude lines, and records task.worktree', async () => {
    const { root } = makeProject();
    const t = newTask(root);
    const out = await create(root, t.task);
    const name = `add-a-how-to-run-section-${t.task}`;
    const expected = path.join(HARNESS_HOME, 'worktrees', path.basename(root), name);
    assert.deepEqual(out, { path: expected, branch: `jh/${name}`, base: 'main', baseCommit: sha(root, 'main') });
    assert.equal(git(expected, 'symbolic-ref', '--short', 'HEAD').trim(), `jh/${name}`);
    const link = path.join(expected, '.claude');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(root, '.claude')));
    assert.ok(fs.existsSync(path.join(link, 'skills', 'jevellan-git', 'SKILL.md')), 'the worktree sees the project skills');
    assert.ok(fs.statSync(path.join(expected, '.jevellan', 'evidence')).isDirectory());
    for (const line of ['.jevellan/', 'plan.md', '.claude']) assert.equal(exclude(root).filter((l) => l === line).length, 1, line);

    // Evidence, the plan and the link never show as work: a worker's `git add -A` commits none of them.
    fs.writeFileSync(path.join(expected, '.jevellan', 'evidence', 'shot.png'), 'png');
    fs.writeFileSync(path.join(expected, '.jevellan', 'report.json'), '{}');
    fs.writeFileSync(path.join(expected, 'plan.md'), '# plan\n');
    assert.equal(git(expected, 'status', '--porcelain', '--untracked-files=all'), '');

    const events = readLedger(root);
    const last = events[events.length - 1];
    assert.equal(last.kind, 'task.worktree');
    assert.equal(last.task, t.task);
    assert.deepEqual(last.data, out);

    // A second task adds no exclude line twice.
    await create(root, newTask(root, { title: 'Second task' }).task);
    for (const line of ['.jevellan/', 'plan.md', '.claude']) assert.equal(exclude(root).filter((l) => l === line).length, 1, line);
    // The main checkout is untouched: still on main, nothing changed in it.
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD').trim(), 'main');
    assert.equal(git(root, 'status', '--porcelain'), '');
  });

  test('a second create prints the same path and appends nothing', async () => {
    const { root } = makeProject();
    const t = newTask(root);
    const first = await create(root, t.task);
    const before = readLedger(root).length;
    const again = await run(root, ['create', '--task', t.task]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, `${first.path}\n`);
    assert.deepEqual(await create(root, t.task), first);
    assert.equal(readLedger(root).length, before);
  });

  test('--base starts the worktree from another branch', async () => {
    const { root } = makeProject();
    git(root, 'checkout', '-q', '-b', 'release');
    const release = commit(root, 'RELEASE.md', 'release notes\n');
    git(root, 'checkout', '-q', 'main');
    const t = newTask(root, { title: 'Fix the release' });
    const out = await create(root, t.task, ['--base', 'release']);
    assert.equal(out.base, 'release');
    assert.equal(out.baseCommit, release);
    assert.ok(fs.existsSync(path.join(out.path, 'RELEASE.md')));
  });

  test('a child task starts from its parent\'s branch; a parent without a worktree refuses', async () => {
    const { root } = makeProject();
    const parent = newTask(root, { title: 'Parent work' });
    const lonely = newTask(root, { title: 'Child of a parent without worktree', parent: parent.task });
    const refused = await run(root, ['create', '--task', lonely.task]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, new RegExp(`child of ${parent.task}, which has no worktree yet`));

    const pwt = await create(root, parent.task);
    const head = commit(pwt.path, 'parent.txt', 'from the parent\n');
    const child = newTask(root, { title: 'Child work', parent: parent.task });
    const out = await create(root, child.task);
    assert.equal(out.base, pwt.branch);
    assert.equal(out.baseCommit, head);
    assert.ok(fs.existsSync(path.join(out.path, 'parent.txt')));
  });

  test('fetches first and starts from origin/<base> when the local branch is missing', async () => {
    const { root, bare } = makeProject();
    const clone = path.join(tempDir('jh-clone-'), 'c');
    git(path.dirname(clone), 'clone', '-q', bare, clone);
    git(clone, 'checkout', '-q', '-b', 'remote-only');
    const remoteHead = commit(clone, 'remote.txt', 'only on the remote\n');
    git(clone, 'push', '-q', 'origin', 'remote-only');
    const t = newTask(root, { title: 'From the remote' });
    const out = await create(root, t.task, ['--base', 'remote-only']);
    assert.equal(out.baseCommit, remoteHead);
    assert.ok(fs.existsSync(path.join(out.path, 'remote.txt')));
    // The task branch does not track the remote branch.
    let tracking = '';
    try {
      tracking = git(root, 'config', '--get-regexp', '^branch\\.');
    } catch (error) {
      assert.equal(error.status, 1, String(error.stderr));
    }
    assert.equal(tracking.trim(), '');
  });

  test('a failed fetch is a warning and the worktree starts from the local branch', async () => {
    const { root } = makeProject();
    git(root, 'remote', 'set-url', 'origin', path.join(tempDir('jh-gone-'), 'missing.git'));
    const t = newTask(root, { title: 'Offline' });
    const r = await run(root, ['create', '--task', t.task]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^warning: git fetch failed \(.+\); the worktree starts from the local main$/m);
    assert.ok(fs.existsSync(r.stdout.trim()));
  });

  test('finishes a create that stopped after git worktree add', async () => {
    const { root } = makeProject();
    const t = newTask(root, { title: 'Interrupted' });
    const name = `interrupted-${t.task}`;
    const where = path.join(HARNESS_HOME, 'worktrees', path.basename(root), name);
    fs.mkdirSync(path.dirname(where), { recursive: true });
    git(root, 'worktree', 'add', '-q', '-b', `jh/${name}`, where, 'main');
    const out = await create(root, t.task);
    assert.deepEqual(out, { path: where, branch: `jh/${name}`, base: 'main', baseCommit: sha(root, 'main') });
    assert.ok(fs.lstatSync(path.join(where, '.claude')).isSymbolicLink());
    assert.equal(readLedger(root).filter((e) => e.kind === 'task.worktree').length, 1);
  });

  test('refusals: unknown task, a bad id, an existing branch, a folder in the way, no default branch', async () => {
    const { root } = makeProject();
    const unknown = await run(root, ['create', '--task', 'T000000', '--json']);
    assert.equal(unknown.status, 3);
    assert.deepEqual(unknown.json(), { error: 'no task T000000 in this project\'s ledger', exitCode: 3 });
    const bad = await run(root, ['create', '--task', 'nope']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /is not a task id/);

    const branchy = newTask(root, { title: 'Branch exists' });
    git(root, 'branch', `jh/branch-exists-${branchy.task}`, 'main');
    const r1 = await run(root, ['create', '--task', branchy.task]);
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /already exists .* without its worktree/);

    const foldered = newTask(root, { title: 'Folder in the way' });
    const where = path.join(HARNESS_HOME, 'worktrees', path.basename(root), `folder-in-the-way-${foldered.task}`);
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, 'keep.txt'), 'mine\n');
    const r2 = await run(root, ['create', '--task', foldered.task]);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /exists and is not a worktree/);
    assert.equal(fs.readFileSync(path.join(where, 'keep.txt'), 'utf8'), 'mine\n');

    const before = readLedger(root).length;
    writeJson(path.join(root, '.jevellan', 'project.json'), { name: 'x' });
    const r3 = await run(root, ['create', '--task', newTask(root, { title: 'No default' }).task]);
    assert.equal(r3.status, 2);
    assert.match(r3.stderr, /names no defaultBranch/);
    assert.equal(readLedger(root).filter((e) => e.kind === 'task.worktree').length, 0);
    assert.equal(readLedger(root).length, before + 1);
  });
});

describe('worktree.mjs create: the setup command', () => {
  const setupFile = (wt, name) => path.join(wt, '.jevellan', name);
  const worktreeOf = (root, task) => readLedger(root).filter((e) => e.task === task && e.kind === 'task.worktree').at(-1)?.data;

  test('a setup that leaves only ignored files and harness files behind succeeds once', async () => {
    const { root } = makeProject({ config: { setupCommand: 'mkdir -p deps && echo lib > deps/lib.js && echo note > .jevellan/extra.txt && echo installed' } });
    commit(root, '.gitignore', 'deps/\n');
    const t = newTask(root, { title: 'Clean setup' });
    const out = await create(root, t.task);
    assert.equal(out.setup.command, 'mkdir -p deps && echo lib > deps/lib.js && echo note > .jevellan/extra.txt && echo installed');
    assert.ok(fs.existsSync(setupFile(out.path, 'setup.done')));
    assert.equal(fs.readFileSync(setupFile(out.path, 'setup.log'), 'utf8'), `$ ${out.setup.command}\ninstalled\n`);
    assert.equal(git(out.path, 'status', '--porcelain', '--untracked-files=all'), '');
  });

  test('a setup that writes an untracked file fails naming it, keeps failing while the file is there, and passes once it is gone', async () => {
    const { root } = makeProject({ config: { setupCommand: 'echo "{}" > package-lock.json && echo added 3 packages' } });
    const t = newTask(root, { title: 'Lockfile setup' });
    const r = await run(root, ['create', '--task', t.task]);
    assert.equal(r.status, 2);
    const wt = worktreeOf(root, t.task);
    assert.ok(wt, 'the worktree is recorded before its setup runs');
    assert.match(r.stderr, new RegExp(`^the worktree ${wt.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is ready but its setupCommand "echo "\\{\\}" > package-lock\\.json && echo added 3 packages" failed \\(it left changes a landing would carry: package-lock\\.json\\); see .*setup\\.log:\nadded 3 packages\n\\[the setupCommand left changes a landing would carry: package-lock\\.json\\. A setup must leave the worktree clean: ignore what it writes in \\.gitignore, or, for npm without a lockfile, use npm install --no-package-lock\\]\n$`));
    assert.equal(fs.existsSync(setupFile(wt.path, 'setup.done')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(setupFile(wt.path, 'setup.changed'), 'utf8')), ['package-lock.json']);
    assert.match(fs.readFileSync(setupFile(wt.path, 'setup.log'), 'utf8'), /^\$ echo .*\nadded 3 packages\n\[the setupCommand left changes a landing would carry: package-lock\.json\..*\]\n$/);
    assert.equal(fs.readFileSync(path.join(wt.path, 'package-lock.json'), 'utf8'), '{}\n', 'nothing is removed');

    // The file shows before the next run too; it is still the setup's, so the setup still fails.
    const again = await run(root, ['create', '--task', t.task]);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /failed \(it left changes a landing would carry: package-lock\.json\)/);
    // A setup that no longer writes it still fails while the file it left is there.
    writeJson(path.join(root, '.jevellan', 'project.json'), { name: path.basename(root), defaultBranch: 'main', setupCommand: 'echo fixed' });
    const fixed = await run(root, ['create', '--task', t.task]);
    assert.equal(fixed.status, 2);
    assert.match(fixed.stderr, /failed \(it left changes a landing would carry: package-lock\.json\)/);
    fs.renameSync(path.join(wt.path, 'package-lock.json'), path.join(tempDir('jh-moved-'), 'package-lock.json'));
    const clean = await run(root, ['create', '--task', t.task, '--json']);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.json().setup, 'echo fixed');
    assert.ok(fs.existsSync(setupFile(wt.path, 'setup.done')));
    assert.equal(readLedger(root).filter((e) => e.task === t.task && e.kind === 'task.worktree').length, 1);
  });

  test('a setup that changes a tracked file fails naming it; a setup that exits non-zero fails with its exit code', async () => {
    const { root } = makeProject({ config: { setupCommand: 'echo appended >> README.md' } });
    const t = newTask(root, { title: 'Tracked change' });
    const r = await run(root, ['create', '--task', t.task]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /failed \(it left changes a landing would carry: README\.md\)/);
    assert.equal(fs.existsSync(setupFile(worktreeOf(root, t.task).path, 'setup.done')), false);

    writeJson(path.join(root, '.jevellan', 'project.json'), { name: path.basename(root), defaultBranch: 'main', setupCommand: 'echo nope >&2; exit 3' });
    const failing = newTask(root, { title: 'Failing setup' });
    const f = await run(root, ['create', '--task', failing.task]);
    assert.equal(f.status, 2);
    assert.match(f.stderr, /is ready but its setupCommand "echo nope >&2; exit 3" failed \(exit 3\); see .*setup\.log:\nnope\n$/);
  });
});

describe('worktree.mjs archive', () => {
  test('moves the worktree into the archive, keeps the branch and every file, and stops the task', async () => {
    const { root } = makeProject();
    const t = newTask(root, { title: 'Left alone' });
    const wt = await create(root, t.task);
    const head = commit(wt.path, 'work.txt', 'committed\n');
    fs.writeFileSync(path.join(wt.path, 'draft.txt'), 'not committed\n');
    t.started(1, { duty: 'implement', pid: deadPid() });
    t.report(1, { status: 'blocked', summary: 'Blocked on a question.' });

    const r = await run(root, ['archive', '--task', t.task, '--reason', 'the owner said Leave it', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = r.json();
    const archiveRoot = path.join(HARNESS_HOME, 'archive', 'worktrees', path.basename(root));
    assert.equal(path.dirname(out.to), archiveRoot);
    assert.match(path.basename(out.to), new RegExp(`^left-alone-${t.task}-\\d{8}T\\d{9}Z$`));
    assert.equal(out.from, wt.path);
    assert.equal(out.stopped, true);
    assert.equal(fs.existsSync(wt.path), false);
    assert.equal(fs.readFileSync(path.join(out.to, 'draft.txt'), 'utf8'), 'not committed\n');
    assert.equal(fs.readFileSync(path.join(out.to, 'work.txt'), 'utf8'), 'committed\n');
    assert.equal(fs.realpathSync(path.join(out.to, '.claude')), fs.realpathSync(path.join(root, '.claude')), 'the link survives the move');
    assert.equal(sha(root, wt.branch), head, 'the branch stays');
    assert.match(git(root, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${out.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`));

    const events = readLedger(root);
    const stop = events[events.length - 1];
    assert.equal(stop.kind, 'step.stopped');
    assert.equal(stop.step, 1);
    assert.deepEqual(stop.data, { ordinal: 1, reason: 'the owner said Leave it' });
    assert.equal(t.view().state, 'stopped');

    const again = await run(root, ['archive', '--task', t.task]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, new RegExp(`${t.task} is already archived at `));
    assert.equal(readLedger(root).length, events.length, 'nothing appended the second time');
    // create does not make a new worktree for an archived task.
    const recreate = await run(root, ['create', '--task', t.task]);
    assert.equal(recreate.status, 2);
    assert.match(recreate.stderr, /no longer exists \(archived or moved\)/);
  });

  test('the default reason, and step 1 when no step ran', async () => {
    const { root } = makeProject();
    const t = newTask(root, { title: 'Never started' });
    await create(root, t.task);
    const r = await run(root, ['archive', '--task', t.task]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Archived .* the branch jh\/never-started-T.{6} stays\. The task is stopped \(left by the owner\)\.\n$/);
    const stop = readLedger(root).at(-1);
    assert.deepEqual(stop.data, { ordinal: 1, reason: 'left by the owner' });
  });

  test('refused while a step is running; a landed task is not stopped', async () => {
    const { root } = makeProject();
    const t = newTask(root, { title: 'Busy' });
    const wt = await create(root, t.task);
    const proc = livePid();
    try {
      t.started(1, { duty: 'implement', pid: proc.pid });
      const before = readLedger(root).length;
      const r = await run(root, ['archive', '--task', t.task, '--json']);
      assert.equal(r.status, 2);
      assert.match(r.json().error, new RegExp(`step 1 \\(implement\\) of ${t.task} is running \\(pid ${proc.pid}\\)`));
      assert.ok(fs.existsSync(wt.path), 'nothing moved');
      assert.equal(readLedger(root).length, before);
    } finally {
      proc.stop();
    }

    const landed = newTask(root, { title: 'Landed already' });
    await create(root, landed.task);
    landed.landed();
    const r2 = await run(root, ['archive', '--task', landed.task, '--json']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json().stopped, false);
    assert.equal(readLedger(root).filter((e) => e.task === landed.task && e.kind === 'step.stopped').length, 0);
  });

  test('a task without a worktree is not found', async () => {
    const { root } = makeProject();
    const r = await run(root, ['archive', '--task', newTask(root).task]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /has no worktree/);
  });
});
