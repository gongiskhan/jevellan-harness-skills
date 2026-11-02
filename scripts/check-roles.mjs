#!/usr/bin/env node
// The role lint (brief section 3) and the event kind lint (section 4).
//
//   node scripts/check-roles.mjs [--root <repo root>] [--write | --check]
//
// Every skills/<folder>/SKILL.md must carry name, description and jh-role in its frontmatter, with the description
// starting with the role word. No body may name another skill, every role phrase a body uses must have a skill with
// that role, and a body that uses role phrases must say what to do when the role is missing. The ledger's KINDS has
// exactly twenty entries and no script under skills/ uses a twenty-first. docs/roles.md is generated from the
// frontmatter: --write regenerates it, --check fails when it differs from what would be generated. With neither flag
// the lint runs alone. Exit 0 when clean, 1 with every problem on its own line, 2 on a usage error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROLES = Object.freeze(['coordinator', 'placement', 'runtime', 'ledger', 'git', 'duty', 'workflow']);

// The phrase a body uses to call on a role, lower case. Matched case-insensitively after whitespace is collapsed.
export const ROLE_PHRASES = Object.freeze([
  { phrase: 'the coordinator skill', role: 'coordinator' },
  { phrase: 'the placement skill', role: 'placement' },
  { phrase: 'the ledger skill', role: 'ledger' },
  { phrase: 'the git skill', role: 'git' },
  { phrase: 'the runtime skill for', role: 'runtime' },
  { phrase: 'the duty skill for', role: 'duty' },
  { phrase: 'the workflow skill for', role: 'workflow' },
]);

export const ROLE_MISSING_SENTENCE =
  "If no skill in your list has that role (a skill's role is the first word of its description), call no skill at all: stop, tell the owner which role is missing, and do not improvise it.";

export const KIND_COUNT = 20;
export const KINDS_MODULE = 'skills/jevellan-ledger/scripts/lib/ledger.mjs';
export const ROLES_DOC = 'docs/roles.md';
const PREFIX = 'jevellan-';
const DOTTED_KIND = /^(task|step|session|landing)\.[a-z]+$/;
// A dotted literal that names a file (task.json, session.log) is a path, not an event kind.
const FILE_SUFFIX = /\.(json|jsonl|md|mjs|cjs|js|log|txt|lock|yaml|yml|toml|html|csv|sh|png|jpg)$/;

// ---- frontmatter ---------------------------------------------------------------------------------------------------

function unquote(raw, problems, key) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      problems.push(`${key}: the double-quoted value does not parse`);
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') || value.startsWith("'")) {
    problems.push(`${key}: the quoted value is not closed`);
    return value.slice(1);
  }
  return value;
}

// Splits "a, 'b, c', d" on the commas outside quotes.
function splitList(inner) {
  const items = [];
  let current = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items;
}

function parseScalar(raw, problems, key) {
  const value = raw.trim();
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) {
      problems.push(`${key}: the list is not closed with "]"`);
      return [];
    }
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    const items = splitList(inner).map((item) => unquote(item, problems, key));
    if (items.some((item) => item === '')) problems.push(`${key}: the list has an empty item`);
    return items;
  }
  if (!value.startsWith('"') && !value.startsWith("'")) {
    // A plain YAML scalar ends at ": " (a mapping) or " #" (a comment); a real YAML reader would refuse the line or
    // cut the value short, so the skill would not load as written.
    if (value.includes(': ')) problems.push(`${key}: an unquoted value may not contain ": "; put the value in double quotes`);
    if (value.includes(' #')) problems.push(`${key}: an unquoted value may not contain " #"; put the value in double quotes`);
  }
  return unquote(value, problems, key);
}

