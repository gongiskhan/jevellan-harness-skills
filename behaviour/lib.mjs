// Helpers of the behaviour evals: run folders, fixture repositories, the harness home of a run, the coordinator
// session, teardown, and the evidence a run leaves (which the checks read). Plain ESM, Node 22, no dependencies.
//
// Where a run lives (the installer refuses any project under ~/.jevellan*, so the project clone cannot sit next to
// the rest of the run):
//   ~/.jevellan-harness/evals/behaviour/<run id>/          the run: origin.git (the bare "GitHub"), seed/ (where the
//       case authors other people's commits), home/ (the run's JH_HARNESS_HOME: providers.json cut to the case's
//       worker models, its own worktrees, logs and worker config), bin/gh (the fake GitHub CLI, its state and
//       calls.jsonl), artifacts/ (what collect() copied out: evidence.json, ledger excerpt, plans, transcript)
//   ~/jevellan-projects/jevellan-harness-evals/<run id>/<fixture>/   the project clone the coordinator works in
// A run id is <case>-<label>-r<n>. Older runs move to ~/.jevellan-harness/archive/evals/ (never deleted); the last
// three runs of each case and label stay.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO, NODE, OWNER_HOME, sh, readLedger } from '../acceptance/lib.mjs';
import { analyse, coordinatorSession, readTranscript, transcriptFile } from '../acceptance/coord.mjs';

export const BEHAVIOUR = path.join(REPO, 'behaviour');
export const FIXTURES = path.join(BEHAVIOUR, 'fixtures');
export const RESULTS = path.join(BEHAVIOUR, 'results');
export const MAIN_HOME = path.join(OWNER_HOME, '.jevellan-harness');
export const EVALS_HOME = path.join(MAIN_HOME, 'evals', 'behaviour');
export const PROJECTS_HOME = path.join(OWNER_HOME, 'jevellan-projects', 'jevellan-harness-evals');
export const ARCHIVE = path.join(MAIN_HOME, 'archive', 'evals');
export const KEEP_RUNS = 3;
export { REPO, NODE, OWNER_HOME, readLedger, analyse, readTranscript, transcriptFile, coordinatorSession };

// The identity of the fixtures' own history (the owner's teammates), never the machine's.
const FIXTURE_AUTHOR = { GIT_AUTHOR_NAME: 'Office Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Office Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' };

export function git(cwd, args, { env = {}, allowFail = false } = {}) {
  const r = sh('git', ['-C', cwd, ...args], { env: { ...process.env, ...FIXTURE_AUTHOR, ...env } });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ---- the plugin under test ----------------------------------------------------------------------------------------

// The folder Claude Code loads the harness from (--plugin-dir). "working" is this repository's working tree; any other
// value is a git ref (a tag such as v0.3.0), checked out once into a detached worktree under the evals home.
export function pluginDir(ref) {
  if (!ref || ref === 'working') return REPO;
  const dir = path.join(EVALS_HOME, 'plugins', ref);
  if (!fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(REPO, ['worktree', 'add', '--detach', dir, ref]);
  }
  return dir;
}

export function pluginCommit(dir) {
  return git(dir, ['rev-parse', 'HEAD']);
}

// ---- a run --------------------------------------------------------------------------------------------------------

export function nextRunNumber(caseId, label) {
  const dir = path.join(RESULTS, label);
  const used = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => new RegExp(`^${caseId}-r(\\d+)\\.json$`).exec(f)).filter(Boolean).map((m) => Number(m[1])) : [];
  const live = fs.existsSync(EVALS_HOME) ? fs.readdirSync(EVALS_HOME).map((f) => new RegExp(`^${caseId}-${label.replace(/[.]/g, '\\.')}-r(\\d+)$`).exec(f)).filter(Boolean).map((m) => Number(m[1])) : [];
  return Math.max(0, ...used, ...live) + 1;
}

export function newRun(caseDef, label, n, plugin) {
  const id = `${caseDef.id}-${label}-r${n}`;
  const runDir = path.join(EVALS_HOME, id);
  const projectsDir = path.join(PROJECTS_HOME, id);
  if (fs.existsSync(runDir) || fs.existsSync(projectsDir)) throw new Error(`run ${id} already exists`);
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  return {
    id,
    caseId: caseDef.id,
    label,
    n,
    plugin,
    runDir,
    projectsDir,
    home: path.join(runDir, 'home'),
    bin: path.join(runDir, 'bin'),
    origin: path.join(runDir, 'origin.git'),
    seed: path.join(runDir, 'seed'),
    artifacts: path.join(runDir, 'artifacts'),
    project: null,
    facts: {},
    hookLog: [],
  };
}

