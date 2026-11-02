#!/usr/bin/env node
// The decoupling lint: a skill uses another skill only through that skill's public interface (the scripts at the top
// of its scripts/ folder, run as a child process through runRole, with JSON on stdin or argv and JSON on stdout), and
// shares nothing else with it but the shared ground: the project's .jevellan/ folder, ~/.jevellan-harness/ (through
// JH_HARNESS_HOME and harnessHome()), the project's worktree and Node's built-ins. docs/decoupling.md explains each
// rule; this header records the heuristics.
//
//   node scripts/check-decoupling.mjs [--root <repo root>] [--skill <folder>]...
//
// Exit 0 when clean, 1 with every problem on its own line on stderr ("<file>:<line>: <rule>: <detail>"), 2 on a usage
// error. --skill limits the report to those skill folders; every SKILL.md is still read, because a runRole target is
// checked against the target role's Interface section.
//
// Every file under skills/<x>/ is read (binary files, those holding a NUL byte, are skipped). A skill holds plain files
// only: a symbolic link under skills/<x>/ fails rule b and is not followed (so does a skill folder that is itself a
// link, when no --skill narrows the report), and a node_modules folder fails rule a and is not read; .git folders are
// skipped. Code files are .mjs, .js
// and .cjs (check-roles' CODE_FILE); a TypeScript file (.ts, .mts, .cts, .tsx) fails rule a outright ("skills ship .mjs
// only"). Code is tokenized with check-roles' tokenizer, so comments and regular expressions do not count where a rule
// looks at code. The rules:
//
//   import            (a) every `import ... from`, `export ... from`, `import '...'`, dynamic `import(...)`,
//                     `require(...)` and `x.require(...)` names a Node built-in (`node:x`, or a bare built-in name)
//                     or a relative path that resolves inside skills/<x>/. A package name, an absolute path, a file:
//                     URL, a path into another skill and a computed specifier (one that is not a string literal) fail.
//                     A computed specifier is allowed only under the skill's test/ folder: an own test imports the
//                     copy of its skill that it lays out next to its fakes, and scripts/test-skills.mjs runs it with
//                     no other skill present. Every createRequire token (an identifier, a property such as
//                     module.createRequire, or the string) fails everywhere, test/ included, because the require it
//                     builds takes specifiers the lint cannot follow; so does getBuiltinModule() of "module",
//                     "node:module" or a computed name.
//   path              (b) a path that leaves the skill folder. For every outermost call of path.join, path.resolve,
//                     join, resolve, dirname, new URL and the fs readers and writers (readFile*,
//                     existsSync, stat*, createReadStream, ...), the string literals among its arguments (template
//                     pieces included, in order) are walked as path segments: ".." climbs when no earlier segment of
//                     the call is left to cancel, any other segment descends. When the call is anchored on the file's
//                     own location (import.meta.url, import.meta.filename or __filename), every dirname() in it but
//                     the first climbs one more level (import.meta.dirname and __dirname: every one). The climb fails
//                     when it is larger than the file's depth inside skills/<x>/ (scripts/lib/a.mjs has depth 2), so
//                     the call reaches skills/ or above. Outside such calls (and import specifiers, which rule a
//                     checks), each run of string and template literals joined by "+" is walked the same way as one
//                     path, the pieces concatenated and a template's substitutions taken as segment breaks:
//                     `here + '/../../..'` climbs 3, `${here}/../x` climbs 1, '..' + '/' + '..' climbs 2. An
//                     identifier or a call ends a run. The anchor of a call is not followed through variables:
//                     `path.join(root, '..', '..')` counts two levels whatever root is, which also keeps a skill from
//                     climbing out of the project. The only exception to the climb is scripts/lib/roles.mjs's
//                     SKILLS_ROOT: exactly three ".." in the call assigned to SKILLS_ROOT. The skills folder is the
//                     role scan's alone, so outside roles.mjs every SKILLS_ROOT identifier fails, and so does a `.dir`
//                     read (`.dir`, `?.dir`, `['dir']`) or a `dir` destructured from what skillWithRole, skillsWithRole
//                     or installedSkills returns; the results are followed through the names they are bound to
//                     (`const s = ...`, `for (const s of ...)`, array patterns), the first parameter of an element
//                     callback (map, filter, find, findLast, some, every, forEach, flatMap) and postfix chains
//                     (`[0]`, `.find(...)`), within the file and without scopes. Inside roles.mjs the private
//                     SKILLS_ROOT, a root's dirname (pluginRoot() looks there for .claude-plugin/plugin.json) and
//                     <project>/.claude/skills (runsFromProject()) are fine; outside it they need SKILLS_ROOT or a
//                     climb, which fail. Also failing: any text holding the repository's absolute path (or an absolute
//                     path through a folder named like the repository); a join of ".." with another skill's folder
//                     name; and outside roles.mjs a path call whose arguments mix the role scan (skillWithRole,
//                     skillsWithRole, installedSkills, SKILLS_ROOT) with a "scripts" or "lib" segment, or a `.dir`
//                     with a "lib" segment: that reads or runs another skill's files without runRole.
//   skill-name        (c) another skill's folder name (the names of the other folders under skills/), as a whole word,
//                     anywhere in any file under skills/<x>/ or in the path of one of its files. Its own name is fine.
//   repo-module       (d) a module at the repository root (anything outside skills/): an import that resolves there,
//                     or a code string ending in the repository-relative path of a code file outside skills/
//                     (scripts/check-roles.mjs, test/helpers/...).
//   claude-home       (e) "~/.claude", "$HOME/.claude", a template `${<home>}/.claude`, a home expression joined
//                     with '.claude' (path.join(os.homedir(), '.claude'), home + '/.claude') and ".claude/settings" in
//                     any file: only install.mjs at the repository root touches Claude Code's settings. An identifier
//                     is a home when its name holds "home" and not "harness", or when the file binds it to a value
//                     that starts with such a home (`const h = os.homedir()`, `= os.userInfo().homedir`,
//                     `= process.env.HOME`, `= ownerHome()`, `= <another home name>`; `= harnessHome()` is not one).
//                     The home and settings checks run on every outermost path call, so a join inside
//                     writeFileSync(...), appendFileSync(...), mkdirSync(...) or symlinkSync(...) counts; a call fails
//                     when a home is among its arguments and one of its strings has a ".claude" segment
//                     (".claude-plugin" is not one). Prose that says ".claude" without a home or settings path (the
//                     worktree's .claude link) is fine, and so are the data files under evals/ (trigger cases quote
//                     requests an owner might type, such as a near miss about .claude/settings.json; the code under
//                     evals/ is checked like any other).
//   event-kind        (f) the ledger's KINDS (imported the way check-roles does) is exactly the twenty of EVENT_KINDS,
//                     and no code file under skills/ uses another kind (check-roles' kindsUsed: dotted literals, every
//                     string literal after 'append' or 'record' that is not a flag or a ledger command word,
//                     appendLine's kind, appendEvent and appendChecked objects).
//   run-role          (g) every runRole(role, script, ...) call names its role and script as string literals, the
//                     script as a bare "<name>.mjs", and some skill with that jh-role lists the script in its
//                     Interface section.
//   interface         (g) every SKILL.md ends with a "## Interface" section (no heading after it, fenced code blocks
//                     aside) that lists every script at the top of the skill's scripts/ folder as a bullet starting
//                     with the script name in backticks ("- `ledger.mjs show T --json` -> ..."), lists no script that
//                     is not there, and says "No scripts." when there are none.
//   import-from-role  (h) the word importFromRole anywhere under skills/: that function is gone; use runRole.
//
// Helper copies that differ between skills are not a problem here: check-roles prints them as notices.

