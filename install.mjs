#!/usr/bin/env node
// Installs the skills into a project: node install.mjs <project path> [--skills-only] [--json]
//
// 1. Refuses (exit 2, nothing written) the other runs' folders, anything that is not the top level of a main git
//    checkout, a Node older than 22 (the hooks record this binary's path), and a settings.json that does not parse.
// 2. Copies every jevellan-* folder of skills/ to <project>/.claude/skills/. A copy that already matches is left
//    alone; one that differs, and a jevellan-* folder the package no longer has, is moved to
//    <harness home>/archive/skills/<project>-<time>/ first. Nothing is ever deleted.
// 3. Merges the three ledger hooks into <project>/.claude/settings.json, keeping every other key and hook.
// 4. Writes <project>/.jevellan/project.json when it is missing, with the detected commands.
// 5. Adds .claude/, .jevellan/ and plan.md to <project>/.git/info/exclude when absent.
// 6. Prints what it did.
// --skills-only does steps 2 and 5 only. --json prints the result as one object instead of text.
//
// Everything is checked and planned before the first write, so a refusal leaves the project as it was.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gitLocate, harnessHome } from './skills/jevellan-ledger/scripts/lib/project.mjs';
import { compactTime } from './skills/jevellan-ledger/scripts/lib/ids.mjs';

const USAGE = 'usage: node install.mjs <project path> [--skills-only] [--json]';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_SKILLS = path.join(HERE, 'skills');
export const SKILL_PREFIX = 'jevellan-';
export const HOOK_MARKER = 'jevellan-ledger/hooks/';
export const POST_TOOL_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit';
export const SESSION_START_MATCHERS = ['startup', 'resume', 'compact'];
export const HOOK_TIMEOUT = 10;
// '.claude' without a trailing slash: it must also match the .claude symlink in a task worktree, which '.claude/'
// (directories only) does not.
export const EXCLUDE_LINES = ['.claude', '.jevellan/', 'plan.md'];
export const START_LINE = (project) =>
  `Open a Claude Code session in ${project} and ask it to do something; the coordinator skill takes it from there.`;

class Refusal extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---- refusals ------------------------------------------------------------------------------------------------

// The owner's home from the user database, never from HOME: the guard must hold whatever HOME a process carries.
export function ownerHomeStrict() {
  let home = '';
  try {
    home = os.userInfo().homedir;
  } catch {}
  if (!home) throw new Refusal("refused: cannot read the owner's home folder from the user database");
  return home;
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function within(p, folder) {
  return p === folder || p.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);
}

// The folders of the other runs on this machine. ~/dev and ~/Projects are symlinked to each other on the owner's
// machines, so both spellings are listed, and each entry's realpath too when it exists.
export function forbiddenFolders(home) {
  const named = [];
  for (const base of ['dev', 'Projects']) {
    named.push(path.join(home, base, 'jevellan-skills'), path.join(home, base, 'jevellan'));
  }
  named.push(path.join(home, 'jevellan-projects', 'jevellan-live-sandbox'));
  named.push(path.join(home, 'Projects', 'jevellan-projects', 'jevellan-live-sandbox'));
  const all = new Set();
  for (const folder of named) {
    all.add(folder);
    all.add(realOrSelf(folder));
  }
  return [...all];
}

// Refusal (1): null when `target` (already a realpath) may be installed into, otherwise the reason.
export function forbiddenReason(target, home) {
  for (const folder of forbiddenFolders(home)) {
    if (within(target, folder)) return `refused: ${target} is another run's folder (${folder}); this installer never touches it`;
  }
  for (const base of new Set([home, realOrSelf(home)])) {
    const rel = path.relative(base, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const first = rel.split(path.sep)[0];
    if (first.startsWith('.jevellan') || first === '.jv') {
      return `refused: ${target} is under ${path.join(base, first)}, a machine folder this installer never touches`;
    }
  }
  return null;
}

// Git without the variables that would point it at another repository than the one named on the command line.
function gitEnv() {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete env[name];
  return env;
}

function git(cwd, ...args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv(),
    }).trim();
  } catch {
    return null;
  }
}

