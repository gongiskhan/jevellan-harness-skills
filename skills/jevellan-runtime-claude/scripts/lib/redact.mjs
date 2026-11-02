// The last line of defence for "secrets never appear in the ledger, in logs or in reports": every value in
// ~/.jevellan-harness/secrets/* and in every keyFile or tokenFile providers.json names is masked wherever it occurs,
// and so is the value of any assignment to a variable whose name says it holds a secret. Ported in spirit from the
// skills repo's redact.ts (D-014): values shorter than 8 characters are left alone, since masking them would mangle
// ordinary text and they are not real keys.

import fs from 'node:fs';
import path from 'node:path';
import { expandHome, harnessHome } from './project.mjs';

const MASK = '[redacted]';
const MIN = 8;
let cache = null;

function secretFiles() {
  const files = new Set();
  const dir = path.join(harnessHome(), 'secrets');
  try {
    for (const name of fs.readdirSync(dir)) files.add(path.join(dir, name));
  } catch {}
  try {
    const providers = JSON.parse(fs.readFileSync(path.join(harnessHome(), 'providers.json'), 'utf8'));
    if (providers?.jev?.keyFile) files.add(expandHome(providers.jev.keyFile));
    for (const provider of providers?.providers ?? []) {
      if (provider.keyFile) files.add(expandHome(provider.keyFile));
      if (provider.tokenFile) files.add(expandHome(provider.tokenFile));
    }
  } catch {}
  return [...files];
}

function stampsOf(files) {
  const stamps = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size <= 1 << 20) stamps.push({ file, key: `${file}:${stat.mtimeMs}:${stat.size}` });
    } catch {}
  }
  return stamps;
}

function loadValues(stamps) {
  const values = new Set();
  for (const { file } of stamps) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const whole = text.trim();
    if (whole.length >= MIN) values.add(whole);
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN) values.add(trimmed);
      const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(trimmed);
      if (assignment && assignment[1].trim().length >= MIN) values.add(assignment[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  // Longest first, so a value that contains another is masked whole.
  return [...values].sort((a, b) => b.length - a.length);
}

// The secret files are stat-ed on every call (a few microseconds) and read again only when one of them changed.
function current() {
  const stamps = stampsOf(secretFiles());
  const key = stamps.map((s) => s.key).join('|');
  if (!cache || cache.key !== key) cache = { key, values: loadValues(stamps) };
  return cache.values;
}

// The value is quoted ("..." or '...'), quoted inside JSON-encoded text (\"...\", as a command reads in a Codex event
// line), or bare; a bare value runs to the next space, quote or escaped quote, so masking it never leaves half an
// escape behind in a JSON line.
const ASSIGNMENT = /\b([A-Z][A-Z0-9_]*)=(\\"[^"]*?\\"|"[^"]*"|'[^']*'|(?:\\")?(?:[^\s"'\\]|\\(?!"))+)/g;
const SECRET_WORDS = new Set(['TOKEN', 'TOKENS', 'KEY', 'KEYS', 'APIKEY', 'SECRET', 'SECRETS', 'PASSWORD', 'PASSWD', 'PASS', 'AUTH', 'CREDENTIAL', 'CREDENTIALS', 'PAT']);
// A name says it holds a secret when one of its underscore-separated words is a secret word (GIT_AUTHOR_NAME is not).
export function secretName(name) {
  return name.split('_').some((word) => SECRET_WORDS.has(word));
}
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g;

// A text cut short (a command's first 200 characters, the last lines of a log) can end, or start, inside a secret,
// where the whole value no longer matches. A fragment of at least MIN characters at the end of a text that is the
// start of a known value, or at its start that is the end of one, is masked too. A text that is nothing but such a
// fragment is left alone: it is a value of its own, such as a provider name its token happens to start with, not
// what a cut left over, and masking it would corrupt the record that names it.
function maskFragments(text, values) {
  let out = text;
  let from = -1;
  for (const value of values) {
    if (value.length <= MIN) continue;
    const head = value.slice(0, MIN);
    for (let at = out.indexOf(head, Math.max(1, out.length - value.length + 1)); at !== -1; at = out.indexOf(head, at + 1)) {
      if (value.startsWith(out.slice(at))) {
        if (from === -1 || at < from) from = at;
        break;
      }
    }
  }
  if (from !== -1) out = out.slice(0, from) + MASK;
  let to = 0;
  for (const value of values) {
    if (value.length <= MIN) continue;
    const tail = value.slice(-MIN);
    const last = Math.min(out.length - 1, value.length - 1) - MIN;
    if (last < 0) continue;
    for (let at = out.lastIndexOf(tail, last); at !== -1; at = at > 0 ? out.lastIndexOf(tail, at - 1) : -1) {
      if (value.endsWith(out.slice(0, at + MIN))) {
        to = Math.max(to, at + MIN);
        break;
      }
    }
  }
  if (to > 0) out = MASK + out.slice(to);
  return out;
}

export function redactText(text, values = current()) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(MASK);
  }
  out = maskFragments(out, values);
  out = out.replace(ASSIGNMENT, (whole, name) => (secretName(name) ? `${name}:${MASK}` : whole));
  out = out.replace(BEARER, (_, word) => `${word} ${MASK}`);
  return out;
}

// The secret values are looked up once per call, not once per string.
export function redactValue(value, values = current()) {
  if (typeof value === 'string') return redactText(value, values);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, values));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, values);
    return out;
  }
  return value;
}