import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CODE_FILE, closingIndex, kindsUsed, loadLedger, parseSkillFile, tokenize, KINDS_MODULE } from './check-roles.mjs';

export const EVENT_KINDS = Object.freeze([
  'task.created', 'task.worktree', 'task.workflow', 'task.placed',
  'step.started', 'step.message', 'step.report', 'step.done', 'step.failed', 'step.retrying', 'step.lost', 'step.stopped',
  'session.event', 'session.started', 'session.ended',
  'landing.decided', 'landing.checked', 'task.landed', 'task.asked',
  'note',
]);

export const RULES = Object.freeze({
  import: 'a',
  path: 'b',
  'skill-name': 'c',
  'repo-module': 'd',
  'claude-home': 'e',
  'event-kind': 'f',
  'run-role': 'g',
  interface: 'g',
  'import-from-role': 'h',
});

const TYPESCRIPT_FILE = /\.(ts|mts|cts|tsx)$/;
const ROLES_LIB = 'scripts/lib/roles.mjs';
const PUBLIC_SCRIPT = /^[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/;
const INTERFACE_HEADING = '## Interface';
const NO_SCRIPTS = 'No scripts.';
const SCAN_CALLS = new Set(['skillWithRole', 'skillsWithRole', 'installedSkills']);
const ROLE_SCAN = new Set([...SCAN_CALLS, 'SKILLS_ROOT']);
// The array methods whose callback's first parameter is an element of the array they are called on.
const ELEMENT_CALLBACKS = new Set(['map', 'filter', 'find', 'findLast', 'some', 'every', 'forEach', 'flatMap']);
const PATH_CALLS = new Set(['join', 'resolve', 'dirname', 'URL']);
const FS_CALL = /^(readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|existsSync|statSync|lstatSync|stat|lstat|createReadStream|createWriteStream|readdir|readdirSync|opendir|opendirSync|access|accessSync|open|openSync|realpath|realpathSync|copyFile|copyFileSync|cp|cpSync|readlink|readlinkSync|symlink|symlinkSync|rename|renameSync|mkdir|mkdirSync|rm|rmSync|watch)$/;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SYMLINK = 'a symbolic link; a skill holds plain files only';
const NODE_MODULES = 'a node_modules folder; Node built-ins only';
const TYPESCRIPT = 'a TypeScript file; skills ship .mjs only';
const CREATE_REQUIRE = 'createRequire builds a require the lint cannot follow; import Node built-ins statically';
const BUILTIN_MODULE = 'getBuiltinModule() of "module" (or of a computed name) reaches createRequire, a require the lint cannot follow; import Node built-ins statically';
const SCAN_FOLDER = 'the skills folder is the role scan\'s alone; use runRole or the scan\'s results';

// ---- files ---------------------------------------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Every plain file under a skill folder, with a problem for each symbolic link (a file or a folder) and each
// node_modules folder, neither of which is followed. .git folders are skipped. Paths in problems are relative to root.
function walkSkill(dir, root) {
  const files = [];
  const problems = [];
  const visit = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      const rel = posix(path.relative(root, full));
      const link = entry.isSymbolicLink();
      if (link) problems.push({ file: rel, line: 1, rule: 'path', detail: SYMLINK });
      if (entry.name === 'node_modules' && (link || entry.isDirectory())) {
        problems.push({ file: rel, line: 1, rule: 'import', detail: NODE_MODULES });
        continue;
      }
      if (link) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(dir);
  return { files, problems };
}

const posix = (p) => p.split(path.sep).join('/');
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

// The symbolic links directly under skills/: a skill folder that is a link would escape the lint.
function linkedSkillFolders(root) {
  try {
    return fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true }).filter((e) => e.isSymbolicLink()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// The folders under skills/, each a skill.
export function skillFolders(root) {
  try {
    return fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// ---- Interface sections --------------------------------------------------------------------------------------------

// The "## Interface" section of a SKILL.md text: {line (1-based), lines, last, after (the first heading after it, or
// null)}, or null when there is none. Headings inside fenced code blocks and the frontmatter do not count.
export function interfaceSection(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    start = end < 0 ? lines.length : end + 1;
  }
  let fenced = false;
  let found = null;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      if (found) found.lines.push(line);
      continue;
    }
    const heading = !fenced && /^#{1,6}\s/.test(line);
    if (found) {
      if (heading) {
        found.after = { line: i + 1, text: line.trim() };
        found.last = false;
        break;
      }
      found.lines.push(line);
    } else if (heading && line.trim() === INTERFACE_HEADING) {
      found = { line: i + 1, lines: [], last: true, after: null };
    }
  }
  return found;
}

// The script names an Interface section lists: bullets ("-" or "*") whose text starts with a backticked name ending
// in .mjs.
export function interfaceScripts(section) {
  const names = [];
  for (const line of section?.lines ?? []) {
    const match = /^\s*[-*]\s+`([^`\s]+)/.exec(line);
    if (!match) continue;
    const name = match[1].split('/').pop();
    if (name.endsWith('.mjs') && !names.includes(name)) names.push(name);
  }
  return names;
}