// The run's harness home: providers.json with only the claude-main provider, cut to `models`
// ([{id, efforts: [...]}]), or the main file whole when models is "all"; providers-state.json copied so placement does
// not probe again. Secrets stay where they are: providers.json names them by path under the owner's home.
export function makeHarnessHome(run, models) {
  fs.mkdirSync(run.home, { recursive: true, mode: 0o700 });
  const main = readJson(path.join(MAIN_HOME, 'providers.json'));
  if (!main) throw new Error(`no providers.json in ${MAIN_HOME}`);
  let providers = main;
  if (models !== 'all') {
    const claude = main.providers.find((p) => p.name === 'claude-main');
    if (!claude) throw new Error('providers.json has no claude-main provider');
    const known = new Map(claude.models.map((m) => [m.id, m]));
    const cut = models.map((m) => {
      const base = known.get(m.id);
      if (!base) throw new Error(`claude-main has no model ${m.id}`);
      return { ...base, efforts: m.efforts.filter((e) => base.efforts.includes(e)) };
    });
    providers = { ...main, providers: [{ ...claude, models: cut }] };
  }
  writeJson(path.join(run.home, 'providers.json'), providers);
  const state = path.join(MAIN_HOME, 'providers-state.json');
  if (fs.existsSync(state)) fs.copyFileSync(state, path.join(run.home, 'providers-state.json'));
  return run.home;
}

// The fake gh (or the read-only real one for the replay) at <run>/bin/gh.
export function installGh(run, { repo, prs = [], next = 100 } = {}) {
  fs.mkdirSync(run.bin, { recursive: true });
  const source = fs.readFileSync(path.join(FIXTURES, 'bin', 'gh.mjs'), 'utf8');
  fs.writeFileSync(path.join(run.bin, 'gh'), `#!${NODE}\n${source}`, { mode: 0o755 });
  writeJson(path.join(run.bin, 'gh-state.json'), { repo, next, prs });
  fs.writeFileSync(path.join(run.bin, 'calls.jsonl'), '');
}

export function installReadOnlyGh(run, { cutoff }) {
  fs.mkdirSync(run.bin, { recursive: true });
  const realGh = sh('which', ['gh']).stdout.trim();
  if (!realGh) throw new Error('no gh on PATH for the replay');
  const source = fs.readFileSync(path.join(FIXTURES, 'bin', 'gh-readonly.mjs'), 'utf8');
  fs.writeFileSync(path.join(run.bin, 'gh'), `#!${NODE}\n${source}`, { mode: 0o755 });
  writeJson(path.join(run.bin, 'readonly.json'), { realGh, cutoff });
  fs.writeFileSync(path.join(run.bin, 'calls.jsonl'), '');
}

export function ghState(run) {
  return readJson(path.join(run.bin, 'gh-state.json'), { prs: [] });
}

export function updateGhState(run, change) {
  const file = path.join(run.bin, 'gh-state.json');
  const state = readJson(file);
  writeJson(file, change(state) ?? state);
}

// ---- fixture repositories -----------------------------------------------------------------------------------------

// seed/ gets the fixture's base files plus `overlays` (folders under fixtures/<fixture>/), `mutate(seedDir)` edits
// them, and that is main's first commit; origin.git is a bare repository with that main; the project is a clone of it
// whose origin is https://github.com/<repo>.git, redirected to origin.git by url.<bare>.insteadOf (what the git
// skill's gh calls and pull request landing need).
export function makeFixtureRepos(run, { fixture, overlays = [], mutate, repo }) {
  const base = path.join(FIXTURES, fixture, 'base');
  copyDir(base, run.seed);
  for (const overlay of overlays) copyDir(path.join(FIXTURES, fixture, overlay), run.seed);
  if (mutate) mutate(run.seed);
  git(run.seed, ['init', '-q', '-b', 'main']);
  git(run.seed, ['add', '-A']);
  git(run.seed, ['commit', '-q', '-m', 'Initial version']);
  git(path.dirname(run.origin), ['init', '-q', '--bare', '-b', 'main', run.origin]);
  git(run.seed, ['remote', 'add', 'origin', run.origin]);
  git(run.seed, ['push', '-q', 'origin', 'main']);
  run.project = path.join(run.projectsDir, fixture);
  git(run.projectsDir, ['clone', '-q', run.origin, run.project]);
  const url = `https://github.com/${repo}.git`;
  git(run.project, ['config', `url.${run.origin}.insteadOf`, url]);
  git(run.project, ['remote', 'set-url', 'origin', url]);
  run.facts.repo = repo;
  run.facts.baseCommit = git(run.seed, ['rev-parse', 'HEAD']);
  return run.project;
}

