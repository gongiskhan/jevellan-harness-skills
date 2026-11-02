// Fixtures for this skill's own tests, which run with only this skill present (scripts/test-skills.mjs copies the
// skill folder alone): temporary folders, git projects, a private harness home, a fake Jev on 127.0.0.1, and a
// temporary skills root holding a copy of this skill next to fake sibling skills written here (duty and runtime
// skills with frontmatter only, and a fake ledger skill whose public script answers from canned data and records every
// call). Nothing here imports or reads another skill of the repository.
//
// Importing this module points JH_HARNESS_HOME at a fresh temporary folder and clears the worker variables and the
// test-server overrides, so nothing reads or writes the real ~/.jevellan-harness. Temporary folders go under
// JH_TEST_TMPDIR when it is set; nothing here deletes them.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILL_NAME = path.basename(SKILL_DIR);
export const NODE = process.execPath;

const BASE = process.env.JH_TEST_TMPDIR || os.tmpdir();

export function tempDir(prefix = 'jh-router-test-') {
  fs.mkdirSync(BASE, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(BASE, prefix)));
}

export const WORKER_VARS = ['JH_TASK', 'JH_STEP', 'JH_DUTY', 'JH_PROJECT', 'JH_SESSION', 'JH_CWD'];
for (const name of [...WORKER_VARS, 'JH_JEV_URL', 'JH_ANTHROPIC_URL']) delete process.env[name];
export const HARNESS_HOME = tempDir('jh-harness-');
process.env.JH_HARNESS_HOME = HARNESS_HOME;

// The environment of a child: only what it needs; `extra` adds to it, and a null or undefined value removes a key.
export function childEnv(extra = {}) {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? os.homedir(), JH_HARNESS_HOME: HARNESS_HOME };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// A git project with one commit and a .jevellan folder (what the installer leaves behind).
export function makeRepo() {
  const root = tempDir('jh-repo-');
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '--no-verify', '-m', 'init');
  fs.mkdirSync(path.join(root, '.jevellan'), { recursive: true });
  return root;
}

// Runs `script` with `args`; resolves {status, stdout, stderr, json()} once it exited. Asynchronous, so a fake server
// in this process can answer it.
export function runNode(script, args, { cwd, env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [script, ...args], { cwd, env: childEnv(env), stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) }));
    if (input !== undefined) child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

// ---- skills ------------------------------------------------------------------------------------------------------

export function skillFile(dir, frontmatter, body = 'A fake skill for tests.\n') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter.join('\n')}\n---\n\n${body}`);
}

// What a placement test's copy of providers.mjs is replaced by: route.mjs imports it only to probe stale logins.
export const STUB_NO_PROBE = "export async function checkProviders() { throw new Error('the fixture does not probe'); }\n";

/** A copy of this skill under `skills`, optionally with its providers.mjs replaced; returns the copy's folder. */
export function copySkill(skills, { providersStub } = {}) {
  const copy = path.join(skills, SKILL_NAME);
  fs.cpSync(SKILL_DIR, copy, { recursive: true, filter: (source) => !source.endsWith(`${path.sep}evals${path.sep}RESULTS.md`) });
  if (providersStub !== undefined) fs.writeFileSync(path.join(copy, 'scripts', 'providers.mjs'), providersStub);
  return copy;
}

export function fakeDuty(skills, duty, needs) {
  skillFile(path.join(skills, `fake-duty-${duty}`), [`name: fake-duty-${duty}`, `description: Duty ${duty}. A fake for tests.`, 'jh-role: duty', `jh-duty: ${duty}`, `jh-needs: [${needs.join(', ')}]`]);
}

export function fakeRuntime(skills, name, kinds) {
  skillFile(path.join(skills, `fake-runtime-${name}`), [`name: fake-runtime-${name}`, 'description: Runtime. A fake for tests.', 'jh-role: runtime', `jh-kinds: [${kinds.join(', ')}]`]);
}

// The fake ledger skill's public script. It answers from data.json next to it ({show: {<T>: <show --json>}, events:
// [...], refuse: {<command>: {exitCode, error}}}) and appends every call ({argv, cwd, stdin, project, session}) to
// calls.jsonl. `record` appends the line to data.events and prints it, as the real command does.
const FAKE_LEDGER = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(here, 'data.json');
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const argv = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), stdin, project: process.env.JH_PROJECT ?? null, session: process.env.JH_SESSION ?? null }) + '\\n');
const print = (code, value) => { process.stdout.write(JSON.stringify(value) + '\\n'); process.exitCode = code; };
const fail = (code, error) => { process.stderr.write(error + '\\n'); print(code, { error, exitCode: code }); };
const opts = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const events = data.events ?? [];
const lastSeq = () => events.reduce((m, e) => Math.max(m, e.seq), 0);
const [command] = argv;
if (!argv.includes('--json')) fail(2, 'the fake ledger answers --json only');
else if (data.refuse?.[command]) fail(data.refuse[command].exitCode, data.refuse[command].error);
else if (command === 'show') {
  const shown = data.show?.[argv[1]];
  if (shown) print(0, shown);
  else fail(3, 'no task ' + argv[1] + " in this project's ledger");
} else if (command === 'events') {
  const tasks = opts('--task');
  const kinds = opts('--kind');
  const since = Number(opts('--since')[0] ?? 0);
  print(0, { lastSeq: lastSeq(), events: events.filter((e) => (!tasks.length || tasks.includes(e.task)) && (!kinds.length || kinds.includes(e.kind)) && e.seq > since) });
} else if (command === 'record') {
  const task = opts('--task')[0];
  const step = opts('--step')[0];
  const session = opts('--session')[0];
  if (!data.show?.[task]) fail(3, 'no task ' + task + " in this project's ledger");
  else {
    const event = { seq: lastSeq() + 1, t: new Date().toISOString(), kind: argv[1], task, ...(step ? { step: Number(step) } : {}), ...(session ? { session } : {}), data: JSON.parse(opts('--data-file')[0] === '-' ? stdin : '{}') };
    events.push(event);
    fs.writeFileSync(dataFile, JSON.stringify({ ...data, events }));
    print(0, event);
  }
} else fail(2, 'the fake ledger has no command ' + command);
`;