function topScripts(skillDir) {
  try {
    return fs.readdirSync(path.join(skillDir, 'scripts'), { withFileTypes: true })
      .filter((e) => e.isFile() && CODE_FILE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Every skill folder's SKILL.md: {folder, role, text, section, listed, scripts}.
export function readInterfaces(root) {
  const out = new Map();
  for (const folder of skillFolders(root)) {
    const dir = path.join(root, 'skills', folder);
    let text = null;
    try {
      text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    } catch {}
    const data = text ? parseSkillFile(text).data ?? {} : {};
    const section = text ? interfaceSection(text) : null;
    out.set(folder, {
      folder,
      dir,
      text,
      role: typeof data['jh-role'] === 'string' ? data['jh-role'] : null,
      section,
      listed: interfaceScripts(section),
      scripts: topScripts(dir),
    });
  }
  return out;
}

function interfaceProblems(info) {
  const rel = `skills/${info.folder}/SKILL.md`;
  const problems = [];
  const add = (line, detail) => problems.push({ file: rel, line, rule: 'interface', detail });
  if (info.text === null) {
    add(1, 'SKILL.md is missing; every skill needs one, ending with a "## Interface" section');
    return problems;
  }
  const { section, scripts, listed } = info;
  if (!section) {
    add(1, `no "${INTERFACE_HEADING}" section; end the body with one listing every script at the top of scripts/ ("${NO_SCRIPTS}" when there are none)`);
    return problems;
  }
  if (!section.last) {
    add(section.after.line, `the "${INTERFACE_HEADING}" section must be the last section of the body; "${section.after.text}" follows it`);
  }
  const says = section.lines.join('\n');
  if (scripts.length === 0 && !says.includes(NO_SCRIPTS)) {
    add(section.line, `the skill has no scripts, so its Interface section must say "${NO_SCRIPTS}"`);
  }
  if (scripts.length > 0 && says.includes(NO_SCRIPTS)) {
    add(section.line, `the section says "${NO_SCRIPTS}" but scripts/ holds ${scripts.join(', ')}`);
  }
  for (const script of scripts) {
    if (!listed.includes(script)) {
      add(section.line, `scripts/${script} is not listed; add a bullet starting with \`${script}\` (what it takes, what it prints, its exit codes), or move a script only this skill runs into scripts/lib/`);
    }
  }
  for (const name of listed) {
    if (!scripts.includes(name)) add(section.line, `lists \`${name}\`, which is not a script at the top of scripts/`);
  }
  return problems;
}

// ---- code ----------------------------------------------------------------------------------------------------------

// Every import-like site: {spec (null when computed), line, how, index (of the specifier token, or -1), detail (set
// for a site the lint can never follow, which no folder excuses)}. `x.require(...)` counts as require(...); every
// createRequire token (an identifier, a property or a string) and getBuiltinModule('module') (or of a computed name)
// is a site of its own, since the require it builds takes specifiers the lint cannot see.
export function importsOf(tokens) {
  const out = [];
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if ((t.type === 'ident' || t.type === 'string') && t.value === 'createRequire') {
      out.push({ spec: null, line: t.line, how: '', index: -1, detail: CREATE_REQUIRE });
      return;
    }
    if (t.type !== 'ident') return;
    if (t.value === 'getBuiltinModule' && isPunct(next, '(') && prev?.value !== 'function') {
      const arg = tokens[i + 2];
      const literal = arg?.type === 'string' && [')', ','].includes(tokens[i + 3]?.value);
      if (!literal || arg.value === 'module' || arg.value === 'node:module') out.push({ spec: null, line: t.line, how: '', index: -1, detail: BUILTIN_MODULE });
      return;
    }
    if (isPunct(prev, '.') && t.value !== 'require') return;
    if ((t.value === 'from' || t.value === 'import') && next?.type === 'string') {
      out.push({ spec: next.value, line: next.line, how: '', index: i + 1 });
    } else if ((t.value === 'import' || t.value === 'require') && next?.value === '(' && prev?.value !== 'function') {
      const arg = tokens[i + 2];
      const after = tokens[i + 3];
      const literal = arg?.type === 'string' && [')', ','].includes(after?.value);
      out.push({ spec: literal ? arg.value : null, line: t.line, how: `${t.value}(): `, index: literal ? i + 2 : -1 });
    }
  });
  return out;
}

// The problem with one specifier, or null. ctx: {file (absolute), skillDir, skillsDir, root}.
export function specifierProblem(spec, { file, skillDir, skillsDir, root }) {
  const rel = (p) => posix(path.relative(root, p));
  if (spec === null) {
    return { rule: 'import', detail: 'a computed specifier the lint cannot check; import a string literal (a Node built-in or a relative path inside the skill)' };
  }
  if (spec.startsWith('node:')) return isBuiltin(spec) ? null : { rule: 'import', detail: `"${spec}" is not a Node built-in` };
  if (isBuiltin(spec)) return null;
  let target;
  if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) target = path.resolve(path.dirname(file), spec);
  else if (spec.startsWith('file:')) {
    try {
      target = fileURLToPath(spec);
    } catch {
      return { rule: 'import', detail: `"${spec}" is not a usable file URL` };
    }
  } else if (path.isAbsolute(spec)) target = spec;
  else {
    return { rule: 'import', detail: `"${spec}" is neither a Node built-in nor a relative path inside the skill (Node built-ins only, no packages)` };
  }
  const absolute = !spec.startsWith('.');
  if (inside(target, skillDir)) {
    return absolute ? { rule: 'import', detail: `"${spec}" is an absolute specifier; use a relative path inside the skill` } : null;
  }
  if (inside(target, skillsDir)) {
    return { rule: 'import', detail: `"${spec}" resolves to ${rel(target)}, another skill's files; use that skill through runRole and a script its Interface lists` };
  }
  if (inside(target, root)) {
    return { rule: 'repo-module', detail: `"${spec}" resolves to ${rel(target)}, a module at the repository root outside skills/; a skill keeps its own copy of what it needs` };
  }
  return { rule: 'import', detail: `"${spec}" resolves outside the skill folder (${target})` };
}