// One commit in seed/ on `branch` (created from main when new) with the files of `overlay` (and `mutate`). Returns
// the commit. `squashInto` makes it a squash merge on main instead, as GitHub does for a pull request.
export function seedCommit(run, { fixture, overlay, mutate, message, branch = 'main' }) {
  const current = git(run.seed, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== current) {
    const exists = git(run.seed, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
    git(run.seed, exists ? ['checkout', '-q', branch] : ['checkout', '-q', '-b', branch, 'main']);
  }
  if (overlay) copyDir(path.join(FIXTURES, fixture, overlay), run.seed);
  if (mutate) mutate(run.seed);
  git(run.seed, ['add', '-A']);
  git(run.seed, ['commit', '-q', '-m', message]);
  const sha = git(run.seed, ['rev-parse', 'HEAD']);
  if (branch !== 'main') git(run.seed, ['checkout', '-q', 'main']);
  return sha;
}

export function seedPush(run, ref) {
  git(run.seed, ['push', '-q', 'origin', `${ref}:${ref}`]);
}

// Installs the harness into the project the way a plugin user does (install.mjs --project-only of the plugin under
// test), then writes the case's project.json fields over what the installer detected.
export function installHarness(run, projectFields) {
  const r = sh(NODE, [path.join(run.plugin, 'install.mjs'), run.project, '--project-only', '--json'], { cwd: run.project });
  if (r.status !== 0) throw new Error(`install.mjs --project-only: ${r.stderr.trim() || r.stdout.trim()}`);
  const file = path.join(run.project, '.jevellan', 'project.json');
  const detected = readJson(file, {});
  const merged = { ...detected, ...projectFields };
  for (const [k, v] of Object.entries(projectFields)) if (v === undefined) delete merged[k];
  writeJson(file, merged);
  return merged;
}

// ---- the coordinator --------------------------------------------------------------------------------------------

export function sessionName(run) {
  return `jh-beh-${run.caseId}-${run.label}-${run.n}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

export function coordinatorEnv(run) {
  const env = { JH_HARNESS_HOME: run.home, PATH: `${run.bin}:${process.env.PATH}` };
  return env;
}

// ---- following a run -------------------------------------------------------------------------------------------------

const STEP_END = new Set(['step.report', 'step.failed', 'step.lost', 'step.stopped']);

// The steps that started and have not ended, as {task, step, pid, seq}.
export function runningSteps(events) {
  const open = new Map();
  for (const e of events) {
    const key = `${e.task}#${e.step}`;
    if (e.kind === 'step.started') open.set(key, { task: e.task, step: e.step, pid: e.data?.pid ?? null, seq: e.seq, duty: e.data?.duty });
    else if (STEP_END.has(e.kind)) open.delete(key);
  }
  return [...open.values()];
}

// What the assistant said in the coordinator's transcript after `sinceIso`, oldest first: [{t, text}].
export function coordinatorTexts(transcript, sinceIso) {
  const out = [];
  for (const e of readTranscript(transcript)) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    if (sinceIso && e.timestamp && e.timestamp < sinceIso) continue;
    for (const c of e.message.content) if (c.type === 'text' && c.text.trim()) out.push({ t: e.timestamp ?? null, text: c.text });
  }
  return out;
}

// Token use of the coordinator's transcript (Claude Code records usage per assistant message, not a price).
export function transcriptUsage(transcript) {
  const seen = new Set();
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const e of readTranscript(transcript)) {
    const u = e.message?.usage;
    if (e.type !== 'assistant' || !u) continue;
    const id = e.message.id ?? e.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    total.input += u.input_tokens ?? 0;
    total.output += u.output_tokens ?? 0;
    total.cacheRead += u.cache_read_input_tokens ?? 0;
    total.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }
  return total;
}

// The cost a worker's stream-json log states in its result lines (one per turn; resumed sessions add more).
export function workerCost(logFile) {
  let usd = 0;
  if (!logFile || !fs.existsSync(logFile)) return null;
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
    if (!line.includes('"type":"result"')) continue;
    try {
      usd += JSON.parse(line).total_cost_usd ?? 0;
    } catch {}
  }
  return usd;
}

// ---- teardown ---------------------------------------------------------------------------------------------------------

function killGroup(pid) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGTERM');
    } catch {}
  }
}

// Every process of this user whose working folder or command line is inside the run's folders, except this one.
export function runProcesses(run) {
  const roots = [run.runDir, run.projectsDir].map((p) => fs.realpathSync(p));
  const found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let cwd = '';
    let cmd = '';
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      continue;
    }
    if (roots.some((r) => cwd === r || cwd.startsWith(r + path.sep) || cmd.includes(r))) found.push({ pid, cmd: cmd.slice(0, 160) });
  }
  return found;
}

