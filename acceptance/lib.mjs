// Shared helpers of the acceptance journeys H1 to H12. Plain ESM, Node 22, no dependencies.
//
// The journeys run on the build machine against the sandbox copy (~/jevellan-projects/jevellan-harness-sandbox, or
// JH_SANDBOX), drive the installed skills' scripts directly or type into the coordinator's tmux window, and assert on
// the ledger. Each journey records its checks in acceptance/results/<id>.json; writeResultsMd() assembles
// acceptance/RESULTS.md from those files. Nothing here prints a secret: leak checks feed patterns to grep on stdin
// and print only file names.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OWNER_HOME = os.userInfo().homedir;
export const NODE = process.execPath;
export const SANDBOX = process.env.JH_SANDBOX || path.join(OWNER_HOME, 'jevellan-projects', 'jevellan-harness-sandbox');
export const HARNESS = process.env.JH_HARNESS_HOME || path.join(OWNER_HOME, '.jevellan-harness');
export const RESULTS_DIR = path.join(REPO, 'acceptance', 'results');
export const OUT_DIR = path.join(REPO, 'acceptance', 'out');
export const SANDBOX_TEST_COMMAND = 'TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test';

export function skillDir(project, name) {
  return path.join(project, '.claude', 'skills', name);
}

export function sh(command, args, options = {}) {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json, error: r.error };
}

export function git(cwd, args) {
  return sh('git', ['-C', cwd, ...args]).stdout.trim();
}

// Runs a script of an installed skill in `project` with Node 22.
export function skillScript(project, skill, relative, args, options = {}) {
  return sh(NODE, [path.join(skillDir(project, skill), relative), ...args], { cwd: options.cwd ?? project, ...options });
}

export function ledgerCli(project, args, options = {}) {
  return skillScript(project, 'jevellan-ledger', 'scripts/ledger.mjs', args, options);
}

// The installed ledger library of `project`, for journeys that must write events the way a script does.
export async function ledgerLib(project) {
  return import(pathToFileURL(path.join(skillDir(project, 'jevellan-ledger'), 'scripts', 'lib', 'ledger.mjs')).href);
}