// Walks path segments from the strings of one call. Returns how many levels the call climbs above its start.
export function climbOf(strings) {
  let below = 0;
  let climb = 0;
  for (const text of strings) {
    for (const segment of String(text).split(/[\\/]+/)) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        if (below > 0) below -= 1;
        else climb += 1;
      } else {
        below += 1;
      }
    }
  }
  return climb;
}

const isPunct = (t, value) => t?.type === 'punct' && t.value === value;

function stringsIn(tokens, from, to) {
  const out = [];
  for (let j = from; j <= to && j < tokens.length; j += 1) {
    const t = tokens[j];
    if (t.type === 'string') out.push(t.value);
    else if (t.type === 'template') out.push(...t.parts);
  }
  return out;
}

function anchorOf(tokens, from, to) {
  let file = false;
  let dir = false;
  for (let j = from; j <= to && j < tokens.length; j += 1) {
    const t = tokens[j];
    if (t.type !== 'ident') continue;
    if (t.value === '__filename') file = true;
    if (t.value === '__dirname') dir = true;
    if (t.value === 'import' && isPunct(tokens[j + 1], '.') && tokens[j + 2]?.value === 'meta' && isPunct(tokens[j + 3], '.')) {
      const what = tokens[j + 4]?.value;
      if (what === 'url' || what === 'filename') file = true;
      if (what === 'dirname') dir = true;
    }
  }
  return { file, dir };
}

const isCallAt = (tokens, i) => tokens[i]?.type === 'ident' && isPunct(tokens[i + 1], '(') && tokens[i - 1]?.value !== 'function';

// import() and require() are the import rule's (a); everything else that takes a path is here.
function isPathCall(tokens, i) {
  if (!isCallAt(tokens, i)) return false;
  const name = tokens[i].value;
  if (name === 'URL') return tokens[i - 1]?.value === 'new';
  return PATH_CALLS.has(name) || FS_CALL.test(name);
}

// An identifier named like a home folder: its name holds "home" and not "harness" (harnessHome(), JH_HARNESS_HOME).
const namedHome = (t) => t?.type === 'ident' && /home/i.test(t.value) && !/harness/i.test(t.value);

// The index of the first token of the value `tokens[i]` is bound to (`const x = <value>`, `x = <value>`, a default
// parameter), past an `await`, or -1 when tokens[i] is not a name being bound.
function boundValueAt(tokens, i) {
  if (tokens[i]?.type !== 'ident' || isPunct(tokens[i - 1], '.') || !isPunct(tokens[i + 1], '=')) return -1;
  if (isPunct(tokens[i + 2], '=') || isPunct(tokens[i + 2], '>')) return -1;
  return tokens[i + 2]?.type === 'ident' && tokens[i + 2].value === 'await' ? i + 3 : i + 2;
}

// The postfix chain after the primary that ends at `i` (a name, or a call's name): its steps {kind: 'prop', name,
// index} for `.x`, `?.x` and `['x']`, {kind: 'call', open, close} for `(...)`, {kind: 'index'} for any other `[...]`.
function postfixSteps(tokens, i) {
  const steps = [];
  let j = i + 1;
  while (j < tokens.length) {
    if (isPunct(tokens[j], '?') && isPunct(tokens[j + 1], '.')) {
      j += 1;
      if (isPunct(tokens[j + 1], '(') || isPunct(tokens[j + 1], '[')) j += 1;
    }
    const t = tokens[j];
    if (isPunct(t, '.') && tokens[j + 1]?.type === 'ident') {
      steps.push({ kind: 'prop', name: tokens[j + 1].value, index: j + 1 });
      j += 2;
    } else if (isPunct(t, '(')) {
      const close = closingIndex(tokens, j);
      steps.push({ kind: 'call', open: j, close });
      j = close + 1;
    } else if (isPunct(t, '[')) {
      const close = closingIndex(tokens, j);
      if (tokens[j + 1]?.type === 'string' && close === j + 2) steps.push({ kind: 'prop', name: tokens[j + 1].value, index: j + 1 });
      else steps.push({ kind: 'index' });
      j = close + 1;
    } else {
      break;
    }
  }
  return steps;
}

// The names a file binds to a home folder: `const x = os.homedir()`, `= os.userInfo().homedir`, `= process.env.HOME`,
// `= ownerHome()`, `= <another such name>`; a value counts when it starts with a chain of names and calls that holds
// a home identifier (so `= harnessHome()` and `= process.env.JH_HARNESS_HOME` do not).
function homeNames(tokens) {
  const names = new Set();
  for (let grew = true; grew;) {
    grew = false;
    tokens.forEach((t, i) => {
      if (t.type !== 'ident' || names.has(t.value) || namedHome(t)) return;
      const at = boundValueAt(tokens, i);
      if (at < 0 || tokens[at]?.type !== 'ident') return;
      const chain = [tokens[at], ...postfixSteps(tokens, at).filter((s) => s.kind === 'prop').map((s) => tokens[s.index])];
      if (chain.some((c) => namedHome(c) || (c.type === 'ident' && names.has(c.value)))) {
        names.add(t.value);
        grew = true;
      }
    });
  }
  return names;
}