// Ends the coordinator (its tmux session), the workers the ledger shows running, and anything else still running in
// the run's folders. Returns what it ended.
export async function teardown(run, coord) {
  const ended = [];
  if (coord?.exists()) {
    coord.kill();
    ended.push(`coordinator ${coord.name}`);
  }
  if (run.project) {
    for (const s of runningSteps(readLedger(run.project))) {
      if (s.pid) {
        killGroup(s.pid);
        ended.push(`worker ${s.task} step ${s.step} (pid ${s.pid})`);
      }
    }
  }
  await new Promise((r) => setTimeout(r, 3000));
  for (const p of runProcesses(run)) {
    killGroup(p.pid);
    ended.push(`pid ${p.pid}: ${p.cmd}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
  for (const p of runProcesses(run)) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {}
  }
  return ended;
}

// ---- evidence -------------------------------------------------------------------------------------------------------

function listFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

// What a run left, as plain data the checks read (no file access in a check): the ledger lines written after the
// prompt, per task its plan, branch diff against origin/main and evidence files, the fake gh's calls and pull
// requests, and the coordinator's words. Also written to <run>/artifacts/evidence.json.
export function collect(run, { startSeq, promptAt, transcript, stop }) {
  const all = readLedger(run.project);
  const events = all.filter((e) => e.seq > startSeq);
  git(run.project, ['fetch', '-q', 'origin'], { allowFail: true });
  const tasks = {};
  for (const created of events.filter((e) => e.kind === 'task.created')) {
    const task = created.task;
    const wt = events.find((e) => e.kind === 'task.worktree' && e.task === task)?.data ?? null;
    const info = { title: created.data?.title ?? '', parent: created.data?.parent ?? null, branch: wt?.branch ?? null, worktree: wt?.path ?? null, plan: null, files: [], patch: '', evidence: [], pushed: false };
    if (wt?.path && fs.existsSync(path.join(wt.path, 'plan.md'))) info.plan = fs.readFileSync(path.join(wt.path, 'plan.md'), 'utf8');
    if (wt?.path) info.evidence = listFiles(path.join(wt.path, '.jevellan', 'evidence'));
    if (wt?.branch) {
      const range = `origin/main...refs/heads/${wt.branch}`;
      info.files = git(run.project, ['diff', '--name-only', range], { allowFail: true }).split('\n').filter(Boolean);
      info.patch = git(run.project, ['diff', range], { allowFail: true }).slice(0, 400_000);
      info.commits = git(run.project, ['log', '--format=%H %s', `origin/main..refs/heads/${wt.branch}`], { allowFail: true }).split('\n').filter(Boolean);
      info.pushed = Boolean(git(run.project, ['ls-remote', 'origin', `refs/heads/${wt.branch}`], { allowFail: true }));
    }
    if (info.plan) fs.writeFileSync(path.join(run.artifacts, `plan-${task}.md`), info.plan);
    tasks[task] = info;
  }
  const gh = fs.existsSync(path.join(run.bin, 'gh-state.json')) ? ghState(run) : { prs: [] };
  const evidence = {
    case: run.caseId,
    label: run.label,
    run: run.n,
    facts: run.facts,
    hookLog: run.hookLog,
    startSeq,
    promptAt,
    events,
    tasks,
    gh: { calls: readJsonl(path.join(run.bin, 'calls.jsonl')), prs: gh.prs ?? [] },
    coordinator: { texts: transcript ? coordinatorTexts(transcript, promptAt) : [], slips: transcript && fs.existsSync(transcript) ? analyse(transcript, run.project).slips : [] },
    stop,
  };
  writeJson(path.join(run.artifacts, 'evidence.json'), evidence);
  fs.writeFileSync(path.join(run.artifacts, 'ledger-excerpt.jsonl'), events.filter((e) => e.kind !== 'session.event').map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (transcript && fs.existsSync(transcript)) fs.copyFileSync(transcript, path.join(run.artifacts, 'coordinator-transcript.jsonl'));
  return evidence;
}

// ---- retention --------------------------------------------------------------------------------------------------------

// Keeps the last KEEP_RUNS runs of `caseId` and `label`; older ones move (run folder and project folder together) to
// the archive. Archived runs are records, not meant to be reopened: their worktrees' git pointers name the old folders.
export function archiveOldRuns(caseId, label) {
  if (!fs.existsSync(EVALS_HOME)) return [];
  const re = new RegExp(`^${caseId}-${label.replace(/[.]/g, '\\.')}-r(\\d+)$`);
  const runs = fs.readdirSync(EVALS_HOME).map((f) => ({ f, m: re.exec(f) })).filter((x) => x.m).sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
  const moved = [];
  for (const { f } of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) {
    const target = path.join(ARCHIVE, f);
    fs.mkdirSync(target, { recursive: true });
    fs.renameSync(path.join(EVALS_HOME, f), path.join(target, 'run'));
    if (fs.existsSync(path.join(PROJECTS_HOME, f))) fs.renameSync(path.join(PROJECTS_HOME, f), path.join(target, 'project'));
    moved.push(f);
  }
  return moved;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function isoNow() {
  return new Date().toISOString();
}

export function tmpName(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}`);
}

export function runSync(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}
