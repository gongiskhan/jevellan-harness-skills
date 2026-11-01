// install.mjs: fresh install, idempotence, the settings merge, project.json detection, the exclude lines, skill
// archiving, --skills-only, and every refusal. Each test works in its own temporary git repositories and points
// JH_HARNESS_HOME at a temporary folder, so nothing reads or writes the machine's real harness folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { START_LINE, forbiddenReason } from '../install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'install.mjs');
const SKILLS = path.join(ROOT, 'skills');
const SCRATCH = process.env.JH_TEST_TMPDIR || os.tmpdir();
const OWNER_HOME = os.userInfo().homedir;
const EXCLUDE = ['.claude/', '.jevellan/', 'plan.md'];
const POST_TOOL_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit';

// Git that reads neither the machine's nor the user's configuration, so fixtures are the same everywhere.
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function sandbox() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, 'install-test-')));
  const harness = path.join(base, 'harness');
  fs.mkdirSync(harness);
  return { base, harness };
}

function env(box, extra = {}) {
  const out = { ...process.env, ...GIT_ENV, JH_HARNESS_HOME: box.harness, GIT_CEILING_DIRECTORIES: box.base, ...extra };
  for (const name of ['JH_TASK', 'JH_STEP', 'JH_DUTY', 'JH_PROJECT', 'JH_SESSION', 'GIT_DIR', 'GIT_WORK_TREE']) delete out[name];
  return out;
}