// The index of the token opening the bracket that closes at `close`, or -1.
function openingIndex(tokens, close) {
  let depth = 0;
  for (let j = close; j >= 0; j -= 1) {
    const t = tokens[j];
    if (t.type !== 'punct') continue;
    if ([')', ']', '}'].includes(t.value)) depth += 1;
    else if (['(', '[', '{'].includes(t.value)) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// The `dir` key of the object pattern opened at `open` (`{ dir }`, `{ dir: where }`, `{ dir = x }`): its index, or -1.
function dirKeyIn(tokens, open) {
  const end = closingIndex(tokens, open);
  let depth = 0;
  for (let j = open; j < end; j += 1) {
    const t = tokens[j];
    if (t.type === 'punct' && ['(', '[', '{'].includes(t.value)) depth += 1;
    else if (t.type === 'punct' && [')', ']', '}'].includes(t.value)) depth -= 1;
    else if (depth === 1 && (t.type === 'ident' || t.type === 'string') && t.value === 'dir' && (isPunct(tokens[j - 1], '{') || isPunct(tokens[j - 1], ',')) &&
             [',', '}', ':', '='].some((v) => isPunct(tokens[j + 1], v))) {
      return j;
    }
  }
  return -1;
}

// Rule b's role scan handle, outside scripts/lib/roles.mjs: every SKILLS_ROOT identifier, and every `.dir` read or
// `dir` destructured from what skillWithRole, skillsWithRole or installedSkills returns. The scan's results are
// followed through the names they are bound to (`const s = skillWithRole(...)`, `for (const s of list)`), the first
// parameter of an element callback (`list.map((s) => ...)`) and their postfix chains (`list[0]`, `.find(...)`), within
// the file and without scopes.
function scanHandleProblems(tokens, add) {
  const reported = new Set();
  const report = (index, detail) => {
    if (reported.has(index)) return;
    reported.add(index);
    add(tokens[index].line, 'path', detail);
  };
  tokens.forEach((t, i) => {
    if (t.type === 'ident' && t.value === 'SKILLS_ROOT') report(i, `SKILLS_ROOT outside ${ROLES_LIB}: ${SCAN_FOLDER}`);
  });
  const dirRead = `.dir of a role scan result: ${SCAN_FOLDER} (name, meta, body, text)`;
  const dirTaken = `dir destructured from a role scan result: ${SCAN_FOLDER} (name, meta, body, text)`;
  const results = new Set();
  // A name or pattern bound to a scan result: a name joins `results`, a pattern's `dir` key is reported, and the
  // elements of an array pattern are bound in turn.
  const bind = (at) => {
    const t = tokens[at];
    if (t?.type === 'ident') {
      if (results.has(t.value)) return false;
      results.add(t.value);
      return true;
    }
    if (isPunct(t, '{')) {
      const key = dirKeyIn(tokens, at);
      if (key >= 0) report(key, dirTaken);
      return false;
    }
    if (isPunct(t, '[')) {
      let grew = false;
      const end = closingIndex(tokens, at);
      let depth = 0;
      for (let j = at; j < end; j += 1) {
        const e = tokens[j];
        if (e.type === 'punct' && ['(', '[', '{'].includes(e.value)) {
          depth += 1;
          if (depth === 2 && e.value === '{') bind(j);
        } else if (e.type === 'punct' && [')', ']', '}'].includes(e.value)) depth -= 1;
        else if (depth === 1 && e.type === 'ident' && (isPunct(tokens[j - 1], '[') || isPunct(tokens[j - 1], ','))) grew = bind(j) || grew;
      }
      return grew;
    }
    return false;
  };
  // The first parameter of the callback that opens at `at` (`(s) => ...`, `s => ...`, `function (s) {...}`).
  const callbackParam = (at) => {
    let k = at;
    if (tokens[k]?.value === 'async') k += 1;
    if (tokens[k]?.value === 'function') {
      k += 1;
      if (tokens[k]?.type === 'ident') k += 1;
      return isPunct(tokens[k], '(') ? k + 1 : -1;
    }
    if (tokens[k]?.type === 'ident' && isPunct(tokens[k + 1], '=') && isPunct(tokens[k + 2], '>')) return k;
    if (isPunct(tokens[k], '(') && isPunct(tokens[closingIndex(tokens, k) + 1], '=') && isPunct(tokens[closingIndex(tokens, k) + 2], '>')) return k + 1;
    return -1;
  };
  const isSource = (i) => {
    const t = tokens[i];
    if (t?.type !== 'ident') return false;
    if (SCAN_CALLS.has(t.value)) return isPunct(tokens[i + 1], '(') && tokens[i - 1]?.value !== 'function';
    return results.has(t.value) && !isPunct(tokens[i - 1], '.');
  };
  for (let grew = true; grew;) {
    grew = false;
    for (let i = 0; i < tokens.length; i += 1) {
      if (!isSource(i)) continue;
      const steps = postfixSteps(tokens, i);
      steps.forEach((step, n) => {
        if (step.kind === 'prop' && step.name === 'dir') report(step.index, dirRead);
        const method = steps[n - 1];
        if (step.kind === 'call' && method?.kind === 'prop' && ELEMENT_CALLBACKS.has(method.name)) {
          const param = callbackParam(step.open + 1);
          if (param >= 0) grew = bind(param) || grew;
        }
      });
      // What the source is bound to: `<target> = [await] <source>` or `for (const <target> of <source>)`.
      let before = i - 1;
      if (tokens[before]?.value === 'await') before -= 1;
      const operator = tokens[before];
      let target = -1;
      if (isPunct(operator, '=') && !['=', '!', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '?'].some((v) => isPunct(tokens[before - 1], v))) target = before - 1;
      else if (operator?.type === 'ident' && operator.value === 'of') target = before - 1;
      if (target < 0 || isPunct(tokens[target - 1], '.')) continue;
      if (isPunct(tokens[target], '}') || isPunct(tokens[target], ']')) target = openingIndex(tokens, target);
      if (target >= 0) grew = bind(target) || grew;
    }
  }
}

// Runs of string and template literals joined by '+' outside path calls: [{start, pieces, text, line}], each run
// walked as one path. `covered` holds the token indexes of path calls and import specifiers; an identifier or a call
// ends a run.
function literalRuns(tokens, covered) {
  const templateFrom = new Map();
  tokens.forEach((t, k) => {
    if (t.type !== 'template') return;
    const from = t.from >= 0 ? t.from : k;
    templateFrom.set(from, Math.max(templateFrom.get(from) ?? -1, k));
  });
  const used = new Set();
  // The literal operands that start at token j: a template beginning there, or a string token.
  const operandsAt = (j) => {
    const out = [];
    const k = templateFrom.get(j);
    if (k !== undefined && !covered.has(k) && !used.has(k)) out.push({ end: k, text: tokens[k].parts.join('${...}'), path: tokens[k].parts.join('/') });
    if (tokens[j]?.type === 'string' && !covered.has(j) && !used.has(j)) out.push({ end: j, text: tokens[j].value, path: tokens[j].value });
    return out;
  };
  const runs = [];
  for (let i = 0; i < tokens.length; i += 1) {
    for (const first of operandsAt(i)) {
      if (used.has(first.end)) continue;
      used.add(first.end);
      const run = { line: tokens[first.end].line, text: first.text, path: first.path };
      let end = first.end;
      while (isPunct(tokens[end + 1], '+')) {
        const next = operandsAt(end + 2)[0];
        if (!next) break;
        used.add(next.end);
        run.text += next.text;
        run.path += next.path;
        end = next.end;
      }
      runs.push(run);
    }
  }
  return runs;
}

// Problems of rules b, d (strings) and e (home folders) in one code file. ctx: {rel, relInSkill, depth, otherNames,
// repoModules, skip (indexes of import specifiers, which rule a checks)}.
export function codePathProblems(tokens, ctx) {
  const problems = [];
  const add = (line, rule, detail) => problems.push({ file: ctx.rel, line, rule, detail });
  const isRolesLib = ctx.relInSkill === ROLES_LIB;
  const homes = homeNames(tokens);
  const isHome = (t) => namedHome(t) || (t?.type === 'ident' && homes.has(t.value));
  const claudeSegment = (s) => String(s).split(/[\\/]+/).includes('.claude');
  if (!isRolesLib) scanHandleProblems(tokens, add);
  let skillsRootCall = -1;
  if (isRolesLib) {
    const at = tokens.findIndex((t, i) => t.type === 'ident' && t.value === 'SKILLS_ROOT' && isPunct(tokens[i + 1], '='));
    if (at >= 0) {
      for (let j = at + 2; j < Math.min(tokens.length, at + 6); j += 1) {
        if (isPathCall(tokens, j)) {
          skillsRootCall = j;
          break;
        }
      }
    }
  }
  const covered = new Set(ctx.skip ?? []);
  let lastEnd = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    if (i <= lastEnd || !isPathCall(tokens, i)) continue;
    const end = closingIndex(tokens, i + 1);
    lastEnd = end;
    for (let j = i; j <= end; j += 1) covered.add(j);
    const strings = stringsIn(tokens, i + 2, end);
    let dirnames = 0;
    for (let j = i; j <= end; j += 1) if (tokens[j].type === 'ident' && tokens[j].value === 'dirname' && isPunct(tokens[j + 1], '(')) dirnames += 1;
    const anchor = anchorOf(tokens, i, end);
    const extra = anchor.dir ? dirnames : anchor.file ? Math.max(0, dirnames - 1) : 0;
    const climb = climbOf(strings) + extra;
    const line = tokens[i].line;
    const name = tokens[i].value;
    if (climb > ctx.depth) {
      if (i === skillsRootCall && climb === 3) {
        // roles.mjs: SKILLS_ROOT, the folder holding the installed skills, which the role scan reads.
      } else {
        const where = climb === ctx.depth + 1 ? 'into the folder holding the skills (another skill\'s files)' : 'above the folder holding the skills';
        add(line, 'path', `${name}(...) climbs ${climb} level${climb === 1 ? '' : 's'} from ${ctx.relInSkill} (depth ${ctx.depth} in the skill), ${where}; stay inside the skill or use the shared ground (.jevellan/, harnessHome(), the worktree)`);
      }
    }
    const joined = strings.join('/');
    for (const other of ctx.otherNames) {
      if (strings.some((s) => climbOf([s]) > 0) && new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(other)}(?![A-Za-z0-9-])`, 'i').test(joined)) {
        add(line, 'path', `${name}(...) joins ".." with another skill's folder name, ${other}; use runRole and its public script`);
      }
    }
    if (!isRolesLib) {
      const segments = joined.split(/[\\/]+/);
      let scan = false;
      let dir = false;
      for (let j = i; j <= end; j += 1) {
        if (tokens[j].type === 'ident' && ROLE_SCAN.has(tokens[j].value)) scan = true;
        if (isPunct(tokens[j], '.') && tokens[j + 1]?.type === 'ident' && tokens[j + 1].value === 'dir') dir = true;
      }
      if ((scan && (segments.includes('scripts') || segments.includes('lib'))) || (dir && segments.includes('lib'))) {
        add(line, 'path', `${name}(...) builds a path into another skill's ${segments.includes('lib') ? 'scripts/lib/' : 'scripts/'} from the role scan; reach that skill only through runRole and a script its Interface lists`);
      }
    }
    // Every outermost path call, so a join inside writeFileSync(...) or mkdirSync(...) counts too.
    if (tokens.slice(i + 2, end).some(isHome) && strings.some(claudeSegment)) {
      add(line, 'claude-home', `${name}(...) joins a home folder with ".claude"; only install.mjs at the repository root touches Claude Code's settings`);
    }
    if (/(^|\/)\.claude\/settings/.test(joined)) {
      add(line, 'claude-home', `${name}(...) builds a .claude/settings path; only install.mjs at the repository root touches Claude Code's settings`);
    }
    for (const module of ctx.repoModules) {
      const norm = joined.replace(/\/+/g, '/');
      if (norm === module || norm.endsWith(`/${module}`)) add(line, 'repo-module', `${name}(...) names ${module}, a module at the repository root outside skills/`);
    }
  }
  for (const run of literalRuns(tokens, covered)) {
    const climb = climbOf([run.path]);
    if (climb > ctx.depth) {
      add(run.line, 'path', `"${run.text}" climbs ${climb} level${climb === 1 ? '' : 's'} from ${ctx.relInSkill} (depth ${ctx.depth} in the skill), out of the skill folder`);
    }
  }
  tokens.forEach((t, i) => {
    if (covered.has(i)) return;
    if (t.type === 'template' && t.parts.slice(1).some((part) => part.split(/[\\/]+/).find((s) => s !== '') === '.claude')) {
      // `${h}/.claude` with h bound to a home folder (a home named so is the text rule's).
      if (tokens.slice(t.from >= 0 ? t.from : i, i).some((s) => s.type === 'ident' && homes.has(s.value) && !/home/i.test(s.value))) {
        add(t.line, 'claude-home', 'a template joins a home folder with .claude; only install.mjs at the repository root touches Claude Code\'s settings');
      }
    }
    if (t.type !== 'string') return;
    const value = t.value;
    if ((value === '../' || value === '..') && isPunct(tokens[i + 1], '+') && tokens[i + 2]?.type === 'string' && ctx.otherNames.includes(tokens[i + 2].value.split('/')[0])) {
      add(t.line, 'path', `"${value}" + "${tokens[i + 2].value}" reaches another skill's folder; use runRole and its public script`);
    }
    if (value.startsWith('/.claude') || value.startsWith('.claude')) {
      const before = tokens[i - 1];
      const operand = tokens[i - 2];
      if (isPunct(before, '+') && (isHome(operand) || (isPunct(operand, ')') && tokens.slice(Math.max(0, i - 8), i).some(isHome)))) {
        add(t.line, 'claude-home', `a home folder + "${value}"; only install.mjs at the repository root touches Claude Code's settings`);
      }
    }
    for (const module of ctx.repoModules) {
      const norm = value.replace(/\/+/g, '/');
      if (norm === module || norm.endsWith(`/${module}`)) add(t.line, 'repo-module', `"${value}" names ${module}, a module at the repository root outside skills/`);
    }
  });
  return problems;
}