// The small YAML subset skill frontmatter uses: "key: value" lines, [a, b] lists, quoted strings, folded (">") and
// literal ("|") blocks, block lists ("- item"), and plain values continued on indented lines. Returns
// {data, body, problems}; data is null when there is no frontmatter block.
export function parseSkillFile(text) {
  const problems = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') {
    return { data: null, body: text, problems: ['no frontmatter: the file must start with a "---" line'] };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return { data: null, body: '', problems: ['the frontmatter has no closing "---" line'] };
  const data = {};
  const block = lines.slice(1, end);
  let i = 0;
  while (i < block.length) {
    const line = block[i];
    i += 1;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      problems.push(`frontmatter line ${i + 1} is indented without a key above it: "${line.trim()}"`);
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):(?:\s(.*))?$/.exec(line.replace(/\s+$/, ''));
    if (!match) {
      problems.push(`frontmatter line ${i + 1} is not "key: value": "${line.trim()}"`);
      continue;
    }
    const key = match[1];
    const rest = (match[2] ?? '').trim();
    if (Object.hasOwn(data, key)) problems.push(`${key} appears twice in the frontmatter`);
    const continuation = [];
    while (i < block.length && (block[i].trim() === '' || /^\s/.test(block[i]))) {
      continuation.push(block[i]);
      i += 1;
    }
    while (continuation.length && continuation[continuation.length - 1].trim() === '') continuation.pop();
    const indented = continuation.map((l) => l.trim());
    if (/^[>|][+-]?$/.test(rest)) {
      data[key] = rest.startsWith('>')
        ? indented.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').trim()
        : indented.join('\n');
    } else if (rest === '' && indented.length && indented.every((l) => l === '' || l.startsWith('- ') || l === '-')) {
      data[key] = indented.filter((l) => l !== '').map((l) => unquote(l.slice(1), problems, key));
    } else if (indented.length && !rest.startsWith('[') && !rest.startsWith('"') && !rest.startsWith("'")) {
      data[key] = parseScalar([rest, ...indented.filter((l) => l !== '')].join(' '), problems, key);
    } else {
      if (indented.some((l) => l !== '')) problems.push(`${key}: unexpected indented lines after the value`);
      data[key] = parseScalar(rest, problems, key);
    }
  }
  return { data, body: lines.slice(end + 1).join('\n'), problems };
}

// ---- a minimal JavaScript tokenizer, enough to find string literals outside comments and regular expressions -----

const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

function cook(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|.)/g, (_, esc) => {
    if (esc.startsWith('u{')) return String.fromCodePoint(parseInt(esc.slice(2, -1), 16));
    if (esc.length > 1 && (esc[0] === 'u' || esc[0] === 'x')) return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case '\n':
      case '\r\n': return '';
      default: return esc;
    }
  });
}

