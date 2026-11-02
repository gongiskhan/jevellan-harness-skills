#!/usr/bin/env node
// Task worktrees (brief 5.5 and section 1), ported from the skills repo's git.ts and the worktree half of its
// land-git.ts (themselves ported from Jevellan's packages/projects/src/worktree.ts):
//
//   worktree.mjs create --task T [--base <branch>] [--json]
//   worktree.mjs archive --task T [--reason "..."] [--json]
//
// create: the project root comes from git (a worktree finds the main checkout), the task must be in the ledger
// (exit 3). A task that already has a task.worktree whose folder exists gets that path printed again (exit 0), so a
// repeated call changes nothing. The base is --base, else the parent task's branch for a task created with --parent
// (refused while the parent has no worktree), else project.json defaultBranch. `git fetch` runs first when the
// repository has a remote, with HOME set to the owner's home (the skills run's D-079: a caller with another HOME has
// no credential helper); a failed fetch is only a warning, because the local branch is still a valid base. The base
// ref is the local branch, else origin/<base>. Then
//   git worktree add --no-track -b jh/<slug>-<T> <harness home>/worktrees/<project>/<slug>-<T> <base commit>
// followed by .jevellan/evidence/ inside the worktree, a .claude symlink to the project's .claude (so a worker in the
// worktree sees the same skills and hooks), the exclude lines in <git common dir>/info/exclude, and task.worktree
// {branch, path, base, baseCommit}. A worktree already registered at the path on the task branch (a create that was
// interrupted before its ledger line) is finished and recorded instead of refused. A branch that exists without it,
// or a folder at the path that git does not know, refuses (exit 2): nothing is reused that this script did not make.
//
// The exclude lines are ".jevellan/", "plan.md" and ".claude". The last one has no trailing slash on purpose: the
// worktree's .claude is a symlink, and git matches a pattern ending in "/" against directories only, so the ".claude/"
// line install.mjs writes leaves the symlink untracked (verified with git 2.43). Without ".claude" a worker's
// `git add -A` would commit the symlink, and landing would refuse the worktree as dirty.
//
// archive: refused (exit 2) while a step of the task is running (its pid alive). The worktree is moved with
// `git worktree move` to <harness home>/archive/worktrees/<project>/<slug>-<T>-<compact time>: never deleted, the
// branch stays, and git keeps it registered at its new place. A task that has not landed gets step.stopped
// {ordinal: the current step or 1, reason: --reason or "left by the owner"}, so the task is stopped. A worktree that
// is already archived is exit 0 saying so.
//
// Nothing here deletes: no worktree prune, no worktree remove, no branch -D, no removal of a folder. Every git call
// runs without a shell, with GIT_TERMINAL_PROMPT=0. The project's files, HEAD and index are never touched; git runs in
// the main checkout only to change .git metadata and refs.
//
// This file also exports the git helpers land.mjs uses, so the two scripts share one implementation.
//
// Exit codes: 0 ok, 2 refused with the reason on stderr (and {error, exitCode} on stdout with --json), 3 not found.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { importFromRole } from './lib/roles.mjs';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ARCHIVE_REASON = 'left by the owner';
export const BRANCH_PREFIX = 'jh/';

// Each wanted line, and the lines already in the file that count as it (compared without a leading "/").
export const EXCLUDE_LINES = Object.freeze([
  { line: '.jevellan/', accepts: ['.jevellan/', '.jevellan'] },
  { line: 'plan.md', accepts: ['plan.md'] },
  { line: '.claude', accepts: ['.claude'] },
]);

// Paths that never count as uncommitted work in a task worktree: the worker's report and evidence, the plan, and
// the .claude symlink this script makes.
export function isHarnessPath(file) {
  return file === '.jevellan' || file.startsWith('.jevellan/') || file === 'plan.md' || file === '.claude' || file === '.claude/';
}

export class GitSkillError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---- roles ---------------------------------------------------------------------------------------------------

let ledgerModules = null;

