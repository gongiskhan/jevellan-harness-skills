// The cost of the deterministic scripts, measured the same way on any checkout of this repository, so the move from
// in-process imports to process boundaries (docs/decisions.md H-031) has numbers before and after.
//
//   node acceptance/timings.mjs [--repo <checkout>] [--label <name>] [--runs N] [--out <file.json>]
//
// It installs <checkout>'s skills into a fresh temporary project with a private harness home and a fake `claude`
// binary (no model, no network), then times each command N times with Node 22 and prints the median and the slowest
// run in milliseconds. Fixture events (task.placed, a step's report and step.done) are written through <checkout>'s
// own ledger library, the one way that exists in every version. Nothing outside the temporary folders is touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { repo: { type: 'string' }, label: { type: 'string' }, runs: { type: 'string' }, out: { type: 'string' } } });
const REPO = path.resolve(values.repo ?? HERE);
const RUNS = Number(values.runs ?? 7);
const LABEL = values.label ?? path.basename(REPO);
const NODE = process.execPath;
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`run with Node 22 or later (this is ${process.version})`);

const base = fs.mkdtempSync(path.join(process.env.JH_TEST_TMPDIR || os.tmpdir(), 'jh-timings-'));
const HOME = path.join(base, 'harness');
fs.mkdirSync(path.join(HOME, 'secrets'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(HOME, 'secrets', 'bench.token'), 'bench-token-not-a-secret\n', { mode: 0o600 });
fs.writeFileSync(path.join(HOME, 'providers.json'), JSON.stringify({
  jev: { keyFile: path.join(HOME, 'secrets', 'jev.key'), model: 'jev-latest', timeoutMs: 4000 },
  providers: [{ name: 'bench', kind: 'claude-subscription', tokenFile: path.join(HOME, 'secrets', 'bench.token'), ceilingPct: 90, models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet', efforts: ['low'] }] }],
}));
const fakeBin = path.join(base, 'claude');
fs.writeFileSync(fakeBin, `#!${NODE}\nsetTimeout(() => process.exit(0), 30000);\n`, { mode: 0o755 });

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Bench', '-c', 'user.email=bench@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
const project = path.join(base, 'project');
fs.mkdirSync(project);
git(project, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(project, 'README.md'), '# bench\n');
git(project, 'add', 'README.md');
git(project, 'commit', '-q', '-m', 'init');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: base, JH_HARNESS_HOME: HOME, JH_CLAUDE_BIN: fakeBin };
const inst = spawnSync(NODE, [path.join(REPO, 'install.mjs'), project, '--json'], { encoding: 'utf8', env });
if (inst.status !== 0) throw new Error(`install failed: ${inst.stderr}`);
const cfg = path.join(project, '.jevellan', 'project.json');
const settings = JSON.parse(fs.readFileSync(cfg, 'utf8'));
delete settings.testCommand;
delete settings.setupCommand;
settings.checks = [];
fs.writeFileSync(cfg, JSON.stringify(settings, null, 2));

const skills = path.join(project, '.claude', 'skills');
const script = (skill, file) => path.join(skills, skill, 'scripts', file);
const ledgerLib = await import(pathToFileURL(path.join(skills, 'jevellan-ledger', 'scripts', 'lib', 'ledger.mjs')).href);

function run(file, args, cwd = project) {
  const t0 = performance.now();
  const r = spawnSync(NODE, [file, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`${path.basename(file)} ${args.join(' ')} exited ${r.status}: ${r.stderr || r.stdout}`);
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { ms, json };
}

const results = {};
const record = (name, ms) => {
  (results[name] ??= []).push(ms);
};
const ledger = (...args) => run(script('jevellan-ledger', 'ledger.mjs'), args);

for (let i = 0; i < RUNS; i += 1) {
  // ledger: create a task, append a note, read the status.
  let r = ledger('task', 'create', '--kind', 'single', '--duty', 'implement', '--title', `bench task ${i}`, '--text', 'Change the README.', '--json');
  record('ledger task create', r.ms);
  const task = r.json.task;
  record('ledger append note', ledger('append', 'note', '--task', task, '--data', '{"text":"bench"}', '--json').ms);
  record('ledger status --json', ledger('status', '--json').ms);

  // git: make the task's worktree.
  r = run(script('jevellan-git', 'worktree.mjs'), ['create', '--task', task, '--json']);
  record('worktree create', r.ms);
  const wt = r.json.path;

  // runtime: start a placed step on the fake binary, read its status, stop it.
  ledgerLib.appendEvent(project, { kind: 'task.placed', task, data: { step: 1, provider: 'bench', model: 'claude-sonnet-5-5', effort: 'low', kind: 'claude-subscription', source: 'owner' } });
  const runtime = (file, args) => run(script('jevellan-runtime-claude', file), [...args, '--json']);
  record('runtime start', runtime('start.mjs', ['--task', task, '--step', '1', '--duty', 'implement', '--cwd', wt, '--provider', 'bench', '--model', 'claude-sonnet-5-5', '--effort', 'low']).ms);
  record('runtime status', runtime('status.mjs', ['--task', task, '--step', '1']).ms);
  record('runtime stop', runtime('stop.mjs', ['--task', task, '--step', '1']).ms);

  // landing: the step reported done and was recorded done; the owner's Land now (no Jev, no checks).
  fs.appendFileSync(path.join(wt, 'README.md'), `bench ${i}\n`);
  git(wt, 'add', 'README.md');
  git(wt, 'commit', '-q', '-m', `bench ${i}`);
  ledgerLib.appendEvent(project, { kind: 'step.started', task, step: 1, session: `bench-${i}`, data: { ordinal: 1, duty: 'implement', runtime: 'claude', provider: 'bench', model: 'claude-sonnet-5-5', effort: 'low', cwd: wt, pid: 999999999 } });
  ledgerLib.appendEvent(project, { kind: 'step.report', task, step: 1, session: `bench-${i}`, data: { status: 'done', summary: 'Changed the README.', changedFiles: ['README.md'] } });
  record('ledger append step.done', ledger('append', 'step.done', '--task', task, '--step', '1', '--json').ms);
  record('land --force', run(script('jevellan-git', 'land.mjs'), ['--task', task, '--force', '--json']).ms);
}

const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'skills', 'install.mjs'], { encoding: 'utf8' }).trim() !== '';
const summary = { label: LABEL, repo: REPO, commit: `${execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}${dirty ? ' + uncommitted changes' : ''}`, node: process.version, runs: RUNS, at: new Date().toISOString(), host: os.hostname(), ms: {} };
for (const [name, list] of Object.entries(results)) summary.ms[name] = { median: Math.round(median(list)), max: Math.round(Math.max(...list)) };
if (values.out) {
  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  fs.writeFileSync(values.out, `${JSON.stringify(summary, null, 2)}\n`);
}
process.stdout.write(`${LABEL} (${summary.commit}, ${RUNS} runs, Node ${process.version}):\n`);
for (const [name, v] of Object.entries(summary.ms)) process.stdout.write(`  ${name.padEnd(26)} median ${String(v.median).padStart(5)} ms   max ${String(v.max).padStart(5)} ms\n`);
