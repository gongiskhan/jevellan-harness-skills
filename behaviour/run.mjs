#!/usr/bin/env node
// The behaviour evals' runner.
//
//   node behaviour/run.mjs [--case B01[,B02...]] [--runs N] [--plugin <ref>|working] [--version <label>]
//                          [--parallel K] [--evaluate <run id>[,<run id>...]] [--report]
//
// --case     which cases (default: every case; B08 has no session of its own and is judged from B03 and B07b runs)
// --runs     runs per case (default 3; a case may lower its own default, R01 runs 2)
// --plugin   the harness under test: a git ref of this repository (v0.3.0) checked out into a worktree under the
//            evals home, or "working" (this working tree, the default)
// --version  the label results are filed under (default: the ref without its v, or package.json's version)
// --parallel how many runs at once (default 3), each in its own tmux session jh-beh-<case>-<label>-<n>
// --evaluate run the checks and the judge again on finished runs, from their evidence.json (a corrected check)
// --report   only rewrite behaviour/RESULTS.md from behaviour/results/
//
// A run: a fresh fixture (bare origin, project clone, the run's harness home and fake gh), the harness installed with
// install.mjs --project-only of the plugin under test, a coordinator started in tmux with --plugin-dir, the case's
// prompt, then the ledger followed until the case's stop rule, the coordinator waits on the owner with no step
// running, or the case's timeout; then teardown, evidence, checks, judge, results/<label>/<case>-r<n>.json.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  BEHAVIOUR,
  EVALS_HOME,
  ARCHIVE,
  RESULTS,
  REPO,
  analyse,
  archiveOldRuns,
  collect,
  coordinatorEnv,
  coordinatorSession,
  git,
  installGh,
  installHarness,
  installReadOnlyGh,
  isoNow,
  makeFixtureRepos,
  makeHarnessHome,
  newRun,
  nextRunNumber,
  pluginCommit,
  pluginDir,
  readJson,
  readLedger,
  runningSteps,
  seedCommit,
  seedPush,
  sessionName,
  teardown,
  transcriptUsage,
  updateGhState,
  workerCost,
  writeJson,
} from './lib.mjs';
import { judge } from './judge.mjs';

const POLL_MS = 5000;
const IDLE_MS = 150_000;
const SETTLE_MS = 120_000;

export async function loadCases() {
  const dir = path.join(BEHAVIOUR, 'cases');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
    out.push((await import(pathToFileURL(path.join(dir, f)).href)).default);
  }
  return out;
}