// The ledger skill's modules, found through its role (never by folder name). Loaded on first use, so a missing role
// is a refusal with a reason rather than a crash at import.
export async function ledgerRole() {
  if (!ledgerModules) {
    const [ledger, project, ids, lock, redact] = await Promise.all([
      importFromRole('ledger', 'scripts/lib/ledger.mjs'),
      importFromRole('ledger', 'scripts/lib/project.mjs'),
      importFromRole('ledger', 'scripts/lib/ids.mjs'),
      importFromRole('ledger', 'scripts/lib/lock.mjs'),
      importFromRole('ledger', 'scripts/lib/redact.mjs'),
    ]);
    ledgerModules = { ledger, project, ids, lock, redact };
  }
  return ledgerModules;
}

// ---- command line --------------------------------------------------------------------------------------------

export function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false, strict: true });
  } catch (error) {
    throw new GitSkillError(String(error.message).replace(/^TypeError \[[A-Z_]+\]: /, ''));
  }
}

export function print(json, value, text) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (text !== undefined && text !== null) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function warn(text) {
  process.stderr.write(`${text}\n`);
}

// Runs `main(argv)` and sets the exit code. A refusal prints its reason on stderr, and {error, exitCode} on stdout
// with --json. Every message goes through the ledger's redactor when the ledger role is installed.
export async function runCli(main, argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  try {
    const code = await main(argv);
    process.exitCode = Number.isInteger(code) ? code : 0;
  } catch (error) {
    const exitCode = Number.isInteger(error?.exitCode) && error.exitCode > 0 ? error.exitCode : 2;
    let message = String(error?.message ?? error);
    try {
      message = (await ledgerRole()).redact.redactText(message);
    } catch {}
    if (json) process.stdout.write(`${JSON.stringify({ error: message, exitCode })}\n`);
    process.stderr.write(`${message}\n`);
    if (process.env.JH_DEBUG && error?.stack) process.stderr.write(`${error.stack}\n`);
    process.exitCode = exitCode;
  }
}

// True when the module at `url` is the process's entry point (symlinks resolved), so land.mjs and the evals can
// import this file without running it.
export function isMain(url) {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

// ---- git -----------------------------------------------------------------------------------------------------

export function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
}

// The environment of every git call: the process's, without variables that would point git at another repository,
// with prompts off. `extra` adds or overrides keys.
export function gitEnv(extra = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE']) delete env[key];
  return { ...env, ...extra };
}