// Refusals (2) and (3): the target must be the top level of a main checkout.
export function checkoutReason(target) {
  let stat = null;
  try {
    stat = fs.statSync(target);
  } catch {}
  if (!stat) return `refused: ${target} does not exist`;
  if (!stat.isDirectory()) return `refused: ${target} is not a folder`;
  const top = git(target, 'rev-parse', '--show-toplevel');
  if (!top) return `refused: ${target} is not a git repository; install into the top level of a git checkout`;
  if (realOrSelf(top) !== target) {
    return `refused: ${target} is not the top level of its git checkout; install into ${realOrSelf(top)}`;
  }
  let dotGit = null;
  try {
    dotGit = fs.lstatSync(path.join(target, '.git'));
  } catch {}
  if (dotGit?.isFile()) {
    const main = gitLocate(target)?.root;
    const where = main && main !== target ? `: ${main}` : '';
    return `refused: ${target} is a linked git worktree (its .git is a file); install into the main checkout${where}`;
  }
  if (!dotGit?.isDirectory()) return `refused: ${target} has no .git folder; install into the top level of a main git checkout`;
  return null;
}

function nodeMajor() {
  return Number(String(process.versions.node).split('.')[0]);
}

// A hook command is run by a shell; a path is written inside double quotes, so these characters cannot appear in it.
const UNQUOTABLE = /["$`\\\n\r]/;

function requireFolderOrAbsent(p, what) {
  let stat = null;
  try {
    stat = fs.statSync(p);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Refusal(`refused: cannot read ${p} (${error.code})`);
  }
  if (!stat.isDirectory()) throw new Refusal(`refused: ${p} exists and is not a folder; ${what} must be a folder`);
}

// ---- step 2: skills ------------------------------------------------------------------------------------------

export function sourceSkillNames(source = SOURCE_SKILLS) {
  let entries = [];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch {}
  return entries.filter((e) => e.isDirectory() && e.name.startsWith(SKILL_PREFIX)).map((e) => e.name).sort();
}

// True when the trees at `a` and `b` hold the same entries with the same bytes, link targets and executable bits.
export function sameTree(a, b) {
  let sa;
  let sb;
  try {
    sa = fs.lstatSync(a);
    sb = fs.lstatSync(b);
  } catch {
    return false;
  }
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
    return sa.isSymbolicLink() && sb.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b);
  }
  if (sa.isDirectory() || sb.isDirectory()) {
    if (!sa.isDirectory() || !sb.isDirectory()) return false;
    const na = fs.readdirSync(a).sort();
    const nb = fs.readdirSync(b).sort();
    if (na.length !== nb.length || na.some((name, i) => name !== nb[i])) return false;
    return na.every((name) => sameTree(path.join(a, name), path.join(b, name)));
  }
  if (!sa.isFile() || !sb.isFile()) return false;
  if (sa.size !== sb.size || (sa.mode & 0o111) !== (sb.mode & 0o111)) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function copyTree(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(from), to);
  } else if (stat.isDirectory()) {
    fs.mkdirSync(to);
    for (const name of fs.readdirSync(from).sort()) copyTree(path.join(from, name), path.join(to, name));
    fs.chmodSync(to, stat.mode & 0o777);
  } else if (stat.isFile()) {
    fs.copyFileSync(from, to);
    fs.chmodSync(to, stat.mode & 0o777);
  }
}

// Moves `from` to `to`; across file systems it copies, checks the copy and only then removes the original.
function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    copyTree(from, to);
    if (!sameTree(from, to)) throw new Error(`archiving ${from} to ${to}: the copy does not match`);
    fs.rmSync(from, { recursive: true });
  }
}

function freeName(dir, name) {
  let candidate = path.join(dir, name);
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(dir, `${name}-${n}`);
  return candidate;
}