// Problems of rule g (runRole calls) in one code file.
export function runRoleProblems(tokens, { rel, interfaces }) {
  const problems = [];
  const add = (line, detail) => problems.push({ file: rel, line, rule: 'run-role', detail });
  tokens.forEach((t, i) => {
    if (t.type !== 'ident' || t.value !== 'runRole' || !isPunct(tokens[i + 1], '(')) return;
    if (tokens[i - 1]?.value === 'function') return;
    // `export { runRole }`, `import { runRole }` and references without a call have no "(" after them.
    const role = tokens[i + 2];
    const comma = tokens[i + 3];
    const script = tokens[i + 4];
    const after = tokens[i + 5];
    if (role?.type !== 'string' || !isPunct(comma, ',')) {
      add(t.line, 'runRole\'s role must be a string literal, so the lint can check the target');
      return;
    }
    if (script?.type !== 'string' || !(isPunct(after, ',') || isPunct(after, ')'))) {
      add(t.line, `runRole('${role.value}', ...): the script must be a string literal, so the lint can check it against the Interface section`);
      return;
    }
    if (!PUBLIC_SCRIPT.test(script.value)) {
      add(t.line, `runRole('${role.value}', '${script.value}'): the script must be a bare "<name>.mjs" at the top of the target's scripts/ folder`);
      return;
    }
    const holders = [...interfaces.values()].filter((info) => info.role === role.value);
    if (!holders.length) {
      add(t.line, `runRole('${role.value}', '${script.value}'): no skill has jh-role ${role.value}`);
      return;
    }
    if (!holders.some((info) => info.listed.includes(script.value))) {
      add(t.line, `runRole('${role.value}', '${script.value}'): no skill with jh-role ${role.value} lists \`${script.value}\` in its "${INTERFACE_HEADING}" section (${holders.map((h) => h.folder).join(', ')})`);
    }
  });
  return problems;
}