/** A fake ledger skill (role ledger) under `skills`; returns {dir, write(data), calls()}. */
export function fakeLedger(skills, data = {}) {
  const dir = path.join(skills, 'fake-ledger');
  skillFile(dir, ['name: fake-ledger', 'description: Ledger. A fake for tests.', 'jh-role: ledger']);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'ledger.mjs'), FAKE_LEDGER);
  const dataFile = path.join(dir, 'scripts', 'data.json');
  const callsFile = path.join(dir, 'scripts', 'calls.jsonl');
  const write = (value) => fs.writeFileSync(dataFile, JSON.stringify({ show: {}, events: [], ...value }));
  write(data);
  return {
    dir,
    write,
    data: () => readJson(dataFile),
    calls: () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

// ---- ledger data -------------------------------------------------------------------------------------------------

/** A step view as show --json prints it: the seqs of the lines, null where there is none. */
export function seqView({ state = 'pending', starts = 0, started = null, end = null, done = null, lastReport = null, placed = null } = {}) {
  return { state, starts, started, end, done, lastReport, placed };
}

/**
 * What the ledger's `show T --json` prints for a task whose lines are `events` (the task's own, task.created first),
 * with the step views given as {ordinal: {current, overall?, resetSeq?}} (overall defaults to current).
 */
export function showJson(events, views = {}) {
  const created = events.find((e) => e.kind === 'task.created');
  const d = created.data;
  return {
    task: created.task,
    kind: d.kind,
    duty: d.duty ?? null,
    title: d.title,
    state: 'open',
    reason: null,
    steps: [],
    currentStep: null,
    worktree: null,
    text: d.text,
    lastSeq: events.reduce((m, e) => Math.max(m, e.seq), 0),
    views: Object.entries(views).map(([ordinal, v]) => ({ ordinal: Number(ordinal), resetSeq: v.resetSeq ?? 0, current: seqView(v.current), overall: seqView(v.overall ?? v.current) })),
    events,
  };
}

/** Builds ledger lines with increasing seqs: line(kind, task, data, step). */
export function lineMaker(start = 0) {
  let seq = start;
  return (kind, task, data = {}, step) => ({ seq: (seq += 1), t: new Date(Date.UTC(2026, 10, 2, 9, 0, seq)).toISOString(), kind, task, ...(step === undefined ? {} : { step }), data });
}

// ---- the harness home ------------------------------------------------------------------------------------------------

/**
 * A harness home with providers.json, providers-state.json (fresh, ready entries unless `state` overrides one; null
 * leaves a provider out) and dummy secret files. providers: [{name, kind, models, ...}].
 */
export function harnessHome({ providers, state = {}, jevKey = 'jev-fixture-key-0123456789', jevModel = 'jev-latest', observedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString() }) {
  const home = tempDir('jh-router-home-');
  const secrets = path.join(home, 'secrets');
  fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const secret = (name, value) => {
    const file = path.join(secrets, name);
    fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
    return file;
  };
  const jevKeyFile = path.join(secrets, 'jev.key');
  if (jevKey) secret('jev.key', jevKey);
  const list = providers.map((spec) => {
    const p = { ...spec };
    if (p.kind === 'claude-subscription' && !p.tokenFile) p.tokenFile = secret(`${p.name}.token`, `${p.name}-fixture-token-000000`);
    if ((p.kind === 'claude-endpoint' || p.kind === 'openai-compatible') && !p.keyFile) p.keyFile = secret(`${p.name}.key`, `${p.name}-fixture-key-000000`);
    if (p.kind === 'claude-endpoint' || p.kind === 'openai-compatible') p.baseUrl ??= 'https://endpoint.invalid/v1';
    return p;
  });
  writeJson(path.join(home, 'providers.json'), { jev: { keyFile: jevKeyFile, model: jevModel, timeoutMs: 4000 }, providers: list });
  const entries = {};
  for (const p of list) {
    const override = Object.hasOwn(state, p.name) ? state[p.name] : {};
    if (override === null) continue;
    entries[p.name] = { auth: 'ready', detail: 'fixture', weeklyPct: 10, fiveHourPct: 5, weeklyResetsAt: null, fiveHourResetsAt: null, observedAt, ...override };
  }
  writeJson(path.join(home, 'providers-state.json'), { checkedAt: observedAt, jev: null, providers: entries });
  return { home, jevKeyFile, providersFile: path.join(home, 'providers.json') };
}

// ---- the fake Jev ------------------------------------------------------------------------------------------------

function choiceAnswer(question, pick) {
  const keys = Object.keys(question.criteria);
  let choice = keys[0];
  if (pick !== undefined) choice = keys.find((k) => k === pick) ?? keys.find((k) => k.startsWith(`${pick} `)) ?? keys[0];
  const others = keys.filter((k) => k !== choice);
  return { type: 'choice', choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.7 : 0.3 / others.length])), confidence: 0.8 };
}