// Runs git in `cwd` without a shell. Throws a refusal with git's first error line when the exit code is not permitted.
export function git(cwd, args, { permitted = [0], env, timeoutMs = 120000 } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: env ?? gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new GitSkillError(`git ${args[0] ?? ''} failed in ${cwd}: ${r.error.message}`);
  const result = { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  if (!permitted.includes(result.code)) {
    const why = firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`;
    throw new GitSkillError(`git ${args.join(' ')} failed in ${cwd}: ${why}`);
  }
  return result;
}

// The commit a ref names, or undefined.
export function resolveRef(cwd, ref) {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { permitted: [0, 1, 128] });
  const sha = r.stdout.trim();
  return r.code === 0 && sha ? sha : undefined;
}

export function branchExists(cwd, branch) {
  return git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { permitted: [0, 1] }).code === 0;
}

// Whether `ancestor` is an ancestor of (or equal to) `descendant`.
export function isAncestor(cwd, ancestor, descendant) {
  return git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { permitted: [0, 1] }).code === 0;
}

// The branch checked out in `cwd` (short name), or undefined for a detached HEAD.
export function currentBranch(cwd) {
  const r = git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { permitted: [0, 1, 128] });
  const name = r.stdout.trim();
  return r.code === 0 && name ? name : undefined;
}

export function remotes(cwd) {
  return git(cwd, ['remote']).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function checkBranchName(cwd, name, what) {
  if (typeof name !== 'string' || !name.trim() || name.startsWith('-')) throw new GitSkillError(`${what} "${name}" is not a branch name`);
  if (git(cwd, ['check-ref-format', '--branch', name], { permitted: [0, 1, 128] }).code !== 0) {
    throw new GitSkillError(`${what} "${name}" is not a valid branch name`);
  }
}

// `git worktree list --porcelain -z`: NUL-terminated fields, an empty field ends each entry (ported parseWorktrees).
export function parseWorktrees(output) {
  const entries = [];
  let current = null;
  for (const field of output.split('\0')) {
    if (!field) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (current) entries.push(current);
      current = { path: value, prunable: false, locked: false, bare: false };
    } else if (current && key === 'HEAD') current.head = value;
    else if (current && key === 'branch') current.branch = value;
    else if (current && key === 'prunable') current.prunable = true;
    else if (current && key === 'locked') current.locked = true;
    else if (current && key === 'bare') current.bare = true;
  }
  if (current) entries.push(current);
  return entries;
}

export function listWorktrees(root) {
  return parseWorktrees(git(root, ['worktree', 'list', '--porcelain', '-z']).stdout);
}

// The real path of `p`, resolving as much of it as exists (a folder that is not there yet keeps its own name).
export function realish(p) {
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(realish(parent), path.basename(absolute));
  }
}

export function samePath(a, b) {
  return realish(a) === realish(b);
}

export function isUnder(file, dir) {
  const rel = path.relative(realish(dir), realish(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The registered worktree at `p`, or undefined.
export function findWorktree(root, p) {
  return listWorktrees(root).find((e) => samePath(e.path, p));
}

export function present(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Files with uncommitted changes in `cwd` (`git status --porcelain -z`, untracked files included, ignored files not).
// With `paths`, only those paths. The harness's own paths (isHarnessPath) never count in a task worktree; `all`
// counts them too (the main checkout, where they are the owner's files).
export function uncommittedFiles(cwd, paths, { all = false } = {}) {
  if (paths && paths.length === 0) return [];
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'];
  const out = [];
  // Pathspecs in chunks, so a large change cannot exceed the argument limit.
  for (const part of paths ? chunk(paths, 500) : [null]) {
    const r = git(cwd, part ? [...args, '--', ...part.map((p) => `:(literal)${p}`)] : args);
    for (const field of r.stdout.split('\0')) if (field.length > 3) out.push(field.slice(3));
  }
  const files = [...new Set(out)];
  return all ? files : files.filter((file) => !isHarnessPath(file));
}

// At most `max` names, then "and N more".
export function listText(items, max = 10) {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

// The identity commits get, as git itself would resolve it for the project (repository, global and system config,
// GIT_CONFIG_GLOBAL included), falling back to the owner's global config when this process has another HOME.
let cachedIdentity = null;
export function gitIdentity(root, ownerHome) {
  if (cachedIdentity) return cachedIdentity;
  const read = (key, env) => {
    try {
      const r = git(root, ['config', '--get', key], { permitted: [0, 1], env });
      return r.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const ownEnv = gitEnv();
  const ownerEnv = gitEnv({ HOME: ownerHome });
  cachedIdentity = {
    name: read('user.name', ownEnv) ?? read('user.name', ownerEnv),
    email: read('user.email', ownEnv) ?? read('user.email', ownerEnv),
  };
  return cachedIdentity;
}

export function identityEnv(identity) {
  const env = {};
  if (identity.name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = identity.name;
  if (identity.email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = identity.email;
  return env;
}

// ---- the project and its tasks -------------------------------------------------------------------------------

export function requireRoot(L) {
  const root = L.project.projectRoot();
  if (!root) throw new GitSkillError('not inside a git repository: run this from the project folder or one of its worktrees');
  return root;
}

export function requireTask(L, root, id) {
  if (!id) throw new GitSkillError('--task T is required');
  if (!L.ids.isTaskId(id)) throw new GitSkillError(`"${id}" is not a task id (T and six characters)`);
  const { events } = L.ledger.readEvents(root);
  const info = L.ledger.groupByTask(events).get(id);
  if (!info) throw new GitSkillError(`no task ${id} in this project's ledger`, 3);
  return { info, events };
}

export function lastOfKind(events, kind) {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].kind === kind) return events[i];
  return null;
}

