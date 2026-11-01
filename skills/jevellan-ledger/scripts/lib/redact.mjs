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

const SECRET_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s"']+)/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g;

export function redactText(text, values = current()) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(MASK);
  }
  out = out.replace(SECRET_ASSIGNMENT, (_, name) => `${name}:${MASK}`);
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
