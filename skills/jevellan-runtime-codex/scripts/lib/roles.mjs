// Finds installed sibling skills by role and runs their public scripts as child processes, so a script depends on a
// role and never on another skill's name or files (the rule the SKILL.md bodies follow too). Every skill with scripts
// carries its own copy of this file at scripts/lib/roles.mjs; the copies may drift apart, and
// scripts/check-decoupling.mjs lists the ones that do.
//
// runRole(role, script, args, options) is the one way into another skill: it runs <that skill>/scripts/<script> with
// this process's Node and returns {code, stdout, stderr, json}. Only a script at the top of the other skill's scripts/
// folder can be named, and that skill's SKILL.md "## Interface" section says what it takes and prints. Nothing here
// imports or reads another skill's scripts/lib/; reading a sibling's SKILL.md (its frontmatter, and a duty's body)
// is the scan itself. The scan's results carry a skill's name, frontmatter and SKILL.md text, never its folder, and
// the skills folder stays private to this file: a caller has no path into a sibling to misuse.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// <skills folder>/<skill>/scripts/lib/roles.mjs -> <skills folder>. Every function below takes `root` (another skills
// folder, for tests) and falls back to this one.
const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    out[kv[1]] = value;
  }
  return out;
}

// The installed skills that carry a jh-role: {name, meta, body, text}, sorted by name.
export function installedSkills(root = SKILLS_ROOT) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const skills = [];
  for (const name of names.sort()) {
    const file = path.join(root, name, 'SKILL.md');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const meta = frontmatter(text);
    if (meta['jh-role']) skills.push({ name, meta, text, body: text.replace(/^---[\s\S]*?\n---\r?\n?/, '') });
  }
  return skills;
}

// What every script says when a role it needs has no installed skill: exit 2 with this sentence after the role.
export const ROLE_MISSING_ADVICE = 'tell the owner which role is missing and do not improvise it';

export class RoleMissing extends Error {
  constructor(role, detail = '') {
    super(`no installed skill has the role ${role}${detail ? ` (${detail})` : ''}; ${ROLE_MISSING_ADVICE}`);
    this.exitCode = 2;
    this.role = role;
  }
}

// The skills with `role`, optionally narrowed: {kind} for runtimes (jh-kinds), {duty} for duties, {workflow} for
// workflows (jh-kind).
export function skillsWithRole(role, { kind, duty, workflow } = {}, root = SKILLS_ROOT) {
  return installedSkills(root).filter((skill) => {
    if (skill.meta['jh-role'] !== role) return false;
    if (kind && !(Array.isArray(skill.meta['jh-kinds']) && skill.meta['jh-kinds'].includes(kind))) return false;
    if (duty && skill.meta['jh-duty'] !== duty) return false;
    if (workflow && skill.meta['jh-kind'] !== workflow) return false;
    return true;
  });
}

export function skillWithRole(role, filter = {}, root = SKILLS_ROOT) {
  const found = skillsWithRole(role, filter, root);
  if (!found.length) throw new RoleMissing(role, Object.entries(filter).map(([k, v]) => `${k} ${v}`).join(', '));
  return found[0];
}

const PUBLIC_SCRIPT = /^[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/;

// Runs the public script `script` of the skill with `role` (narrowed by `filter`) with `args`, and waits for it.
// `input` goes to its stdin (an object as JSON); `cwd` and `env` default to this process's. Returns {code, stdout,
// stderr, json}: json is stdout parsed, or null when it is not JSON. Throws RoleMissing (exit 2) when no installed
// skill has the role, and an error with exit 2 when that skill has no such script.
export function runRole(role, script, args = [], { filter = {}, input, cwd, env, timeoutMs = 600000, root = SKILLS_ROOT } = {}) {
  if (typeof script !== 'string' || !PUBLIC_SCRIPT.test(script)) {
    throw Object.assign(new Error(`runRole: "${script}" is not the name of a script at the top of a skill's scripts/ folder`), { exitCode: 2 });
  }
  const skill = skillWithRole(role, filter, root);
  const file = path.join(root, skill.name, 'scripts', script);
  if (!fs.existsSync(file)) {
    throw Object.assign(new Error(`the installed ${role} skill has no public script ${script}; ${ROLE_MISSING_ADVICE.replace('which role is missing', 'which script is missing')}`), { exitCode: 2 });
  }
  const r = spawnSync(process.execPath, [file, ...args.map(String)], {
    cwd,
    env: env ?? process.env,
    input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (r.error) throw Object.assign(new Error(`the ${role} skill's ${script} could not run: ${r.error.message}`), { exitCode: 1 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json };
}

// The Claude Code plugin these skills came with, or null: the folder holding the skills folder when it carries
// .claude-plugin/plugin.json (a plugin loaded from Claude Code's plugin cache or with --plugin-dir). A runtime hands
// it to the sessions it starts (--plugin-dir), whose own configuration folder does not hold the owner's plugins.
export function pluginRoot(root = SKILLS_ROOT) {
  const holder = path.dirname(path.resolve(root));
  return fs.existsSync(path.join(holder, '.claude-plugin', 'plugin.json')) ? holder : null;
}

// Whether these skills run from <project>/.claude/skills, where an installation into the project put them: then a
// session in one of the project's worktrees finds them only through a .claude link to the project's own folder.
export function runsFromProject(project, root = SKILLS_ROOT) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(root) === real(path.join(project, '.claude', 'skills'));
}