const log = (run, text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${run ? `${run.id}: ` : ''}${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- evaluation ---------------------------------------------------------------------------------------------------

export function evaluate(caseDef, ev, { withJudge = true } = {}) {
  const checks = caseDef.checks.map((c) => {
    try {
      const r = c.check(ev);
      return { name: c.name, pass: Boolean(r.pass), detail: String(r.detail ?? '') };
    } catch (error) {
      return { name: c.name, pass: false, detail: `the check threw: ${error.message}` };
    }
  });
  let judged = null;
  if (caseDef.judge && withJudge) {
    const material = caseDef.judge.material(ev);
    judged = material ? judge({ rubric: caseDef.judge.rubric, material }) : { score: 0, reasons: ['nothing to judge'], skipped: true };
    judged.threshold = caseDef.judge.threshold;
    judged.pass = !judged.error && judged.score >= caseDef.judge.threshold;
  }
  const pass = checks.every((c) => c.pass) && (!judged || judged.pass);
  return { verdict: pass ? 'pass' : 'fail', checks, judge: judged };
}

function costOf(ev, transcript, judged) {
  const workers = ev.events.filter((e) => e.kind === 'step.started').map((e) => workerCost(e.data?.logFile)).filter((x) => x !== null);
  return {
    workersUsd: workers.length ? Number(workers.reduce((a, b) => a + b, 0).toFixed(4)) : null,
    judgeUsd: judged?.costUsd ?? null,
    coordinatorTokens: transcript && fs.existsSync(transcript) ? transcriptUsage(transcript) : null,
  };
}

// ---- one run ------------------------------------------------------------------------------------------------------

export async function runOnce(caseDef, { label, n, plugin }) {
  const run = newRun(caseDef, label, n, plugin);
  const h = { git, seedCommit, seedPush, updateGhState, installReadOnlyGh, readJson };
  const t0 = Date.now();
  let coord = null;
  let transcript = null;
  let stop = { reason: 'not started', elapsedMs: 0 };
  let startSeq = 0;
  let promptAt = null;
  try {
    makeHarnessHome(run, caseDef.workers);
    if (caseDef.makeRepos) caseDef.makeRepos(run, h);
    else {
      installGh(run, { repo: caseDef.repo });
      makeFixtureRepos(run, { fixture: caseDef.fixture, overlays: caseDef.overlays ?? [], mutate: caseDef.mutate, repo: caseDef.repo });
    }
    if (caseDef.setup) await caseDef.setup(run, h);
    installHarness(run, run.projectFields ?? caseDef.project);
    run.afterInstall?.();
    startSeq = readLedger(run.project).at(-1)?.seq ?? 0;
    coord = coordinatorSession(sessionName(run));
    const args = ['--plugin-dir', run.plugin, '--model', caseDef.coordinator.model, '--effort', caseDef.coordinator.effort];
    log(run, `starting the coordinator (${caseDef.coordinator.model} ${caseDef.coordinator.effort}) in ${run.project}`);
    const started = await coord.start(run.project, { args, env: coordinatorEnv(run) });
    transcript = started.transcript;
    promptAt = isoNow();
    await coord.send(caseDef.prompt(run));
    stop = await follow(caseDef, run, h, { startSeq, transcript, coord, t0 });
    log(run, `stop: ${stop.reason}`);
    // Let the coordinator finish the turn it is in (it tells the owner what it just did) before ending it.
    await settle(run, transcript, coord);
  } catch (error) {
    stop = { reason: `error: ${error.message}`, elapsedMs: Date.now() - t0, error: true };
    log(run, stop.reason);
  }
  const ended = await teardown(run, coord);
  if (ended.length) log(run, `ended ${ended.length} process(es)`);
  const ev = run.project ? collect(run, { startSeq, promptAt, transcript, stop }) : { events: [], tasks: {}, gh: { calls: [], prs: [] }, coordinator: { texts: [] }, facts: run.facts, hookLog: run.hookLog, stop };
  // The run's GitHub must have been the fake (or the replay's wrapper): landing or an overlap check without a single
  // logged gh call means the session reached some other gh, and the run proves nothing.
  const ghUsed = (ev.gh?.calls ?? []).length > 0;
  const ghNeeded = ev.events.some((e) => e.kind === 'landing.decided' || (e.kind === 'note' && e.data?.overlap));
  if (!stop.error && ghNeeded && !ghUsed) stop = { ...stop, reason: `error: landing or an overlap check ran but the run's gh logged no call (${stop.reason})`, error: true };
  const result = stop.error ? { verdict: 'error', checks: [], judge: null } : evaluate(caseDef, ev);
  const out = {
    case: caseDef.id,
    title: caseDef.title,
    label,
    run: n,
    id: run.id,
    plugin: run.plugin,
    pluginCommit: pluginCommit(run.plugin),
    coordinator: caseDef.coordinator,
    workers: caseDef.workers,
    startedAt: new Date(t0).toISOString(),
    elapsedMs: Date.now() - t0,
    stop,
    ...result,
    tasks: Object.keys(ev.tasks ?? {}),
    cost: costOf(ev, transcript, result.judge),
    runDir: run.runDir,
    projectDir: run.projectsDir,
    evidenceFile: path.join(run.artifacts, 'evidence.json'),
    ledgerExcerpt: path.join(run.artifacts, 'ledger-excerpt.jsonl'),
    transcript,
  };
  writeJson(path.join(RESULTS, label, `${caseDef.id}-r${n}.json`), out);
  log(run, `${out.verdict.toUpperCase()} ${result.checks.filter((c) => c.pass).length}/${result.checks.length} checks${result.judge ? `, judge ${result.judge.score}` : ''} in ${Math.round(out.elapsedMs / 60000)} min`);
  const moved = archiveOldRuns(caseDef.id, label);
  if (moved.length) log(run, `archived ${moved.join(', ')}`);
  return out;
}

async function follow(caseDef, run, h, { startSeq, transcript, coord, t0 }) {
  const deadline = t0 + (caseDef.timeoutMin ?? 20) * 60_000;
  let lastSeq = startSeq;
  let lastChange = Date.now();
  let lastSize = -1;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (!coord.exists()) return { reason: 'the coordinator session ended by itself', elapsedMs: Date.now() - t0 };
    const all = readLedger(run.project);
    const events = all.filter((e) => e.seq > startSeq);
    const seq = all.at(-1)?.seq ?? startSeq;
    const size = fs.existsSync(transcript) ? fs.statSync(transcript).size : 0;
    if (seq !== lastSeq || size !== lastSize) {
      lastSeq = seq;
      lastSize = size;
      lastChange = Date.now();
    }
    const state = { events, lastSeq: seq, elapsedMs: Date.now() - t0, running: runningSteps(events) };
    if (caseDef.onPoll) await caseDef.onPoll(state, run, h);
    const reason = caseDef.stopAfter(state, run);
    if (reason) return { reason, elapsedMs: Date.now() - t0 };
    const idle = state.running.length === 0 && Date.now() - lastChange > IDLE_MS && fs.existsSync(transcript) && analyse(transcript, run.project).idle;
    if (idle) return { reason: 'the coordinator waits (idle, no step running)', elapsedMs: Date.now() - t0 };
  }
  return { reason: `timeout after ${caseDef.timeoutMin ?? 20} min`, elapsedMs: Date.now() - t0, timeout: true };
}

async function settle(run, transcript, coord) {
  const deadline = Date.now() + SETTLE_MS;
  let lastSize = -1;
  let quiet = 0;
  while (Date.now() < deadline && coord.exists()) {
    await sleep(3000);
    const size = fs.existsSync(transcript) ? fs.statSync(transcript).size : 0;
    quiet = size === lastSize ? quiet + 1 : 0;
    lastSize = size;
    if (quiet >= 3 && analyse(transcript, run.project).idle) return;
  }
}

// ---- derived cases (B08) and re-evaluation ----------------------------------------------------------------------------

function evidenceFor(result) {
  for (const file of [result.evidenceFile, path.join(ARCHIVE, result.id, 'run', 'artifacts', 'evidence.json')]) {
    if (file && fs.existsSync(file)) return readJson(file);
  }
  return null;
}

export function deriveRuns(caseDef, label) {
  const dir = path.join(RESULTS, label);
  if (!fs.existsSync(dir)) return [];
  const done = new Set(fs.readdirSync(dir).filter((f) => f.startsWith(`${caseDef.id}-r`)).map((f) => readJson(path.join(dir, f))?.source).filter(Boolean));
  const out = [];
  for (const from of caseDef.derived.from) {
    for (const f of fs.readdirSync(dir).filter((x) => new RegExp(`^${from}-r\\d+\\.json$`).test(x)).sort()) {
      const source = readJson(path.join(dir, f));
      if (!source || done.has(source.id) || source.verdict === 'error') continue;
      const ev = evidenceFor(source);
      if (!ev) continue;
      const n = nextRunNumber(caseDef.id, label);
      const result = evaluate(caseDef, ev);
      const out1 = { case: caseDef.id, title: caseDef.title, label, run: n, id: `${caseDef.id}-${label}-r${n}`, source: source.id, startedAt: isoNow(), elapsedMs: result.judge?.ms ?? 0, ...result, cost: { judgeUsd: result.judge?.costUsd ?? null } };
      writeJson(path.join(dir, `${caseDef.id}-r${n}.json`), out1);
      log(null, `${out1.id} (from ${source.id}): ${out1.verdict.toUpperCase()}${result.judge ? `, judge ${result.judge.score}` : ''}`);
      out.push(out1);
    }
  }
  return out;
}

export function reevaluate(cases, ids) {
  for (const id of ids) {
    const m = /^(.+?)-(.+)-r(\d+)$/.exec(id);
    if (!m) throw new Error(`not a run id: ${id}`);
    const caseDef = cases.find((c) => c.id === m[1]);
    const file = path.join(RESULTS, m[2], `${m[1]}-r${m[3]}.json`);
    const before = readJson(file);
    if (!caseDef || !before) throw new Error(`no result for ${id}`);
    const ev = before.source ? evidenceFor(readJson(path.join(RESULTS, m[2], `${before.source.replace(/^(.+?)-.+-(r\d+)$/, '$1-$2')}.json`))) : evidenceFor(before);
    if (!ev) throw new Error(`no evidence for ${id}`);
    const result = evaluate(caseDef, ev);
    const after = { ...before, ...result, reevaluatedAt: isoNow(), previous: { verdict: before.verdict, checks: before.checks, judge: before.judge } };
    writeJson(file, after);
    log(null, `${id}: ${before.verdict} -> ${after.verdict}`);
  }
}

// ---- RESULTS.md ---------------------------------------------------------------------------------------------------------

export function writeResultsMd(cases) {
  const labels = fs.existsSync(RESULTS) ? fs.readdirSync(RESULTS).filter((d) => fs.statSync(path.join(RESULTS, d)).isDirectory()).sort() : [];
  const results = Object.fromEntries(labels.map((l) => [l, fs.readdirSync(path.join(RESULTS, l)).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(RESULTS, l, f))).filter(Boolean)]));
  const lines = [
    '# Behaviour eval results',
    '',
    'Generated by `node behaviour/run.mjs --report` from `behaviour/results/<label>/*.json`. A case is green at 3/3 runs when it has only',
    'deterministic checks and at 2/3 when it has a judge (R01: 2 runs). "error" is a run that could not be carried out (it does not count',
    'as a pass or a fail). Times are UTC.',
    '',
    `| Case | ${labels.map((l) => `${l} pass/runs`).join(' | ')} | Notes |`,
    `|---|${labels.map(() => '---').join('|')}|---|`,
  ];
  for (const c of cases) {
    const cells = labels.map((l) => {
      const rs = results[l].filter((r) => r.case === c.id);
      const counted = rs.filter((r) => r.verdict !== 'error');
      const errors = rs.length - counted.length;
      return rs.length ? `${counted.filter((r) => r.verdict === 'pass').length}/${counted.length}${errors ? ` (+${errors} error)` : ''}` : '-';
    });
    lines.push(`| ${c.id} ${c.title} | ${cells.join(' | ')} | ${c.judge ? `judge >= ${c.judge.threshold}` : 'deterministic'} |`);
  }
  const notesFile = path.join(BEHAVIOUR, 'results', 'NOTES.md');
  if (fs.existsSync(notesFile)) lines.push('', fs.readFileSync(notesFile, 'utf8').trim());
  for (const l of labels) {
    lines.push('', `## ${l}`, '');
    for (const r of results[l].sort((a, b) => a.case.localeCompare(b.case) || a.run - b.run)) {
      const judged = r.judge ? `; judge ${r.judge.score} (>= ${r.judge.threshold})${r.judge.reasons?.[0] ? `: ${r.judge.reasons[0]}` : ''}` : '';
      const cost = r.cost?.workersUsd != null ? `; workers $${r.cost.workersUsd}` : '';
      lines.push(`- ${r.id}: **${r.verdict}**${r.source ? ` (from ${r.source})` : ''}, ${Math.round((r.elapsedMs ?? 0) / 60000)} min${cost}; stop: ${r.stop?.reason ?? '-'}${judged}`);
      for (const c of r.checks ?? []) lines.push(`  - ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
      if (r.previous) lines.push(`  - re-evaluated ${r.reevaluatedAt}: was ${r.previous.verdict}`);
    }
  }
  fs.writeFileSync(path.join(BEHAVIOUR, 'RESULTS.md'), `${lines.join('\n')}\n`);
}

// ---- main ---------------------------------------------------------------------------------------------------------------

async function pool(jobs, size) {
  const out = [];
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, size) }, async (_, lane) => {
    if (lane) await sleep(lane * 20_000);
    while (next < jobs.length) {
      const job = jobs[next++];
      out.push(await job());
    }
  });
  await Promise.all(lanes);
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: { case: { type: 'string' }, runs: { type: 'string' }, plugin: { type: 'string' }, version: { type: 'string' }, parallel: { type: 'string' }, evaluate: { type: 'string' }, report: { type: 'boolean' } },
  });
  const cases = await loadCases();
  if (values.report) return writeResultsMd(cases);
  if (values.evaluate) {
    reevaluate(cases, values.evaluate.split(','));
    return writeResultsMd(cases);
  }
  const ref = values.plugin ?? 'working';
  const plugin = pluginDir(ref);
  const label = values.version ?? (ref === 'working' ? readJson(path.join(REPO, 'package.json')).version : ref.replace(/^v/, ''));
  const wanted = values.case ? values.case.split(',') : cases.map((c) => c.id);
  const chosen = cases.filter((c) => wanted.includes(c.id));
  const missing = wanted.filter((w) => !cases.some((c) => c.id === w));
  if (missing.length) throw new Error(`no such case: ${missing.join(', ')}`);
  fs.mkdirSync(EVALS_HOME, { recursive: true });
  const jobs = [];
  const reserved = {};
  for (const c of chosen.filter((x) => !x.derived)) {
    const runs = Number(values.runs ?? c.defaultRuns ?? 3);
    for (let i = 0; i < runs; i += 1) {
      reserved[c.id] = reserved[c.id] ?? nextRunNumber(c.id, label);
      const n = reserved[c.id]++;
      jobs.push(() => runOnce(c, { label, n, plugin }));
    }
  }
  log(null, `${jobs.length} run(s) of ${chosen.map((c) => c.id).join(', ')} on ${label} (${plugin}), ${values.parallel ?? 3} at a time`);
  await pool(jobs, Number(values.parallel ?? 3));
  for (const c of chosen.filter((x) => x.derived)) deriveRuns(c, label);
  writeResultsMd(cases);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