// Returns tokens {type: 'string' | 'template' | 'ident' | 'number' | 'regex' | 'punct', value, line}. A template
// literal without substitutions is a 'string'; one with substitutions is a 'template' whose value is null.
export function tokenize(source) {
  const tokens = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let braces = 0;
  const templateStack = [];
  let prev = null;
  const push = (token) => {
    tokens.push(token);
    prev = token;
  };
  const regexAllowed = () => {
    if (!prev) return true;
    if (prev.type === 'ident') return KEYWORDS_BEFORE_EXPRESSION.has(prev.value);
    if (prev.type === 'punct') return ![')', ']', '}'].includes(prev.value);
    return false;
  };
  // Reads template text from i (just after "`" or after the "}" closing a substitution).
  const readTemplate = (startLine, chunks) => {
    let raw = '';
    while (i < n) {
      const ch = source[i];
      if (ch === '\\') {
        raw += source.slice(i, i + 2);
        if (source[i + 1] === '\n') line += 1;
        i += 2;
        continue;
      }
      if (ch === '`') {
        i += 1;
        if (chunks === 0) push({ type: 'string', value: cook(raw), line: startLine });
        else push({ type: 'template', value: null, line: startLine });
        return;
      }
      if (ch === '$' && source[i + 1] === '{') {
        i += 2;
        templateStack.push({ braces, startLine, chunks: chunks + 1 });
        braces = 0;
        prev = { type: 'punct', value: '${' };
        return;
      }
      if (ch === '\n') line += 1;
      raw += ch;
      i += 1;
    }
  };
  if (source.startsWith('#!')) {
    while (i < n && source[i] !== '\n') i += 1;
  }
  while (i < n) {
    const ch = source[i];
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close < 0 ? n : close + 2;
      for (let j = i; j < stop; j += 1) if (source[j] === '\n') line += 1;
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const startLine = line;
      let raw = '';
      i += 1;
      while (i < n && source[i] !== ch && source[i] !== '\n') {
        if (source[i] === '\\') {
          if (source[i + 1] === '\n') line += 1;
          raw += source.slice(i, i + 2);
          i += 2;
        } else {
          raw += source[i];
          i += 1;
        }
      }
      i += 1;
      push({ type: 'string', value: cook(raw), line: startLine });
      continue;
    }
    if (ch === '`') {
      i += 1;
      readTemplate(line, 0);
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== '\n') {
        const c = source[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        j += 1;
        while (j < n && /[a-z]/i.test(source[j])) j += 1;
        push({ type: 'regex', value: source.slice(i, j), line });
        i = j;
        continue;
      }
    }
    if (/[\p{L}_$]/u.test(ch)) {
      const match = /^[\p{L}\p{N}_$]+/u.exec(source.slice(i, i + 200));
      push({ type: 'ident', value: match[0], line });
      i += match[0].length;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^[0-9a-zA-Z_.]+/.exec(source.slice(i, i + 100));
      push({ type: 'number', value: match[0], line });
      i += match[0].length;
      continue;
    }
    if (ch === '{') braces += 1;
    if (ch === '}') {
      if (braces === 0 && templateStack.length) {
        const frame = templateStack.pop();
        braces = frame.braces;
        i += 1;
        readTemplate(frame.startLine, frame.chunks);
        continue;
      }
      braces -= 1;
    }
    push({ type: 'punct', value: ch, line });
    i += 1;
  }
  return tokens;
}

// Event kinds a script uses: every dotted literal (task.x, step.x, session.x, landing.x), the kind: literal of an
// appendEvent(...) call, and the literal after 'append' in a ledger.mjs argument list. Returns [{kind, line}].
export function kindsUsed(source) {
  const tokens = tokenize(source);
  const found = new Map();
  const add = (token) => {
    if (!found.has(token)) found.set(token, { kind: token.value, line: token.line });
  };
  tokens.forEach((token, index) => {
    if (token.type === 'string' && DOTTED_KIND.test(token.value) && !FILE_SUFFIX.test(token.value)) add(token);
    if (token.type === 'string' && token.value === 'append') {
      const comma = tokens[index + 1];
      const next = tokens[index + 2];
      if (comma?.type === 'punct' && comma.value === ',' && next?.type === 'string') add(next);
    }
    if (token.type === 'ident' && token.value === 'appendEvent' && tokens[index + 1]?.value === '(' &&
        tokens[index - 1]?.value !== 'function') {
      const stack = [];
      for (let j = index + 2; j < tokens.length; j += 1) {
        const t = tokens[j];
        if (t.type === 'punct' && ['(', '[', '{'].includes(t.value)) stack.push(t.value);
        else if (t.type === 'punct' && [')', ']', '}'].includes(t.value)) {
          if (stack.length === 0) break;
          stack.pop();
        } else if (stack.length === 1 && stack[0] === '{' && (t.type === 'ident' || t.type === 'string') &&
                   t.value === 'kind' && tokens[j + 1]?.value === ':' && tokens[j + 2]?.type === 'string' &&
                   [',', '}'].includes(tokens[j + 3]?.value)) {
          add(tokens[j + 2]);
        }
      }
    }
  });
  return [...found.values()];
}

// ---- the repository ------------------------------------------------------------------------------------------------