// The task's worktree as its last task.worktree line records it, or null.
export function lastWorktree(info) {
  const event = lastOfKind(info.events, 'task.worktree');
  if (!event?.data?.path || !event.data.branch) return null;
  return { ...event.data, seq: event.seq };
}

// .jevellan/project.json: missing is {}; a file that does not parse, or is not an object, refuses (a landing must
// never read a broken file as "no checks").
export function readProjectConfig(L, root) {
  const file = L.project.projectPaths(root).projectJson;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new GitSkillError(`cannot read ${file}: ${error.code ?? error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new GitSkillError(`${file} is not valid JSON: ${error.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GitSkillError(`${file} must hold one JSON object`);
  return raw;
}

export function defaultBranch(L, root, config = readProjectConfig(L, root)) {
  const branch = config.defaultBranch;
  if (typeof branch !== 'string' || !branch.trim()) {
    throw new GitSkillError(`${L.project.projectPaths(root).projectJson} names no defaultBranch; install.mjs writes it, or add it by hand`);
  }
  return branch.trim();
}

export function projectName(root) {
  return path.basename(root);
}

export function worktreesDir(L, root) {
  return path.join(path.resolve(L.project.harnessHome()), 'worktrees', projectName(root));
}

export function archiveDir(L, root) {
  return path.join(path.resolve(L.project.harnessHome()), 'archive', 'worktrees', projectName(root));
}

// ---- create --------------------------------------------------------------------------------------------------

function excludeKey(line) {
  let value = line.replace(/\r$/, '').trim();
  if (value.startsWith('/')) value = value.slice(1);
  return value;
}

// Adds the exclude lines that are absent to <git common dir>/info/exclude. Returns the lines added.
export function ensureExclude(root, commonDir) {
  const file = path.join(commonDir, 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new GitSkillError(`cannot read ${file}: ${error.code ?? error.message}`);
  }
  const present = new Set(text.split('\n').map(excludeKey));
  const missing = EXCLUDE_LINES.filter((w) => !w.accepts.some((a) => present.has(a))).map((w) => w.line);
  if (missing.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const separator = text && !text.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, `${separator}${missing.map((line) => `${line}\n`).join('')}`);
  }
  return missing;
}

// What a task's worktree is based on: --base, else the parent's branch for a child task, else the default branch.
function chooseBase(L, root, info, events, explicit) {
  if (explicit !== undefined) return { base: explicit, from: 'option' };
  const parentId = info.created.data?.parent;
  if (parentId) {
    const parent = L.ledger.groupByTask(events).get(parentId);
    if (!parent) throw new GitSkillError(`task ${info.created.task} names the parent ${parentId}, which is not in this project's ledger`);
    const wt = lastWorktree(parent);
    if (!wt) {
      throw new GitSkillError(`task ${info.created.task} is a child of ${parentId}, which has no worktree yet; make the parent's worktree first, so the child starts from its branch`);
    }
    return { base: wt.branch, from: 'parent' };
  }
  return { base: defaultBranch(L, root), from: 'default' };
}

function baseRefOf(root, base) {
  if (resolveRef(root, `refs/heads/${base}`)) return `refs/heads/${base}`;
  if (resolveRef(root, `refs/remotes/origin/${base}`)) return `refs/remotes/origin/${base}`;
  return null;
}

// The .jevellan/evidence/ folder and the .claude link inside a worktree. A .claude that is already there (a project
// that tracks one) is left alone, with a warning.
function setUpWorktree(root, wtPath, warnings) {
  fs.mkdirSync(path.join(wtPath, '.jevellan', 'evidence'), { recursive: true });
  const link = path.join(wtPath, '.claude');
  const target = path.join(root, '.claude');
  let stat = null;
  try {
    stat = fs.lstatSync(link);
  } catch {}
  if (!stat) {
    fs.symlinkSync(target, link, 'dir');
    return;
  }
  const pointsAt = stat.isSymbolicLink() ? path.resolve(wtPath, fs.readlinkSync(link)) : null;
  if (!pointsAt || !samePath(pointsAt, target)) warnings.push(`${link} exists and is not a link to ${target}; it was left as it is`);
}

async function create(argv) {
  const { values } = parse(argv, { task: { type: 'string' }, base: { type: 'string' }, json: { type: 'boolean' } });
  const L = await ledgerRole();
  const root = requireRoot(L);
  const { info, events } = requireTask(L, root, values.task);
  const task = info.created.task;

  const existing = lastWorktree(info);
  if (existing) {
    if (!present(existing.path)) {
      throw new GitSkillError(`task ${task}'s worktree ${existing.path} no longer exists (archived or moved); its branch ${existing.branch} stays. Nothing was created`);
    }
    const out = { path: existing.path, branch: existing.branch, base: existing.base ?? null, baseCommit: existing.baseCommit ?? null };
    print(values.json, out, out.path);
    return 0;
  }

  const { base } = chooseBase(L, root, info, events, values.base);
  checkBranchName(root, base, 'the base');
  const name = `${L.ids.slugify(info.created.data?.title)}-${task}`;
  const branch = `${BRANCH_PREFIX}${name}`;
  checkBranchName(root, branch, 'the task branch');
  const wtPath = path.join(worktreesDir(L, root), name);
  const warnings = [];

  const registered = findWorktree(root, wtPath);
  let baseCommit;
  if (registered) {
    if (registered.branch !== `refs/heads/${branch}`) {
      throw new GitSkillError(`${wtPath} is already a worktree of ${root} on ${registered.branch ?? 'a detached HEAD'}, not ${branch}`);
    }
    if (registered.prunable || !present(wtPath)) {
      throw new GitSkillError(`the worktree ${wtPath} of ${branch} is registered but its folder is missing; restore it or run git worktree repair`);
    }
    // A create interrupted after `worktree add`: the fork point, not the base's head now (the base may have moved).
    const baseRef = baseRefOf(root, base) ?? base;
    const fork = git(root, ['merge-base', `refs/heads/${branch}`, baseRef], { permitted: [0, 1, 128] }).stdout.trim();
    baseCommit = fork || resolveRef(root, baseRef) || null;
  } else {
    if (branchExists(root, branch)) {
      throw new GitSkillError(`the branch ${branch} already exists in ${root} without its worktree; this script never reuses or deletes a branch it did not make for this task`);
    }
    if (present(wtPath)) throw new GitSkillError(`${wtPath} exists and is not a worktree of ${root}; move it away (nothing here deletes it)`);
    if (remotes(root).length) {
      const r = git(root, ['fetch', '--quiet', '--no-prune'], { permitted: [0, 1, 128], timeoutMs: 60000, env: gitEnv({ HOME: L.project.ownerHome() }) });
      if (r.code !== 0) warnings.push(`git fetch failed (${firstLine(r.stderr) || `exit ${r.code}`}); the worktree starts from the local ${base}`);
    }
    const baseRef = baseRefOf(root, base);
    if (!baseRef) throw new GitSkillError(`the base branch ${base} does not exist in ${root} (neither locally nor as origin/${base})`);
    baseCommit = resolveRef(root, baseRef);
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    const release = L.lock.acquire(path.join(L.project.projectPaths(root).locks, 'worktree.lock'), { timeoutMs: 120000, retryMs: 50, staleMs: 600000 });
    try {
      if (branchExists(root, branch) || present(wtPath)) throw new GitSkillError(`another create made ${branch} meanwhile; run the command again`);
      git(root, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, wtPath, baseCommit]);
    } finally {
      release();
    }
  }

  const finalPath = realish(wtPath);
  setUpWorktree(root, finalPath, warnings);
  const located = L.project.gitLocate(root);
  ensureExclude(root, located?.commonDir ?? path.join(root, '.git'));

  const data = { branch, path: finalPath, base, baseCommit };
  L.ledger.appendEvent(root, { kind: 'task.worktree', task, session: process.env.JH_SESSION, data }, {
    check: (now) => {
      const fresh = L.ledger.groupByTask(now).get(task);
      const other = fresh && lastWorktree(fresh);
      if (other && !samePath(other.path, finalPath)) throw new GitSkillError(`task ${task} got the worktree ${other.path} meanwhile`);
    },
  });
  for (const w of warnings) warn(`warning: ${w}`);
  print(values.json, data, finalPath);
  return 0;
}