export function readLedger(project) {
  const file = path.join(project, '.jevellan', 'ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function until(predicate, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

// ---- checks and results --------------------------------------------------------------------------------------

export class Journey {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.startedAt = new Date().toISOString();
    this.t0 = Date.now();
    this.checks = [];
    this.notes = [];
    this.timings = {};
    this.status = null;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`== ${id} ${title} (${this.startedAt})`);
  }

  check(name, ok, detail = '') {
    const entry = { name, ok: Boolean(ok), detail: String(detail ?? ''), at: new Date().toISOString() };
    this.checks.push(entry);
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${name}${entry.detail ? ` - ${entry.detail}` : ''}`);
    return entry.ok;
  }

  note(text) {
    this.notes.push(String(text));
    console.log(`note: ${text}`);
  }

  time(name, ms) {
    this.timings[name] = ms;
    console.log(`time: ${name} ${ms} ms`);
  }

  // status: 'passed' when every check passed, 'failed' otherwise, or an explicit 'blocked: <reason>' /
  // 'skipped: <reason>'.
  finish(explicit) {
    const failed = this.checks.filter((c) => !c.ok).length;
    this.status = explicit ?? (failed === 0 && this.checks.length > 0 ? 'passed' : 'failed');
    const result = {
      id: this.id,
      title: this.title,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - this.t0,
      passed: this.checks.length - failed,
      total: this.checks.length,
      timings: this.timings,
      notes: this.notes,
      checks: this.checks,
    };
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULTS_DIR, `${this.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    writeResultsMd();
    console.log(`== ${this.id} ${this.status}: ${result.passed}/${result.total} checks, ${Math.round(result.elapsedMs / 1000)} s`);
    process.exitCode = this.status === 'passed' || this.status.startsWith('skipped') ? 0 : 1;
    return result;
  }
}

export function writeResultsMd() {
  const files = fs.existsSync(RESULTS_DIR) ? fs.readdirSync(RESULTS_DIR).filter((f) => /^H\d+\.json$/.test(f)) : [];
  const results = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8')))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const lines = [
    '# Acceptance results',
    '',
    'Generated by `acceptance/lib.mjs` from `acceptance/results/H*.json`; each journey script rewrites its own file.',
    'Times are UTC.',
    '',
    '| Journey | Status | Checks | Elapsed | Finished |',
    '|---|---|---|---|---|',
  ];
  for (const r of results) {
    lines.push(`| ${r.id} ${r.title} | ${r.status} | ${r.passed}/${r.total} | ${Math.round(r.elapsedMs / 1000)} s | ${r.finishedAt} |`);
  }
  for (const r of results) {
    lines.push('', `## ${r.id} ${r.title}`, '', `Status: ${r.status}. Started ${r.startedAt}, ${Math.round(r.elapsedMs / 1000)} s.`, '');
    if (Object.keys(r.timings ?? {}).length) {
      lines.push('Timings: ' + Object.entries(r.timings).map(([k, v]) => `${k} ${v} ms`).join('; ') + '.', '');
    }
    for (const c of r.checks) lines.push(`- ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail.replace(/\n/g, ' ')}` : ''}`);
    if (r.notes?.length) {
      lines.push('', 'Notes:');
      for (const n of r.notes) lines.push(`- ${n.replace(/\n/g, ' ')}`);
    }
  }
  lines.push(...comparisonLines());
  fs.writeFileSync(path.join(REPO, 'acceptance', 'RESULTS.md'), `${lines.join('\n')}\n`);
}

// The before-and-after section, from acceptance/results/comparison.json (written by acceptance/compare-timings.mjs).
function comparisonLines() {
  const file = path.join(RESULTS_DIR, 'comparison.json');
  if (!fs.existsSync(file)) return [];
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = ['', `## ${c.title}`, '', ...c.intro.map((p) => `${p}\n`), `### The scripts alone (\`acceptance/timings.mjs\`, median of ${c.scripts.runs} runs, ms)`, ''];
  out.push(`| Command | ${c.scripts.before.label} | ${c.scripts.after.label} | Added |`, '|---|---|---|---|');
  for (const [name, before] of Object.entries(c.scripts.before.ms)) {
    const after = c.scripts.after.ms[name];
    out.push(`| ${name} | ${before.median} | ${after?.median ?? '-'} | ${after ? after.median - before.median : '-'} |`);
  }
  out.push('', `Before: ${c.scripts.before.commit}, measured ${c.scripts.before.at}; after: ${c.scripts.after.commit}, measured ${c.scripts.after.at}; Node ${c.scripts.after.node}.`, '');
  out.push('### The journeys (elapsed, and the timings each journey records)', '', `| Journey | ${c.journeys.beforeLabel} | ${c.journeys.afterLabel} |`, '|---|---|---|');
  for (const j of c.journeys.rows) out.push(`| ${j.id} | ${j.before} | ${j.after} |`);
  if (c.notes?.length) {
    out.push('', '### What changed in the journeys for this run, and why', '');
    for (const n of c.notes) out.push(`- ${n}`);
  }
  return out;
}

// ---- workers by hand (H3; later journeys use the runtime's start.mjs) ------------------------------------------

export async function runtimeEnvLib() {
  return import(pathToFileURL(path.join(REPO, 'skills', 'jevellan-runtime-claude', 'scripts', 'lib', 'env.mjs')).href);
}

// Parses a stream-json transcript into {result, sessionId, tools: [{name, input}], hooks: [...], texts: [...]}.
export function parseStream(text) {
  const out = { result: null, sessionId: null, tools: [], hooks: [], texts: [], toolResults: [] };
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'system' && j.subtype === 'init') out.sessionId = j.session_id;
    if (j.type === 'result') {
      out.result = j.result;
      out.sessionId = out.sessionId ?? j.session_id;
    }
    if (j.type === 'assistant') {
      for (const c of j.message?.content ?? []) {
        if (c.type === 'tool_use') out.tools.push({ name: c.name, input: c.input });
        if (c.type === 'text') out.texts.push(c.text);
      }
    }
    if (j.type === 'user') {
      for (const c of j.message?.content ?? []) if (c.type === 'tool_result') out.toolResults.push(typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
    }
    if (j.type === 'system' && /hook/.test(j.subtype ?? '')) out.hooks.push(j);
  }
  return out;
}

// The pattern H12 greps for, built so this file does not contain it.
export const TOKEN_ASSIGNMENT = ['CLAUDE_CODE_OAUTH_TOKEN', '='].join('');