function git(box, cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: env(box), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(box, name, { branch = 'main', pkg, template = true, commit = false } = {}) {
  const dir = path.join(box.base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(box, dir, 'init', '-q', '-b', branch, ...(template ? [] : ['--template=']));
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  if (commit) git(box, dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

function run(box, args, { node = process.execPath } = {}) {
  const result = spawnSync(node, [INSTALL, ...args], { encoding: 'utf8', env: env(box) });
  let json = null;
  if (args.includes('--json')) {
    try {
      json = JSON.parse(result.stdout);
    } catch {}
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sourceSkillFolders() {
  return fs.readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function installedSkillFolders(project) {
  return fs
    .readdirSync(path.join(project, '.claude', 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('jevellan-'))
    .map((e) => e.name)
    .sort();
}

// Every file under `dir`, relative, with its bytes and executable bits.
function treeFiles(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = { bytes: fs.readFileSync(full).toString('base64'), exec: fs.statSync(full).mode & 0o111 };
    }
  };
  walk(dir);
  return out;
}

// path -> mtime in nanoseconds, for every file and folder under each root (a missing root is recorded as absent).
function snapshot(...roots) {
  const out = {};
  const walk = (p) => {
    let stat;
    try {
      stat = fs.lstatSync(p, { bigint: true });
    } catch {
      out[p] = 'absent';
      return;
    }
    out[p] = `${stat.mtimeNs}:${stat.size}`;
    if (stat.isDirectory()) for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name));
  };
  for (const root of roots) walk(root);
  return out;
}

function projectFiles(project) {
  return [path.join(project, '.claude'), path.join(project, '.jevellan'), path.join(project, '.git', 'info', 'exclude')];
}

function hookFile(project, file) {
  return path.join(project, '.claude', 'skills', 'jevellan-ledger', 'hooks', file);
}

function expectedCommand(project, file) {
  return `"${process.execPath}" "${hookFile(project, file)}"`;
}

function ours(handler) {
  return typeof handler?.command === 'string' && handler.command.includes('jevellan-ledger/hooks/');
}

function countOurs(groups = []) {
  return groups.reduce((n, group) => n + (group.hooks ?? []).filter(ours).length, 0);
}

test('a fresh install writes every skill, the three hooks with absolute Node paths, project.json and the exclude lines', () => {
  const box = sandbox();
  const project = makeRepo(box, 'app', { pkg: { name: 'app', scripts: { test: 'node --test', dev: 'vite' } } });
  const result = run(box, [project, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const out = result.json;
  assert.equal(out.project, project);

  const expected = sourceSkillFolders();
  assert.ok(expected.length >= 1);
  assert.deepEqual(installedSkillFolders(project), expected);
  assert.deepEqual([...out.skillsCopied].sort(), expected);
  assert.deepEqual(out.skillsUnchanged, []);
  assert.deepEqual(out.skillsArchived, []);
  for (const name of expected) {
    assert.deepEqual(treeFiles(path.join(project, '.claude', 'skills', name)), treeFiles(path.join(SKILLS, name)), name);
  }

  const settings = readJson(path.join(project, '.claude', 'settings.json'));
  assert.equal(out.settingsChanged, true);
  assert.deepEqual(Object.keys(settings.hooks), ['Stop', 'PostToolUse', 'SessionStart']);
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal('matcher' in settings.hooks.Stop[0], false);
  assert.deepEqual(settings.hooks.Stop[0].hooks, [{ type: 'command', command: expectedCommand(project, 'stop.mjs'), timeout: 10 }]);
  assert.deepEqual(settings.hooks.PostToolUse, [
    { matcher: POST_TOOL_MATCHER, hooks: [{ type: 'command', command: expectedCommand(project, 'post-tool.mjs'), timeout: 10 }] },
  ]);
  assert.deepEqual(
    settings.hooks.SessionStart.map((group) => group.matcher),
    ['startup', 'resume', 'compact'],
  );
  for (const group of settings.hooks.SessionStart) {
    assert.deepEqual(group.hooks, [{ type: 'command', command: expectedCommand(project, 'session-start.mjs'), timeout: 10 }]);
  }
  for (const group of [...settings.hooks.Stop, ...settings.hooks.PostToolUse, ...settings.hooks.SessionStart]) {
    const [, node, file] = /^"([^"]+)" "([^"]+)"$/.exec(group.hooks[0].command);
    assert.ok(path.isAbsolute(node) && path.isAbsolute(file));
    assert.ok(fs.existsSync(node) && fs.existsSync(file), file);
    const major = Number(execFileSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' }).split('.')[0]);
    assert.ok(major >= 22, `hook Node is ${major}`);
  }
  assert.equal(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8').endsWith('}\n'), true);

  assert.equal(out.projectJsonWritten, true);
  assert.deepEqual(readJson(path.join(project, '.jevellan', 'project.json')), {
    name: 'app',
    defaultBranch: 'main',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    riskyPaths: [],
    checks: [],
    pushAfterLanding: false,
    retentionDays: 3,
  });

  const exclude = fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8').split('\n');
  for (const line of EXCLUDE) assert.ok(exclude.includes(line), line);
  assert.deepEqual(out.excludeLinesAdded, EXCLUDE);
  for (const file of [
    path.join(project, '.claude', 'settings.json'),
    path.join(project, '.jevellan', 'project.json'),
    path.join(project, '.git', 'info', 'exclude'),
    ...expected.map((name) => path.join(project, '.claude', 'skills', name)),
  ]) {
    assert.ok(out.changed.includes(file), file);
  }
});

test('the text output names each change and ends with the start line; a second run says nothing to change', () => {
  const box = sandbox();
  const project = makeRepo(box, 'app');
  const first = run(box, [project]);
  assert.equal(first.status, 0, first.stderr);
  const lines = first.stdout.trimEnd().split('\n');
  assert.equal(lines.at(-1), START_LINE(project));
  assert.equal(
    lines.at(-1),
    `Open a Claude Code session in ${project} and ask it to do something; the coordinator skill takes it from there.`,
  );
  assert.ok(lines.some((line) => line.includes('settings.json')));
  assert.ok(lines.some((line) => line.includes('project.json')));
  assert.ok(lines.some((line) => line.includes('.git/info/exclude')));
  const second = run(box, [project]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(second.stdout.trimEnd().split('\n'), ['nothing to change', START_LINE(project)]);
});

test('a second run changes nothing and leaves every mtime as it was', () => {
  const box = sandbox();
  const project = makeRepo(box, 'app', { pkg: { scripts: { test: 'x' } } });
  assert.equal(run(box, [project, '--json']).status, 0);
  const before = snapshot(...projectFiles(project), box.harness);
  const again = run(box, [project, '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.json.changed, []);
  assert.deepEqual(again.json.skillsCopied, []);
  assert.deepEqual(again.json.skillsArchived, []);
  assert.deepEqual([...again.json.skillsUnchanged].sort(), sourceSkillFolders());
  assert.equal(again.json.settingsChanged, false);
  assert.equal(again.json.projectJsonWritten, false);
  assert.deepEqual(again.json.excludeLinesAdded, []);
  assert.deepEqual(snapshot(...projectFiles(project), box.harness), before);
  const settings = readJson(path.join(project, '.claude', 'settings.json'));
  assert.equal(countOurs(settings.hooks.Stop), 1);
  assert.equal(countOurs(settings.hooks.PostToolUse), 1);
  assert.equal(countOurs(settings.hooks.SessionStart), 3);
});

test('other settings keys and unrelated hooks survive; only the ledger entries are replaced', () => {
  const box = sandbox();
  const project = makeRepo(box, 'app');
  const old = (file) => ({ type: 'command', command: `"/old/node" "/old/place/.claude/skills/jevellan-ledger/hooks/${file}"`, timeout: 5 });
  const userStop = { type: 'command', command: 'echo user-stop' };
  const userStart = { type: 'command', command: 'echo user-start' };
  const preTool = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }];
  const original = {
    model: 'some-model',
    permissions: { allow: ['Bash(ls:*)'], deny: [] },
    env: { FOO: '1' },
    hooks: {
      PreToolUse: preTool,
      Stop: [{ hooks: [userStop] }, { hooks: [old('stop.mjs')] }],
      SessionStart: [{ matcher: 'startup', hooks: [userStart, old('session-start.mjs')] }],
      SessionEnd: [{ hooks: [old('session-end.mjs')] }],
    },
    statusLine: { type: 'command', command: 'echo status' },
  };
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify(original, null, 4));
  const result = run(box, [project, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const settings = readJson(path.join(project, '.claude', 'settings.json'));
  assert.deepEqual(Object.keys(settings), ['model', 'permissions', 'env', 'hooks', 'statusLine']);
  for (const key of ['model', 'permissions', 'env', 'statusLine']) assert.deepEqual(settings[key], original[key]);
  assert.deepEqual(settings.hooks.PreToolUse, preTool);
  assert.equal('SessionEnd' in settings.hooks, false);
  assert.deepEqual(settings.hooks.Stop, [
    { hooks: [userStop] },
    { hooks: [{ type: 'command', command: expectedCommand(project, 'stop.mjs'), timeout: 10 }] },
  ]);
  assert.deepEqual(settings.hooks.SessionStart.map((g) => g.matcher), ['startup', 'resume', 'compact', 'startup']);
  assert.deepEqual(settings.hooks.SessionStart[3], { matcher: 'startup', hooks: [userStart] });
  assert.equal(countOurs(settings.hooks.SessionStart), 3);
  assert.deepEqual(settings.hooks.PostToolUse.map((g) => g.matcher), [POST_TOOL_MATCHER]);
  assert.equal(JSON.stringify(settings).includes('/old/'), false);

  const again = run(box, [project, '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.json.changed, []);
  assert.deepEqual(readJson(path.join(project, '.claude', 'settings.json')), settings);
});

test('settings.json is rewritten only when its content changes, not for formatting', () => {
  const box = sandbox();
  const project = makeRepo(box, 'app');
  assert.equal(run(box, [project]).status, 0);
  const file = path.join(project, '.claude', 'settings.json');
  const compact = JSON.stringify(readJson(file));
  fs.writeFileSync(file, compact);
  const before = snapshot(file);
  const again = run(box, [project, '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.settingsChanged, false);
  assert.equal(fs.readFileSync(file, 'utf8'), compact);
  assert.deepEqual(snapshot(file), before);
});

test('project.json detects npm start when there is no dev script, and the default branch from origin/HEAD', () => {
  const box = sandbox();
  const project = makeRepo(box, 'shop', { pkg: { scripts: { start: 'node server.js' } } });
  git(box, project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  assert.equal(run(box, [project]).status, 0);
  const config = readJson(path.join(project, '.jevellan', 'project.json'));
  assert.equal(config.name, 'shop');
  assert.equal(config.defaultBranch, 'trunk');
  assert.equal(config.testCommand, null);
  assert.equal(config.devCommand, 'npm start');
});

test('project.json without package.json uses the current branch; an existing project.json is never rewritten', () => {
  const box = sandbox();
  const project = makeRepo(box, 'tool', { branch: 'develop' });
  assert.equal(run(box, [project]).status, 0);
  const config = readJson(path.join(project, '.jevellan', 'project.json'));
  assert.equal(config.defaultBranch, 'develop');
  assert.equal(config.testCommand, null);
  assert.equal(config.devCommand, null);

  const other = makeRepo(box, 'kept', { pkg: { scripts: { test: 'x', dev: 'y' } } });
  fs.mkdirSync(path.join(other, '.jevellan'));
  const file = path.join(other, '.jevellan', 'project.json');
  fs.writeFileSync(file, '{"name": "mine", "testCommand": "make check"}\n');
  const before = snapshot(file);
  const result = run(box, [other, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.projectJsonWritten, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"name": "mine", "testCommand": "make check"}\n');
  assert.deepEqual(snapshot(file), before);
});

test('a changed skill is archived then replaced; a retired jevellan folder is archived; other skills stay', () => {
  const box = sandbox();
  const project = makeRepo(box, 'app');
  assert.equal(run(box, [project]).status, 0);
  const skills = path.join(project, '.claude', 'skills');
  const changedFile = path.join(skills, 'jevellan-ledger', 'SKILL.md');
  fs.appendFileSync(changedFile, '\nlocal edit\n');
  const editedText = fs.readFileSync(changedFile, 'utf8');
  fs.mkdirSync(path.join(skills, 'jevellan-retired'));
  fs.writeFileSync(path.join(skills, 'jevellan-retired', 'SKILL.md'), 'retired\n');
  fs.mkdirSync(path.join(skills, 'my-own'));
  fs.writeFileSync(path.join(skills, 'my-own', 'SKILL.md'), 'mine\n');
  fs.writeFileSync(path.join(skills, 'jevellan-notes.txt'), 'a file, not a skill folder\n');
  const ownBefore = snapshot(path.join(skills, 'my-own'), path.join(skills, 'jevellan-notes.txt'));

  const result = run(box, [project, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const out = result.json;
  assert.deepEqual(out.skillsCopied, ['jevellan-ledger']);
  assert.deepEqual(out.skillsArchived.map((a) => a.name).sort(), ['jevellan-ledger', 'jevellan-retired']);
  assert.equal(out.settingsChanged, false);

  const archiveRoot = path.join(box.harness, 'archive', 'skills');
  const runs = fs.readdirSync(archiveRoot);
  assert.equal(runs.length, 1);
  assert.match(runs[0], /^app-\d{8}T\d{9}Z$/);
  const archived = path.join(archiveRoot, runs[0]);
  assert.equal(fs.readFileSync(path.join(archived, 'jevellan-ledger', 'SKILL.md'), 'utf8'), editedText);
  assert.equal(fs.readFileSync(path.join(archived, 'jevellan-retired', 'SKILL.md'), 'utf8'), 'retired\n');
  for (const item of out.skillsArchived) assert.equal(path.dirname(item.to), archived);

  assert.deepEqual(treeFiles(path.join(skills, 'jevellan-ledger')), treeFiles(path.join(SKILLS, 'jevellan-ledger')));
  assert.equal(fs.existsSync(path.join(skills, 'jevellan-retired')), false);
  assert.deepEqual(snapshot(path.join(skills, 'my-own'), path.join(skills, 'jevellan-notes.txt')), ownBefore);
  assert.ok(out.changed.includes(path.join(skills, 'jevellan-ledger')));
  assert.ok(out.changed.includes(path.join(skills, 'jevellan-retired')));
});

test('an executable bit that differs from the package counts as a change', () => {
  const box = sandbox();
  const project = makeRepo(box, 'app');
  assert.equal(run(box, [project]).status, 0);
  const file = hookFile(project, 'stop.mjs');
  const sourceMode = fs.statSync(path.join(SKILLS, 'jevellan-ledger', 'hooks', 'stop.mjs')).mode & 0o777;
  fs.chmodSync(file, sourceMode ^ 0o100);
  const result = run(box, [project, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json.skillsCopied, ['jevellan-ledger']);
  assert.equal(fs.statSync(file).mode & 0o777, sourceMode);
});

test('--skills-only writes the skills and the exclude lines only', () => {
  const box = sandbox();
  const project = makeRepo(box, 'client', { pkg: { scripts: { test: 'x', dev: 'y' } } });
  const result = run(box, [project, '--skills-only', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(installedSkillFolders(project), sourceSkillFolders());
  assert.deepEqual(result.json.excludeLinesAdded, EXCLUDE);
  assert.equal(result.json.settingsChanged, false);
  assert.equal(result.json.projectJsonWritten, false);
  assert.equal(fs.existsSync(path.join(project, '.claude', 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(project, '.jevellan')), false);
  assert.deepEqual(fs.readdirSync(path.join(project, '.claude')), ['skills']);
  const again = run(box, [project, '--skills-only', '--json']);
  assert.deepEqual(again.json.changed, []);
  const text = run(box, [project, '--skills-only']);
  assert.equal(text.status, 0);
  assert.equal(text.stdout.includes('coordinator skill'), false);
});

test('a settings.json that does not parse, or is not an object, is refused and left untouched', () => {
  for (const content of ['{ "hooks": ', '[]', '{"hooks": []}', '{"hooks": {"Stop": {}}}', '']) {
    const box = sandbox();
    const project = makeRepo(box, 'app', { pkg: { scripts: { test: 'x' } } });
    fs.mkdirSync(path.join(project, '.claude'));
    const file = path.join(project, '.claude', 'settings.json');
    fs.writeFileSync(file, content);
    const before = snapshot(...projectFiles(project), box.harness);
    const exclude = fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8');
    const result = run(box, [project]);
    assert.equal(result.status, 2, `${JSON.stringify(content)}: ${result.stderr}`);
    assert.match(result.stderr, /settings\.json/);
    assert.match(result.stderr, /untouched/);
    assert.equal(result.stdout, '');
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.equal(fs.existsSync(path.join(project, '.claude', 'skills')), false);
    assert.equal(fs.existsSync(path.join(project, '.jevellan')), false);
    assert.equal(fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8'), exclude);
    assert.deepEqual(snapshot(...projectFiles(project), box.harness), before);
  }
});

test('a subfolder, a folder outside any repository and a missing path are refused', () => {
  const box = sandbox();
  const project = makeRepo(box, 'app');
  const sub = path.join(project, 'src');
  fs.mkdirSync(sub);
  const plain = path.join(box.base, 'plain');
  fs.mkdirSync(plain);
  const cases = [
    [sub, /not the top level/],
    [plain, /not a git repository/],
    [path.join(box.base, 'missing'), /does not exist/],
    [path.join(project, '.git'), /not a git repository|not the top level/],
  ];
  for (const [target, message] of cases) {
    for (const flags of [[], ['--skills-only']]) {
      const before = snapshot(project, plain, box.harness);
      const result = run(box, [target, ...flags]);
      assert.equal(result.status, 2, `${target}: ${result.stderr}`);
      assert.match(result.stderr, message);
      assert.deepEqual(snapshot(project, plain, box.harness), before);
    }
  }
});

test('a linked worktree is refused with a pointer to the main checkout', () => {
  const box = sandbox();
  const project = makeRepo(box, 'app', { commit: true });
  const worktree = path.join(box.base, 'app-wt');
  git(box, project, 'worktree', 'add', '-q', worktree, '-b', 'wt');
  for (const flags of [[], ['--skills-only']]) {
    const before = snapshot(project, worktree, box.harness);
    const result = run(box, [worktree, ...flags]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /linked git worktree/);
    assert.match(result.stderr, /install into the main checkout/);
    assert.ok(result.stderr.includes(project));
    assert.deepEqual(snapshot(project, worktree, box.harness), before);
  }
});

test("the other runs' folders are refused before anything is written", () => {
  const box = sandbox();
  const targets = [path.join(OWNER_HOME, '.jv'), path.join(OWNER_HOME, '.jevellan-hub'), path.join(OWNER_HOME, '.jevellan-hub', 'missing')];
  if (fs.existsSync(path.join(OWNER_HOME, '.jv'))) {
    const link = path.join(box.base, 'link-to-jv');
    fs.symlinkSync(path.join(OWNER_HOME, '.jv'), link);
    targets.push(link);
  }
  for (const target of targets) {
    // The guard is checked in this process first, so a broken guard fails here and never reaches the installer.
    assert.ok(forbiddenReason(fs.existsSync(target) ? fs.realpathSync(target) : target, OWNER_HOME), target);
    // These folders have live writers of their own, so only what the installer would create is compared.
    const real = fs.existsSync(target) ? fs.realpathSync(target) : target;
    const mine = () => ['.claude', '.jevellan', path.join('.git', 'info', 'exclude')].map((p) => fs.existsSync(path.join(real, p)));
    for (const flags of [['--json'], ['--skills-only']]) {
      const before = mine();
      const result = run(box, [target, ...flags]);
      assert.equal(result.status, 2, `${target}: ${result.stderr}`);
      assert.match(result.stderr, /never touches/);
      assert.deepEqual(mine(), before);
      assert.deepEqual(fs.readdirSync(box.harness), []);
    }
  }
});

test('the guard names the other runs folders, both spellings of dev, and the machine folders', () => {
  const home = '/home/someone';
  const refused = [
    '/home/someone/dev/jevellan-skills',
    '/home/someone/dev/jevellan',
    '/home/someone/Projects/jevellan-skills',
    '/home/someone/Projects/jevellan',
    '/home/someone/jevellan-projects/jevellan-live-sandbox',
    '/home/someone/dev/jevellan-skills/sub',
    '/home/someone/.jv',
    '/home/someone/.jv/worktrees/x',
    '/home/someone/.jevellan-hub',
    '/home/someone/.jevellan-harness/worktrees/app/fix-T000000',
    '/home/someone/.jevellan',
  ];
  const allowed = [
    '/home/someone/dev/jevellan-harness-skills',
    '/home/someone/dev/jevellan-other',
    '/home/someone/jevellan-projects/jevellan-harness-sandbox',
    '/home/someone/.jvx',
    '/home/someone/dev/.jv',
    '/home/other/.jv',
  ];
  for (const target of refused) assert.ok(forbiddenReason(target, home), target);
  for (const target of allowed) assert.equal(forbiddenReason(target, home), null, target);
});

test('the exclude lines count as present in another spelling, and the file is created when missing', () => {
  const box = sandbox();
  const project = makeRepo(box, 'app');
  const file = path.join(project, '.git', 'info', 'exclude');
  fs.writeFileSync(file, '# local\n/plan.md\n.claude');
  const result = run(box, [project, '--skills-only', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json.excludeLinesAdded, ['.jevellan/']);
  assert.equal(fs.readFileSync(file, 'utf8'), '# local\n/plan.md\n.claude\n.jevellan/\n');

  const bare = makeRepo(box, 'bare-template', { template: false });
  assert.equal(fs.existsSync(path.join(bare, '.git', 'info')), false);
  const second = run(box, [bare, '--skills-only', '--json']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(path.join(bare, '.git', 'info', 'exclude'), 'utf8'), '.claude/\n.jevellan/\nplan.md\n');
});

test('a project path that cannot be quoted in a hook command is refused for a full install', () => {
  const box = sandbox();
  const project = makeRepo(box, 'we"ird');
  const before = snapshot(...projectFiles(project), box.harness);
  const result = run(box, [project]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /cannot be quoted/);
  assert.deepEqual(snapshot(...projectFiles(project), box.harness), before);
  assert.equal(run(box, [project, '--skills-only']).status, 0);
});

test('Node older than 22 is refused for a full install, with nothing written', (t) => {
  const versions = path.join(OWNER_HOME, '.nvm', 'versions', 'node');
  let older = null;
  try {
    for (const name of fs.readdirSync(versions).sort()) {
      const major = Number(/^v(\d+)\./.exec(name)?.[1]);
      const bin = path.join(versions, name, 'bin', 'node');
      if (major >= 18 && major < 22 && fs.existsSync(bin)) older = bin;
    }
  } catch {}
  if (!older) {
    t.skip('no Node older than 22 on this machine');
    return;
  }
  const box = sandbox();
  const project = makeRepo(box, 'app');
  const before = snapshot(...projectFiles(project), box.harness);
  const result = run(box, [project], { node: older });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Node 22/);
  assert.deepEqual(snapshot(...projectFiles(project), box.harness), before);
});

test('usage errors exit 2', () => {
  const box = sandbox();
  const project = makeRepo(box, 'app');
  for (const args of [[], [project, project], [project, '--frobnicate']]) {
    const result = run(box, args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}`);
    assert.match(result.stderr, /usage: node install\.mjs/);
  }
  assert.equal(fs.existsSync(path.join(project, '.claude')), false);
  const json = run(box, ['--json']);
  assert.equal(json.status, 2);
  assert.equal(json.json.exitCode, 2);
});

function runInstalledHooks(name) {
  const box = sandbox();
  const project = makeRepo(box, name);
  assert.equal(run(box, [project]).status, 0);
  const settings = readJson(path.join(project, '.claude', 'settings.json'));
  const shell = (command, input) =>
    spawnSync('/bin/sh', ['-c', command], { cwd: project, input: JSON.stringify(input), encoding: 'utf8', env: env(box) });
  const start = shell(settings.hooks.SessionStart[0].hooks[0].command, { cwd: project, hook_event_name: 'SessionStart' });
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /coordinator skill/);
  const stop = shell(settings.hooks.Stop[0].hooks[0].command, { cwd: project, session_id: 's1', stop_hook_active: false });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, '');
  const post = shell(settings.hooks.PostToolUse[0].hooks[0].command, {
    cwd: project,
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  assert.equal(post.status, 0, post.stderr);
  const ledger = fs.readFileSync(path.join(project, '.jevellan', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger.at(-1).kind, 'session.event');
  assert.deepEqual(ledger.at(-1).data, { tool: 'Bash', summary: 'ls' });
}

test('the installed hook commands run as written from the project folder', () => {
  runInstalledHooks('app');
});

// The command line is quoted for a path with a space, and the hooks' entry-point check decodes the module URL.
test('the installed hook commands run from a project path with a space', () => {
  runInstalledHooks('my app');
});