// ---- archive -------------------------------------------------------------------------------------------------

async function archive(argv) {
  const { values } = parse(argv, { task: { type: 'string' }, reason: { type: 'string' }, json: { type: 'boolean' } });
  const L = await ledgerRole();
  const root = requireRoot(L);
  const { info } = requireTask(L, root, values.task);
  const task = info.created.task;
  const reason = (values.reason ?? '').replace(/\s+/g, ' ').trim() || DEFAULT_ARCHIVE_REASON;
  const wt = lastWorktree(info);
  if (!wt) throw new GitSkillError(`task ${task} has no worktree`, 3);

  const view = L.ledger.projectTask(info);
  const running = view.steps.filter((s) => s.state === 'running' && L.lock.pidAlive(s.pid));
  if (running.length) {
    const s = running[running.length - 1];
    throw new GitSkillError(`step ${s.ordinal} (${s.duty}) of ${task} is running (pid ${s.pid}); stop it first, then archive the worktree`);
  }
  const landed = info.events.some((e) => e.kind === 'task.landed');

  // Stops the task unless it landed or is stopped already; returns the event or null.
  const stop = () => {
    if (landed) return null;
    return L.ledger.appendEvent(root, { kind: 'step.stopped', task, step: view.currentStep ?? 1, session: process.env.JH_SESSION, data: { ordinal: view.currentStep ?? 1, reason } }, {
      check: (now) => {
        const fresh = L.ledger.groupByTask(now).get(task);
        if (fresh && L.ledger.projectTask(fresh).state === 'stopped') throw new GitSkillError('already stopped', 0);
      },
    });
  };
  const stopOnce = () => {
    try {
      return stop();
    } catch (error) {
      if (error instanceof GitSkillError && error.exitCode === 0) return null;
      throw error;
    }
  };

  const archiveRoot = archiveDir(L, root);
  if (!present(wt.path)) {
    const moved = listWorktrees(root).find((e) => e.branch === `refs/heads/${wt.branch}` && isUnder(e.path, archiveRoot));
    if (!moved) throw new GitSkillError(`the worktree ${wt.path} of ${task} is gone and no archived copy of ${wt.branch} is registered`, 3);
    const stopped = stopOnce();
    const out = { archived: true, already: true, from: wt.path, to: moved.path, branch: wt.branch, stopped: Boolean(stopped) };
    print(values.json, out, `${task} is already archived at ${moved.path}; the branch ${wt.branch} stays.${stopped ? ' The task is stopped.' : ''}`);
    return 0;
  }
  const entry = findWorktree(root, wt.path);
  if (!entry) throw new GitSkillError(`${wt.path} is not a registered worktree of ${root}; nothing was moved`);
  if (entry.locked) throw new GitSkillError(`the worktree ${wt.path} is locked (git worktree unlock it first); nothing was moved`);

  const dest = path.join(archiveRoot, `${path.basename(wt.path)}-${L.ids.compactTime()}`);
  if (present(dest)) throw new GitSkillError(`${dest} already exists; nothing was moved`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  git(root, ['worktree', 'move', wt.path, dest]);
  const stopped = stopOnce();
  const out = { archived: true, already: false, from: wt.path, to: dest, branch: wt.branch, stopped: Boolean(stopped) };
  print(values.json, out, `Archived ${wt.path} to ${dest}; the branch ${wt.branch} stays.${stopped ? ` The task is stopped (${reason}).` : ''}`);
  return 0;
}

// ---- main ----------------------------------------------------------------------------------------------------

const USAGE = `worktree.mjs create --task T [--base <branch>] [--json]
worktree.mjs archive --task T [--reason "..."] [--json]`;

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'create':
      return create(rest);
    case 'archive':
      return archive(rest);
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return 0;
    default:
      throw new GitSkillError(`${command ? `unknown command "${command}"` : 'a command is required'}\n${USAGE}`);
  }
}

if (isMain(import.meta.url)) runCli(main);
