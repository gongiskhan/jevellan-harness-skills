// A policy is a SKILL.md whose body has level-2 sections that a script reads by name (the skills brief 7.8, ported
// from the skills repo's policy.ts). Everything outside the named sections is for people. The body's sha256 is the
// policy hash recorded with every decision, so the evals can tell which policy a decision was made under.

import crypto from 'node:crypto';
import fs from 'node:fs';

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

export function splitFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? { frontmatter: match[0], body: text.slice(match[0].length) } : { frontmatter: '', body: text };
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// "## name" headings at the start of a line open a section; it runs to the next level-2 heading. Keys are the
// lowercased heading text with inner spaces collapsed. Text inside fenced code blocks is not a heading, and a level-1
// heading closes the section before it.
export function parseSections(body) {
  const sections = new Map();
  const duplicates = [];
  let current = null;
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
    }
    if (!fence && !marker && /^#\s+/.test(line)) {
      current = null; // a level-1 heading ends the section before it
      continue;
    }
    const heading = !fence && /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const key = heading[1].toLowerCase().replace(/\s+/g, ' ');
      if (sections.has(key)) duplicates.push(key);
      current = key;
      sections.set(key, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }
  const out = new Map();
  for (const [key, lines] of sections) out.set(key, lines.join('\n').trim());
  return { sections: out, duplicates };
}

export function parsePolicy(text, file = '(policy)') {
  const { body } = splitFrontmatter(text);
  const { sections, duplicates } = parseSections(body);
  if (duplicates.length) throw new PolicyError(`${file}: section "${duplicates[0]}" appears twice`);
  return { file, body, hash: sha256(body), sections };
}

export function loadPolicy(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new PolicyError(`cannot read the policy ${file}: ${error.code ?? error.message}`);
  }
  return parsePolicy(text, file);
}

export function requireSection(policy, name) {
  const value = policy.sections.get(name);
  if (value === undefined || value === '') throw new PolicyError(`${policy.file}: the section "## ${name}" is missing or empty`);
  return value;
}

// "<id>: <text>" lines, one per id; blank lines are ignored, anything else is refused.
export function parseIdLines(text, where = 'section') {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._:-]*):\s+(.+)$/.exec(line.trim());
    if (!match) throw new PolicyError(`${where}: "${line.trim().slice(0, 80)}" is not an "<id>: <text>" line`);
    if (out.has(match[1])) throw new PolicyError(`${where}: ${match[1]} appears twice`);
    out.set(match[1], match[2].trim());
  }
  return out;
}

// "<id>: <question> true: <criterion> false: <criterion>" lines (the workflow questions).
export function parseQuestionLines(text, where = 'questions') {
  const out = new Map();
  for (const [id, rest] of parseIdLines(text, where)) {
    const match = /^(.*?)\s+true:\s+(.*?)\s+false:\s+(.*)$/.exec(rest);
    if (!match) throw new PolicyError(`${where}: ${id} needs "<question> true: <criterion> false: <criterion>"`);
    out.set(id, { id, question: match[1].trim(), true: match[2].trim(), false: match[3].trim() });
  }
  return out;
}
