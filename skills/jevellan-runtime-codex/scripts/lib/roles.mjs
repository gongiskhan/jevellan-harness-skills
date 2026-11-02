// Finds installed sibling skills by role, so a script depends on a role and never on another skill's name (the
// same rule the SKILL.md bodies follow). Every skill with scripts carries an identical copy of this file at
// scripts/lib/roles.mjs; scripts/check-roles.mjs checks that the copies match.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// <skills folder>/<skill>/scripts/lib/roles.mjs -> <skills folder>
export const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
    if (meta['jh-role']) skills.push({ name, dir: path.join(root, name), meta, body: text.replace(/^---[\s\S]*?\n---\r?\n?/, '') });
  }
  return skills;
}

export class RoleMissing extends Error {
  constructor(role, detail = '') {
    super(`no installed skill has the role ${role}${detail ? ` (${detail})` : ''}`);
    this.exitCode = 2;
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

// Imports a module from the skill with `role`, e.g. importFromRole('ledger', 'scripts/lib/ledger.mjs').
export async function importFromRole(role, relative, filter = {}, root = SKILLS_ROOT) {
  const skill = skillWithRole(role, filter, root);
  return import(pathToFileURL(path.join(skill.dir, relative)).href);
}