function listFiles(dir, accept) {
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
    if (entry.isDirectory()) out.push(...listFiles(full, accept));
    else if (entry.isFile() && accept(entry.name)) out.push(full);
  }
  return out;
}

const asText = (value) => (typeof value === 'string' ? value : '');
const isList = (value) => Array.isArray(value);
const normalize = (text) => text.replace(/\s+/g, ' ');
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function expectedStart(role, data) {
  switch (role) {
    case 'coordinator': return 'Coordinator.';
    case 'placement': return 'Placement.';
    case 'ledger': return 'Ledger.';
    case 'git': return 'Git.';
    case 'runtime': return 'Runtime for';
    case 'duty': return typeof data['jh-duty'] === 'string' && data['jh-duty'] ? `Duty ${data['jh-duty']}.` : null;
    case 'workflow': return typeof data['jh-kind'] === 'string' && data['jh-kind'] ? `Workflow ${data['jh-kind']}.` : null;
    default: return null;
  }
}

// Reads every skill folder. Returns {skills, problems}; each skill is {folder, file, data, body, phrases}.
export function readSkills(root) {
  const problems = [];
  const skillsDir = path.join(root, 'skills');
  let folders = [];
  try {
    folders = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    problems.push('skills/: the folder is missing');
    return { skills: [], problems };
  }
  if (folders.length === 0) problems.push('skills/: no skill folders');
  const skills = [];
  for (const folder of folders) {
    const rel = `skills/${folder}/SKILL.md`;
    let text;
    try {
      text = fs.readFileSync(path.join(skillsDir, folder, 'SKILL.md'), 'utf8');
    } catch {
      problems.push(`${rel}: missing; every folder under skills/ is a skill and needs a SKILL.md`);
      continue;
    }
    const parsed = parseSkillFile(text);
    for (const problem of parsed.problems) problems.push(`${rel}: ${problem}`);
    const data = parsed.data ?? {};
    const body = normalize(parsed.body).toLowerCase();
    const phrases = ROLE_PHRASES.filter((p) => body.includes(p.phrase)).map((p) => p.phrase);
    skills.push({ folder, rel, dir: path.join(skillsDir, folder), data, hasFrontmatter: parsed.data !== null, body: parsed.body, phrases });
  }
  return { skills, problems };
}