// ---- text (any file) -----------------------------------------------------------------------------------------------

function textProblems(text, { rel, otherNames, repoPaths, repoBase, code, evalData }) {
  const problems = [];
  const add = (index, rule, detail) => problems.push({ file: rel, line: lineAt(text, index), rule, detail });
  const lines = text.split('\n');
  let offset = 0;
  const nameRes = otherNames.map((name) => ({ name, re: new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(name)}(?![A-Za-z0-9-])`, 'gi') }));
  for (const line of lines) {
    for (const { name, re } of nameRes) {
      re.lastIndex = 0;
      const match = re.exec(line);
      if (match) add(offset + match.index, 'skill-name', `names another skill, "${name}"; refer to its role instead (the ledger skill, the placement skill, ...)`);
    }
    offset += line.length + 1;
  }
  const scan = (re, rule, detail) => {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) add(match.index, rule, typeof detail === 'function' ? detail(match) : detail);
  };
  scan(/\bimportFromRole\b/g, 'import-from-role', 'importFromRole no longer exists; run the other skill\'s public script with runRole(role, \'<script>.mjs\', args)');
  if (!evalData) {
    scan(/~[\\/]\.claude\b/g, 'claude-home', 'refers to ~/.claude; only install.mjs at the repository root touches the owner\'s Claude Code folder');
    scan(/\$\{?HOME\}?[\\/]\.claude\b/g, 'claude-home', 'refers to $HOME/.claude; only install.mjs at the repository root touches the owner\'s Claude Code folder');
    scan(/\.claude[\\/]settings/g, 'claude-home', 'refers to .claude/settings; only install.mjs at the repository root touches Claude Code\'s settings');
  }
  if (code) {
    scan(/\$\{[^}]*home[^}]*\}[\\/]\.claude\b/gi, 'claude-home', (m) => `${m[0]} joins a home folder with .claude; only install.mjs at the repository root touches Claude Code's settings`);
  }
  for (const repoPath of repoPaths) {
    let at = text.indexOf(repoPath);
    while (at >= 0) {
      add(at, 'path', `holds the repository's absolute path (${repoPath}); a skill refers only to its own folder, relatively`);
      at = text.indexOf(repoPath, at + repoPath.length);
    }
  }
  if (repoBase && repoBase.length >= 6) {
    const re = new RegExp(`(?:^|[\\s'"\`(=])((?:~|/)[^\\s'"\`]*/${escapeRegExp(repoBase)})(?=[/\\s'"\`)]|$)`, 'gm');
    let match;
    while ((match = re.exec(text))) {
      if (repoPaths.some((p) => match[1].startsWith(p))) continue;
      add(match.index, 'path', `${match[1]} is an absolute path into a folder named like the repository; a skill refers only to its own folder, relatively`);
    }
  }
  return problems;
}

// ---- the check -----------------------------------------------------------------------------------------------------

function repoModules(root) {
  const out = [];
  for (const file of walk(root)) {
    const rel = posix(path.relative(root, file));
    if (rel.startsWith('skills/') || !CODE_FILE.test(rel) || !rel.includes('/')) continue;
    out.push(rel);
  }
  return out;
}

// KINDS of the ledger library, checked against the twenty.
export async function kindsProblems(root) {
  const ledger = await loadLedger(root);
  if (ledger.problem) return [{ file: KINDS_MODULE, line: 1, rule: 'event-kind', detail: ledger.problem.replace(`${KINDS_MODULE}: `, '') }];
  const kinds = ledger.module.KINDS;
  if (!Array.isArray(kinds)) return [{ file: KINDS_MODULE, line: 1, rule: 'event-kind', detail: 'KINDS is not an array' }];
  const extra = kinds.filter((k) => !EVENT_KINDS.includes(k));
  const missing = EVENT_KINDS.filter((k) => !kinds.includes(k));
  const problems = [];
  if (extra.length || missing.length || kinds.length !== EVENT_KINDS.length) {
    const parts = [];
    if (extra.length) parts.push(`beyond the twenty: ${extra.join(', ')}`);
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
    if (kinds.length !== EVENT_KINDS.length) parts.push(`${kinds.length} entries`);
    problems.push({ file: KINDS_MODULE, line: 1, rule: 'event-kind', detail: `the ledger's KINDS must be exactly the twenty event kinds (${parts.join('; ')})` });
  }
  return problems;
}

export async function checkDecoupling(root, { skills: only = null } = {}) {
  const folders = skillFolders(root);
  const skillsDir = path.join(root, 'skills');
  const interfaces = readInterfaces(root);
  const modules = repoModules(root);
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {}
  const repoPaths = [...new Set([root, real])];
  const repoBase = path.basename(real);
  const problems = [];
  const chosen = only ? folders.filter((f) => only.includes(f)) : folders;
  if (!only) {
    for (const name of linkedSkillFolders(root)) problems.push({ file: `skills/${name}`, line: 1, rule: 'path', detail: SYMLINK });
  }
  for (const folder of chosen) {
    const skillDir = path.join(skillsDir, folder);
    const otherNames = folders.filter((f) => f !== folder);
    problems.push(...interfaceProblems(interfaces.get(folder)));
    const walked = walkSkill(skillDir, root);
    problems.push(...walked.problems);
    for (const file of walked.files) {
      const rel = posix(path.relative(root, file));
      const relInSkill = posix(path.relative(skillDir, file));
      for (const segment of relInSkill.split('/')) {
        if (otherNames.includes(segment)) problems.push({ file: rel, line: 1, rule: 'skill-name', detail: `the file's path names another skill, "${segment}"; name fakes and fixtures after the role (fake-ledger)` });
      }
      if (TYPESCRIPT_FILE.test(file)) {
        problems.push({ file: rel, line: 1, rule: 'import', detail: TYPESCRIPT });
        continue;
      }
      let buffer;
      try {
        buffer = fs.readFileSync(file);
      } catch (error) {
        problems.push({ file: rel, line: 1, rule: 'path', detail: `cannot be read (${error.code ?? error.message})` });
        continue;
      }
      if (buffer.includes(0)) continue;
      const text = buffer.toString('utf8');
      const code = CODE_FILE.test(file);
      const evalData = !code && relInSkill.startsWith('evals/');
      problems.push(...textProblems(text, { rel, otherNames, repoPaths, repoBase, code, evalData }));
      if (!code) continue;
      const tokens = tokenize(text);
      const ctx = { file, skillDir, skillsDir, root };
      const sites = importsOf(tokens);
      for (const site of sites) {
        // An own test may import a copy of its own skill by a computed path (the copy next to its fakes): the test
        // runner gives it only its own folder, so a computed path cannot reach a sibling there. createRequire is no
        // computed import and fails under test/ too.
        if (site.spec === null && !site.detail && relInSkill.startsWith('test/')) continue;
        const problem = site.detail ? { rule: 'import', detail: site.detail } : specifierProblem(site.spec, ctx);
        if (problem) problems.push({ file: rel, line: site.line, rule: problem.rule, detail: `${site.how}${problem.detail}` });
      }
      const depth = relInSkill.split('/').length - 1;
      const skip = sites.map((site) => site.index).filter((index) => index >= 0);
      problems.push(...codePathProblems(tokens, { rel, relInSkill, depth, otherNames, repoModules: modules, skip }));
      problems.push(...runRoleProblems(tokens, { rel, interfaces }));
      for (const { kind, line } of kindsUsed(text)) {
        if (!EVENT_KINDS.includes(kind)) problems.push({ file: rel, line, rule: 'event-kind', detail: `"${kind}" is not one of the twenty event kinds` });
      }
    }
  }
  if (!only || only.some((f) => interfaces.get(f)?.role === 'ledger')) problems.push(...await kindsProblems(root));
  const seen = new Set();
  const unique = problems.filter((p) => {
    const key = `${p.file}:${p.line}:${p.rule}:${p.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { skills: chosen, problems: unique };
}

export const formatProblem = (p) => `${p.file}:${p.line}: ${p.rule}: ${p.detail}`;

const USAGE = 'usage: node scripts/check-decoupling.mjs [--root <repo root>] [--skill <folder>]...';

function parseArgs(argv) {
  const options = { root: null, skills: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--root') options.root = path.resolve(value());
    else if (arg === '--skill') options.skills.push(value());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return options;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-decoupling: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const folders = skillFolders(root);
  if (!folders.length) {
    process.stderr.write(`check-decoupling: no skill folders under ${path.join(root, 'skills')}\n`);
    return 2;
  }
  for (const name of options.skills) {
    if (!folders.includes(name)) {
      process.stderr.write(`check-decoupling: no skill folder skills/${name}\n${USAGE}\n`);
      return 2;
    }
  }
  const { skills, problems } = await checkDecoupling(root, { skills: options.skills.length ? options.skills : null });
  if (problems.length) {
    process.stderr.write(`${problems.map(formatProblem).join('\n')}\n`);
    process.stderr.write(`check-decoupling: ${plural(problems.length, 'problem')}\n`);
    return 1;
  }
  process.stdout.write(`check-decoupling: ${plural(skills.length, 'skill')}, clean\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