function planSkills(project, archiveDir) {
  const targetRoot = path.join(project, '.claude', 'skills');
  const names = sourceSkillNames();
  const plan = { copy: [], unchanged: [], archive: [] };
  for (const name of names) {
    const from = path.join(SOURCE_SKILLS, name);
    const to = path.join(targetRoot, name);
    let exists = false;
    try {
      fs.lstatSync(to);
      exists = true;
    } catch {}
    if (exists && sameTree(from, to)) {
      plan.unchanged.push(name);
      continue;
    }
    if (exists) plan.archive.push({ name, from: to, reason: 'changed' });
    plan.copy.push({ name, from, to });
  }
  let present = [];
  try {
    present = fs.readdirSync(targetRoot, { withFileTypes: true });
  } catch {}
  for (const entry of present) {
    if (!entry.name.startsWith(SKILL_PREFIX) || names.includes(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    plan.archive.push({ name: entry.name, from: path.join(targetRoot, entry.name), reason: 'no longer in the package' });
  }
  plan.archiveDir = archiveDir;
  return plan;
}

function applySkills(project, plan, result) {
  fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
  for (const item of plan.archive) {
    const to = freeName(plan.archiveDir, item.name);
    move(item.from, to);
    result.skillsArchived.push({ name: item.name, to, reason: item.reason });
    result.lines.push(`archived ${path.relative(project, item.from)} (${item.reason}) to ${to}`);
    result.changed.push(item.from);
  }
  for (const item of plan.copy) {
    copyTree(item.from, item.to);
    result.skillsCopied.push(item.name);
    result.lines.push(`copied skill ${item.name} to ${path.relative(project, item.to)}`);
    if (!result.changed.includes(item.to)) result.changed.push(item.to);
  }
  result.skillsUnchanged.push(...plan.unchanged);
}

// ---- step 3: settings.json -----------------------------------------------------------------------------------

export function hookCommand(node, project, file) {
  return `"${node}" "${path.join(project, '.claude', 'skills', 'jevellan-ledger', 'hooks', file)}"`;
}

export function ourGroups(node, project) {
  const handler = (file) => ({ type: 'command', command: hookCommand(node, project, file), timeout: HOOK_TIMEOUT });
  return {
    Stop: [{ hooks: [handler('stop.mjs')] }],
    PostToolUse: [{ matcher: POST_TOOL_MATCHER, hooks: [handler('post-tool.mjs')] }],
    SessionStart: SESSION_START_MATCHERS.map((matcher) => ({ matcher, hooks: [handler('session-start.mjs')] })),
  };
}

export function isOurs(handler) {
  return typeof handler?.command === 'string' && handler.command.includes(HOOK_MARKER);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Reads settings.json; refuses anything the merge could not keep intact. Returns {exists, file, settings}.
export function readSettings(project) {
  const file = path.join(project, '.claude', 'settings.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, file, settings: {} };
    if (error.code === 'EISDIR') throw new Refusal(`refused: ${file} is a folder`);
    throw new Refusal(`refused: cannot read ${file} (${error.code})`);
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new Refusal(
      `refused: ${file} is not valid JSON (${error.message}); fix it or move it away and run install again. It was left untouched.`,
    );
  }
  if (!isPlainObject(settings)) throw new Refusal(`refused: ${file} must hold a JSON object; it was left untouched`);
  if (settings.hooks !== undefined) {
    if (!isPlainObject(settings.hooks)) throw new Refusal(`refused: "hooks" in ${file} is not an object; it was left untouched`);
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) throw new Refusal(`refused: "hooks.${event}" in ${file} is not a list; it was left untouched`);
    }
  }
  return { exists: true, file, settings };
}

// Every key and every hook entry stays as it was, except ours: each event that holds ours gets the new groups where
// the first of ours was, an event without ours gets them at the end, and ours disappear from every other event.
export function mergeSettings(settings, groups) {
  const merged = { ...settings };
  const hooks = { ...(isPlainObject(settings.hooks) ? settings.hooks : {}) };
  const events = [...new Set([...Object.keys(hooks), ...Object.keys(groups)])];
  for (const event of events) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const wanted = groups[event] ?? [];
    const hasOurs = existing.some((group) => Array.isArray(group?.hooks) && group.hooks.some(isOurs));
    if (!hasOurs && !wanted.length) continue; // not ours to touch
    const next = [];
    let placed = false;
    for (const group of existing) {
      const handlers = Array.isArray(group?.hooks) ? group.hooks : null;
      if (!handlers || !handlers.some(isOurs)) {
        next.push(group);
        continue;
      }
      if (!placed) {
        next.push(...wanted);
        placed = true;
      }
      const rest = handlers.filter((handler) => !isOurs(handler));
      if (rest.length) next.push({ ...group, hooks: rest });
    }
    if (!placed) next.push(...wanted);
    // An event that held only ours and that the ledger no longer uses goes away with them.
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  merged.hooks = hooks;
  return merged;
}

function writeFileAtomic(file, text) {
  let target = file;
  let mode = null;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
  } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.install-${process.pid}`);
  fs.writeFileSync(temp, text, mode === null ? undefined : { mode });
  if (mode !== null) fs.chmodSync(temp, mode);
  fs.renameSync(temp, target);
}

// ---- step 4: project.json ------------------------------------------------------------------------------------

export function detectProject(project) {
  const remoteHead = git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD');
  const prefix = 'refs/remotes/origin/';
  let defaultBranch = remoteHead && remoteHead.startsWith(prefix) ? remoteHead.slice(prefix.length) : null;
  if (!defaultBranch) defaultBranch = git(project, 'symbolic-ref', '--short', 'HEAD') || 'main';
  let scripts = {};
  let packageProblem = null;
  const packageFile = path.join(project, 'package.json');
  if (fs.existsSync(packageFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      if (isPlainObject(pkg?.scripts)) scripts = pkg.scripts;
    } catch (error) {
      packageProblem = `package.json could not be read (${error.message}); no commands detected`;
    }
  }
  const has = (name) => typeof scripts[name] === 'string' && scripts[name].trim() !== '';
  return {
    config: {
      name: path.basename(project),
      defaultBranch,
      testCommand: has('test') ? 'npm test' : null,
      devCommand: has('dev') ? 'npm run dev' : has('start') ? 'npm start' : null,
      setupCommand: setupCommandFor(project),
      riskyPaths: [],
      checks: [],
      pushAfterLanding: false,
      retentionDays: 3,
    },
    packageProblem,
  };
}

// ---- step 5: .git/info/exclude -------------------------------------------------------------------------------

// A line counts as present when it equals the pattern with an optional leading "/"; a trailing "/" counts only for
// patterns that have one (".claude/" does not cover the worktree's .claude symlink, ".claude" does).
function excludeKey(line, keepSlash = false) {
  let value = line.replace(/\r$/, '').trim();
  if (value.startsWith('/')) value = value.slice(1);
  if (!keepSlash && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

export function missingExcludeLines(text, wanted = EXCLUDE_LINES) {
  const lines = text.split('\n');
  const loose = new Set(lines.map((l) => excludeKey(l)));
  const exact = new Set(lines.map((l) => excludeKey(l, true)));
  return wanted.filter((line) => (line.endsWith('/') ? !loose.has(excludeKey(line)) : !exact.has(excludeKey(line, true))));
}

// What makes a fresh worktree ready to run the project's commands (H-023): the lockfile's install, or none.
export function setupCommandFor(project) {
  const has = (file) => fs.existsSync(path.join(project, file));
  if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (has('yarn.lock')) return 'yarn install --frozen-lockfile';
  if (has('package-lock.json')) return 'npm ci';
  if (has('package.json')) return 'npm install';
  return null;
}

// ---- the run -------------------------------------------------------------------------------------------------

export function install(input, { skillsOnly = false } = {}) {
  const home = ownerHomeStrict();
  const resolved = path.resolve(input);
  const project = realOrSelf(resolved);

  const reason = forbiddenReason(project, home) ?? forbiddenReason(resolved, home) ?? checkoutReason(project);
  if (reason) throw new Refusal(reason);

  const names = sourceSkillNames();
  if (!names.length) throw new Refusal(`refused: no ${SKILL_PREFIX}* folders found in ${SOURCE_SKILLS}`);

  requireFolderOrAbsent(path.join(project, '.claude'), '.claude');
  requireFolderOrAbsent(path.join(project, '.claude', 'skills'), '.claude/skills');
  requireFolderOrAbsent(path.join(project, '.git', 'info'), '.git/info');
  const excludeFile = path.join(project, '.git', 'info', 'exclude');
  try {
    if (fs.statSync(excludeFile).isDirectory()) throw new Refusal(`refused: ${excludeFile} is a folder`);
  } catch (error) {
    if (error instanceof Refusal) throw error;
  }

  let settingsPlan = null;
  let projectPlan = null;
  if (!skillsOnly) {
    if (nodeMajor() < 22) {
      throw new Refusal(
        `refused: this is Node ${process.versions.node}; the hooks run with the Node that runs install, so run install with Node 22 or later`,
      );
    }
    const node = process.execPath;
    for (const [what, value] of [['the Node path', node], ['the project path', project]]) {
      if (UNQUOTABLE.test(value)) {
        throw new Refusal(`refused: ${what} ${JSON.stringify(value)} holds a character that cannot be quoted in a hook command`);
      }
    }
    requireFolderOrAbsent(path.join(project, '.jevellan'), '.jevellan');
    const current = readSettings(project);
    const merged = mergeSettings(current.settings, ourGroups(node, project));
    const changed = !current.exists || JSON.stringify(merged) !== JSON.stringify(current.settings);
    settingsPlan = { file: current.file, exists: current.exists, changed, text: `${JSON.stringify(merged, null, 2)}\n` };
    const projectJson = path.join(project, '.jevellan', 'project.json');
    let exists = false;
    try {
      fs.lstatSync(projectJson);
      exists = true;
    } catch {}
    projectPlan = { file: projectJson, write: !exists, ...(exists ? {} : detectProject(project)) };
  }

  let excludeText = '';
  try {
    excludeText = fs.readFileSync(excludeFile, 'utf8');
  } catch {}
  const excludeMissing = missingExcludeLines(excludeText);

  const archiveDir = path.join(harnessHome(), 'archive', 'skills', `${path.basename(project)}-${compactTime()}`);
  const skillsPlan = planSkills(project, archiveDir);

  // Every check passed: from here on the plan is applied.
  const result = {
    project,
    skillsOnly,
    skillsCopied: [],
    skillsUnchanged: [],
    skillsArchived: [],
    settingsChanged: false,
    projectJsonWritten: false,
    excludeLinesAdded: [],
    changed: [],
    lines: [],
  };

  applySkills(project, skillsPlan, result);

  if (settingsPlan?.changed) {
    writeFileAtomic(settingsPlan.file, settingsPlan.text);
    result.settingsChanged = true;
    result.changed.push(settingsPlan.file);
    result.lines.push(
      `${settingsPlan.exists ? 'merged' : 'wrote'} the Stop, PostToolUse and SessionStart hooks into .claude/settings.json (node ${process.execPath})`,
    );
  }

  if (projectPlan?.write) {
    fs.mkdirSync(path.dirname(projectPlan.file), { recursive: true });
    fs.writeFileSync(projectPlan.file, `${JSON.stringify(projectPlan.config, null, 2)}\n`, { flag: 'wx' });
    result.projectJsonWritten = true;
    result.changed.push(projectPlan.file);
    const { defaultBranch, testCommand, devCommand } = projectPlan.config;
    result.lines.push(
      `wrote .jevellan/project.json (defaultBranch ${defaultBranch}, testCommand ${testCommand ?? 'none'}, devCommand ${devCommand ?? 'none'})`,
    );
    if (projectPlan.packageProblem) result.lines.push(projectPlan.packageProblem);
  }

  if (excludeMissing.length) {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const separator = excludeText && !excludeText.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(excludeFile, `${separator}${excludeMissing.map((line) => `${line}\n`).join('')}`);
    result.excludeLinesAdded = excludeMissing;
    result.changed.push(excludeFile);
    result.lines.push(`added ${excludeMissing.join(', ')} to .git/info/exclude`);
  }

  return result;
}

function report(result) {
  const lines = result.lines.length ? [...result.lines] : ['nothing to change'];
  if (result.skillsOnly) {
    lines.push(`Skills installed in ${result.project}/.claude/skills as plain skills; no hooks or project settings were written (--skills-only).`);
  } else {
    lines.push(START_LINE(result.project));
  }
  return `${lines.join('\n')}\n`;
}

export function main(argv) {
  const json = argv.includes('--json');
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        options: { 'skills-only': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      throw new Refusal(`${error.message.replace(/^TypeError \[[A-Z_]+\]: /, '')}\n${USAGE}`);
    }
    if (parsed.values.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (parsed.positionals.length !== 1) throw new Refusal(USAGE);
    const result = install(parsed.positionals[0], { skillsOnly: Boolean(parsed.values['skills-only']) });
    if (json) {
      const { lines, skillsOnly, ...rest } = result;
      process.stdout.write(`${JSON.stringify({ ...rest, skillsOnly }, null, 2)}\n`);
    } else {
      process.stdout.write(report(result));
    }
    return 0;
  } catch (error) {
    const exitCode = error instanceof Refusal ? error.exitCode : 1;
    const message = error?.message ?? String(error);
    if (json) process.stdout.write(`${JSON.stringify({ error: message, exitCode })}\n`);
    process.stderr.write(`${message}\n`);
    return exitCode;
  }
}

function isEntry() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) process.exitCode = main(process.argv.slice(2));