/**
 * A fake Jev on 127.0.0.1: GET <base>/models and POST <base>/systemone. `picks` steers the answers ({<question id>:
 * option label or noul probability}); `queue` scripts the next responses (a status number, or a function (body, send)).
 * The key is compared and never stored: each request keeps only whether it was right.
 */
export async function startJev({ key, prefix = '' } = {}) {
  const jev = { requests: [], queue: [], picks: {}, models: ['jev-latest', 'jev-preview'], connections: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {}
      jev.requests.push({ method: req.method, path: req.url, authorized: req.headers.authorization === `Bearer ${key}`, body: parsed });
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof value === 'string' ? value : JSON.stringify(value));
      };
      const next = jev.queue.shift();
      if (typeof next === 'number') return send(next, { error: 'scripted failure' });
      if (typeof next === 'function') return next(parsed, send);
      if (req.method === 'GET' && req.url === `${prefix}/models`) return send(200, { models: jev.models.map((name) => ({ name, description: '', release_date: '2026-10-22' })) });
      if (req.method === 'POST' && req.url === `${prefix}/systemone`) {
        const answers = {};
        for (const [id, q] of Object.entries(parsed.questions)) answers[id] = q.type === 'noul' ? { type: 'noul', noul: jev.picks[id] ?? 0.5 } : choiceAnswer(q, jev.picks[id]);
        return send(200, { model: 'jev-test-1', answers, usage: { input_tokens: 120, output_tokens: 8 } });
      }
      return send(404, { error: 'no such route' });
    });
  });
  server.on('connection', () => {
    jev.connections += 1;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  jev.port = server.address().port;
  jev.url = `http://127.0.0.1:${jev.port}${prefix}`;
  jev.systemone = () => jev.requests.filter((r) => r.path === `${prefix}/systemone`);
  jev.reset = () => {
    jev.requests.length = 0;
    jev.queue.length = 0;
    jev.picks = {};
    jev.models = ['jev-latest', 'jev-preview'];
  };
  jev.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  return jev;
}