// `vocab` holds DUTIES and TASK_KINDS from the ledger library when it imports; the membership checks wait for it.
function lintSkills(skills, vocab) {
  const dutyNames = vocab?.duties ?? null;
  const workflowKinds = vocab?.taskKinds ? vocab.taskKinds.filter((kind) => kind !== 'single') : null;
  const problems = [];
  const byRole = new Map(ROLES.map((role) => [role, []]));
  for (const skill of skills) {
    const { rel, data, folder } = skill;
    if (!skill.hasFrontmatter) continue;
    const name = asText(data.name);
    if (!name) problems.push(`${rel}: name is missing`);
    else if (name !== folder) problems.push(`${rel}: name "${name}" does not match the folder name "${folder}"`);
    const description = asText(data.description).trim();
    if (!description) problems.push(`${rel}: description is missing`);
    const role = asText(data['jh-role']);
    if (!role) {
      problems.push(`${rel}: jh-role is missing; it must be one of ${ROLES.join(', ')}`);
    } else if (!ROLES.includes(role)) {
      problems.push(`${rel}: jh-role "${role}" is not one of ${ROLES.join(', ')}`);
    } else {
      byRole.get(role).push(skill);
      if (role === 'runtime') {
        const kinds = data['jh-kinds'];
        if (!isList(kinds) || kinds.length === 0) problems.push(`${rel}: a runtime needs jh-kinds, a non-empty list of provider kinds`);
      }
      if (role === 'duty') {
        const duty = data['jh-duty'];
        if (typeof duty !== 'string' || !duty) problems.push(`${rel}: a duty needs jh-duty`);
        else if (dutyNames && !dutyNames.includes(duty)) problems.push(`${rel}: jh-duty "${duty}" is not one of ${dutyNames.join(', ')}`);
        if (!isList(data['jh-needs'])) problems.push(`${rel}: a duty needs jh-needs, a list (use [] for none)`);
      }
      if (role === 'workflow') {
        const kind = data['jh-kind'];
        if (typeof kind !== 'string' || !kind) problems.push(`${rel}: a workflow needs jh-kind`);
        else if (workflowKinds && !workflowKinds.includes(kind)) problems.push(`${rel}: jh-kind "${kind}" is not one of ${workflowKinds.join(', ')}`);
        const jsonRel = `skills/${folder}/workflow.json`;
        let jsonText = null;
        try {
          jsonText = fs.readFileSync(path.join(skill.dir, 'workflow.json'), 'utf8');
        } catch {
          problems.push(`${jsonRel}: missing; a workflow needs a workflow.json next to its SKILL.md`);
        }
        if (jsonText !== null) {
          try {
            JSON.parse(jsonText);
          } catch (error) {
            problems.push(`${jsonRel}: does not parse (${error.message})`);
          }
        }
      }
      const start = expectedStart(role, data);
      if (description && start && !description.startsWith(start)) {
        problems.push(`${rel}: the description must start with "${start}" (role ${role}), not "${description.slice(0, start.length + 12)}"`);
      }
    }
    if (data['disable-model-invocation'] !== undefined && data['disable-model-invocation'] !== 'false') {
      problems.push(`${rel}: disable-model-invocation must be absent; other skills and the model must be able to invoke every skill`);
    }
  }
  // A role phrase that names one skill ("the duty skill for implement") must not find two.
  const unique = (role, key, label) => {
    const seen = new Map();
    for (const skill of byRole.get(role)) {
      const values = isList(skill.data[key]) ? skill.data[key] : [skill.data[key]];
      for (const value of values) {
        if (typeof value !== 'string' || !value) continue;
        if (seen.has(value)) problems.push(`${skill.rel}: ${label} "${value}" is also claimed by ${seen.get(value)}`);
        else seen.set(value, skill.folder);
      }
    }
  };
  unique('runtime', 'jh-kinds', 'provider kind');
  unique('duty', 'jh-duty', 'duty');
  unique('workflow', 'jh-kind', 'workflow kind');

  const names = skills.map((s) => s.folder).filter((f) => f.startsWith(PREFIX)).map((f) => f.slice(PREFIX.length));
  for (const skill of skills) {
    const own = skill.folder.startsWith(PREFIX) ? skill.folder.slice(PREFIX.length) : null;
    const bodyLines = skill.body.split('\n');
    for (const other of names) {
      if (other === own) continue;
      const pattern = new RegExp(`${escapeRegExp(PREFIX + other)}(?![a-z0-9-])`, 'i');
      const index = bodyLines.findIndex((l) => pattern.test(l));
      if (index >= 0) {
        const phrase = ROLE_PHRASES.find((p) => p.role === roleOf(skills, other))?.phrase ?? 'the <role> skill';
        problems.push(`${skill.rel}: the body names another skill, "${PREFIX}${other}" (body line ${index + 1}); refer to its role instead ("${phrase}")`);
      }
    }
    for (const phrase of skill.phrases) {
      const role = ROLE_PHRASES.find((p) => p.phrase === phrase).role;
      if (byRole.get(role).length === 0) problems.push(`${skill.rel}: the body uses "${phrase}" but no skill has jh-role ${role}`);
    }
    if (skill.phrases.length > 0 && !normalize(skill.body).includes(ROLE_MISSING_SENTENCE)) {
      problems.push(`${skill.rel}: the body uses role phrases but lacks the sentence "${ROLE_MISSING_SENTENCE}"`);
    }
  }
  return problems;
}

function roleOf(skills, shortName) {
  const skill = skills.find((s) => s.folder === PREFIX + shortName);
  return skill ? asText(skill.data['jh-role']) : null;
}

// The ledger library under `root`: {module} or {problem}.
export async function loadLedger(root) {
  try {
    return { module: await import(pathToFileURL(path.join(root, KINDS_MODULE)).href) };
  } catch (error) {
    return { problem: `${KINDS_MODULE}: cannot import KINDS (${String(error?.message ?? error).split('\n')[0]})` };
  }
}

// KINDS from the ledger library, and every script under skills/ checked against it.
export function lintKinds(root, kinds) {
  const problems = [];
  if (!Array.isArray(kinds)) return { kinds: null, problems: [`${KINDS_MODULE}: KINDS is not an array`] };
  if (kinds.length !== KIND_COUNT) problems.push(`${KINDS_MODULE}: KINDS has ${kinds.length} entries; there are exactly ${KIND_COUNT} event kinds`);
  const duplicates = kinds.filter((kind, index) => kinds.indexOf(kind) !== index);
  if (duplicates.length) problems.push(`${KINDS_MODULE}: KINDS lists ${[...new Set(duplicates)].join(', ')} more than once`);
  for (const kind of kinds) {
    if (kind !== 'note' && !DOTTED_KIND.test(kind)) problems.push(`${KINDS_MODULE}: KINDS entry "${kind}" is not task.x, step.x, session.x, landing.x or note`);
  }
  for (const file of listFiles(path.join(root, 'skills'), (name) => name.endsWith('.mjs'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      problems.push(`${rel}: cannot be read (${error.code ?? error.message})`);
      continue;
    }
    for (const { kind, line } of kindsUsed(source)) {
      if (!kinds.includes(kind)) problems.push(`${rel}:${line}: event kind "${kind}" is not one of the ${KIND_COUNT} in KINDS (${KINDS_MODULE})`);
    }
  }
  return { kinds, problems };
}

// ---- docs/roles.md -------------------------------------------------------------------------------------------------

const cell = (text) => String(text).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
const listText = (value) => (isList(value) ? (value.length ? value.join(', ') : 'none') : '?');

function covers(data) {
  switch (asText(data['jh-role'])) {
    case 'runtime': return `provider kinds: ${listText(data['jh-kinds'])}`;
    case 'duty': return `duty: ${asText(data['jh-duty']) || '?'}; needs: ${listText(data['jh-needs'])}`;
    case 'workflow': return `task kind: ${asText(data['jh-kind']) || '?'}`;
    default: return '-';
  }
}

export function renderRolesDoc(skills) {
  const out = [];
  out.push('# Roles');
  out.push('');
  out.push('Generated by `node scripts/check-roles.mjs --write` from the frontmatter of every `skills/*/SKILL.md`. Do not');
  out.push('edit it by hand: change the skill, run the command again and commit the result. `npm test` runs');
  out.push('`node scripts/check-roles.mjs --check`, which fails while this file is stale.');
  out.push('');
  out.push('## Skills');
  out.push('');
  out.push('| Skill | Role | Covers | Description |');
  out.push('| --- | --- | --- | --- |');
  for (const skill of skills) {
    const role = asText(skill.data['jh-role']) || '(missing)';
    out.push(`| ${cell(skill.folder)} | ${cell(role)} | ${cell(covers(skill.data))} | ${cell(asText(skill.data.description))} |`);
  }
  out.push('');
  out.push('## Roles');
  out.push('');
  for (const role of ROLES) {
    const holders = skills.filter((s) => asText(s.data['jh-role']) === role).map((s) => `\`${s.folder}\``);
    out.push(`- ${role}: ${holders.length ? holders.join(', ') : 'no skill installed'}`);
  }
  out.push('');
  out.push('## Role phrases each body uses');
  out.push('');
  for (const skill of skills) {
    const phrases = skill.phrases.map((p) => `"${p}"`);
    out.push(`- \`${skill.folder}\`: ${phrases.length ? phrases.join(', ') : 'none'}`);
  }
  out.push('');
  return out.join('\n');
}

// ---- shared library copies -----------------------------------------------------------------------------------------

// Files every skill that has them carries as identical copies, because a skill may not import another skill by name.
export const SHARED_LIBS = ['roles.mjs', 'common.mjs', 'task.mjs', 'prompt.mjs', 'proc.mjs', 'cli.mjs'];

export function lintSharedLibs(root) {
  const problems = [];
  const skillsDir = path.join(root, 'skills');
  let folders = [];
  try {
    folders = fs.readdirSync(skillsDir).sort();
  } catch {
    return problems;
  }
  for (const name of SHARED_LIBS) {
    const copies = folders
      .map((folder) => path.join(skillsDir, folder, 'scripts', 'lib', name))
      .filter((file) => fs.existsSync(file))
      .map((file) => ({ file: path.relative(root, file), text: fs.readFileSync(file, 'utf8') }));
    // roles.mjs and cli.mjs exist under the same name in skills that keep their own (the ledger's cli.mjs); only
    // copies whose first line matches the first copy's are compared.
    const groups = new Map();
    for (const copy of copies) {
      const key = copy.text.split('\n')[0];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(copy);
    }
    for (const group of groups.values()) {
      const first = group[0];
      for (const other of group.slice(1)) {
        if (other.text !== first.text) problems.push(`${other.file}: differs from ${first.file}; shared library copies must be identical`);
      }
    }
  }
  return problems;
}

// ---- the command ---------------------------------------------------------------------------------------------------

export async function checkRoles(root, { mode = 'lint' } = {}) {
  const { skills, problems } = readSkills(root);
  const ledger = await loadLedger(root);
  const vocab = ledger.module
    ? {
      duties: Array.isArray(ledger.module.DUTIES) ? ledger.module.DUTIES : null,
      taskKinds: Array.isArray(ledger.module.TASK_KINDS) ? ledger.module.TASK_KINDS : null,
    }
    : null;
  problems.push(...lintSkills(skills, vocab));
  problems.push(...lintSharedLibs(root));
  if (ledger.problem) problems.push(ledger.problem);
  else problems.push(...lintKinds(root, ledger.module.KINDS).problems);
  const doc = renderRolesDoc(skills);
  const docPath = path.join(root, ROLES_DOC);
  if (mode === 'write') {
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, doc);
  } else if (mode === 'check') {
    let current = null;
    try {
      current = fs.readFileSync(docPath, 'utf8');
    } catch {}
    if (current === null) problems.push(`${ROLES_DOC}: missing; run node scripts/check-roles.mjs --write and commit it`);
    else if (current !== doc) problems.push(`${ROLES_DOC}: stale, it differs from the skills' frontmatter; run node scripts/check-roles.mjs --write and commit it`);
  }
  return { skills, problems, doc };
}

function parseArgs(argv) {
  const options = { root: null, mode: 'lint' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      if (!argv[i + 1]) throw new Error('--root needs a path');
      options.root = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--root=')) {
      options.root = path.resolve(arg.slice('--root='.length));
    } else if (arg === '--write' || arg === '--check') {
      const mode = arg.slice(2);
      if (options.mode !== 'lint' && options.mode !== mode) throw new Error('use --write or --check, not both');
      options.mode = mode;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return options;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const USAGE = 'usage: node scripts/check-roles.mjs [--root <repo root>] [--write | --check]';

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-roles: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { skills, problems } = await checkRoles(root, { mode: options.mode });
  if (options.mode === 'write') process.stdout.write(`check-roles: wrote ${ROLES_DOC} (${plural(skills.length, 'skill')})\n`);
  if (problems.length) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.stderr.write(`check-roles: ${plural(problems.length, 'problem')}\n`);
    return 1;
  }
  process.stdout.write(`check-roles: ${plural(skills.length, 'skill')}, ${KIND_COUNT} event kinds, clean\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
