#!/usr/bin/env node
// The guarded landing (brief 5.5), ported from the skills repo's land.ts and land-git.ts (themselves ported from
// Jevellan's packages/projects/src/landing.ts and packages/decisions/src/landing-route.ts), with the decisions written
// to the ledger instead of a table:
//
//   land.mjs --task T [--force] [--json]
//
// 1. Refuse (exit 2) unless every step of the task has a step.done since its latest start or was skipped in the
//    task.workflow line (a single task's step 1 likewise), and when the worktree has uncommitted changes (the reason
//    names them; .jevellan/, plan.md and the .claude link never count).
// 2. One landing per project at a time: .jevellan/locks/landing.lock, created with O_EXCL and holding the pid. A lock
//    whose holder is gone is taken over; a live one is waited for up to 60 minutes (the skills run's D-044). The
//    ledger is read again once the lock is held, so two landings that waited for each other see each other's lines.
// 3. The landing state (ported LandingRouteStateSchema, with the skills run's D-047 additions): the project's name and
//    guidance, the task's title, kind and text, the last summary of each step, riskyAreas (project.json riskyPaths),
//    the changed files with additions and deletions from `git diff --numstat <target>...<branch>` and a risky flag,
//    their totals, the checks already run (the steps' testsRun), the corrections (step.retrying reasons) and the
//    policy's "## rules". Above 60 000 characters the file list is cut first (risky files are always kept), then the
//    summaries, then the task text.
// 4. Jev answers one question, landing_route (choice): the instructions are this skill's "## landing_route" section,
//    the criteria its "## routes" lines. Highest probability wins, a tie goes to Jev's own choice, and the reason is the
//    chosen route's criterion. The exchange is written to .jevellan/decisions/<T>-landing-<time>.json and the ledger
//    gets landing.decided {route, probabilities, reason, policyHash, source "jev", jevModel, latencyMs, decisionFile}.
//    A Jev failure is exit 2 "Jev: <message>" and nothing is written: there is no fallback route (D-043).
// 5. Routes:
//    - land: the target branch is merged into the task branch in the worktree with --no-ff (a branch with nothing of
//      its own fast-forwards instead, so an empty merge commit never lands, D-045); a conflict aborts the merge and
//      becomes ask-owner with the reason "merge conflict in <files>". Then project.json checks run one by one with
//      `sh -c` in the worktree, each in its own process group with a timeout (30 minutes by default) and only PATH,
//      HOME (the owner's), USER, LANG, TERM, SHELL, TMPDIR, the git identity and PLAYWRIGHT_BROWSERS_PATH in its
//      environment: nothing from providers or Jev. Each check appends landing.checked {command, passed, tail}; a
//      failure (or a check that moved HEAD) is exit 2 with the tail. Then the target moves by fast-forward only:
//      where it is checked out (the main checkout for the default branch) the files the task touches must be clean
//      there and not ignored there, and `git merge --ff-only --no-overwrite-ignore` updates that working tree; where
//      it is not checked out, `git push --no-recurse-submodules .` moves the ref alone. When the target moved
//      meanwhile, merge, checks and fast-forward repeat, up to 3 rounds. Then
//      task.landed {commit, target, method}, and a push to origin only when project.json pushAfterLanding is true.
//    - verify-then-land: prints {"route":"verify-then-land"} and exits 6. The coordinator runs one more verify step;
//      the next call that finds that landing.decided still open (no landing.checked, task.asked or task.landed after
//      it) and a step.done of a verify step started after it lands without asking Jev again (D-046). Called again
//      before that verify step started, it exits 6 again, also without Jev.
//    - ask-owner: task.asked {question "Land <title>? <reason>", options ["Land now", "Leave it"], reason}, exit 7.
// 6. --force is the owner's "Land now": no Jev call; landing.decided {route land, source owner, reason "the owner
//    said Land now"} and the land route. The step and clean-tree checks still apply. A merge conflict under --force is
//    exit 2 telling the coordinator to run one implement step that merges the target and resolves it, and then to
//    land again with --force (the skills run's D-076, kept simple: a script never starts a step itself).
// 7. A child task (created with --parent) lands into its parent's branch, fast-forwarded in the parent's worktree,
//    never onto the default branch, and is never pushed (D-048). It is refused while the parent is gone, stopped or
//    landed, or has no registered worktree.
// 8. Landing by pull request (project.json "landing": "pr", H-041), for a task without a parent. The local default
//    branch is never read, moved or pushed: everything compares with origin/<defaultBranch>. In order: the pull
//    requests of the task branch are looked up with `gh pr list --state all` (one merged on GitHub is recorded as
//    task.landed and the call ends; one closed without merging refuses); `git fetch origin` (a failure refuses); a
//    branch with no commits beyond origin/<defaultBranch> refuses; then the decision as above (--force, the
//    verify-then-land continuation or Jev, the changed files taken against origin/<defaultBranch>). The land route
//    merges origin/<defaultBranch> into the task branch (merge, not rebase, so the branch on origin only ever moves
//    forward), runs the checks once (no rounds: nothing here races a moving target), pushes the task branch to origin
//    without force (a branch named like the default branch refuses), and opens a pull request with `gh pr create
//    --base <defaultBranch> --head <branch> --body-file -`, or updates the body of the open one and marks a draft
//    ready; then task.landed {pr, commit, target, method "pr"}. ask-owner is the same up to the pull request, which is
//    opened as a draft, and then task.asked with the pull request; "Land now" (--force) marks it ready and records
//    task.landed, "Leave it" archives the worktree and leaves the draft open on GitHub for the owner. A merge conflict
//    is ask-owner too: the branch is pushed as it is, the draft says that the merge conflicts and the checks did not
//    run, and --force then asks for the implement step that resolves it, as in 6. The title is the task's title; the
//    body holds the done steps' final summaries, the checks and their results, the tests the steps ran and the
//    evidence (screenshot captions and the files under the worktree's .jevellan/evidence/), masked by the redactor,
//    with no attribution of any kind. gh runs with --repo <owner/repo> from origin's URL, the owner's HOME, PATH and
//    prompts off; JH_GH_BIN replaces it in tests. Nothing here merges a pull request or deploys.
//
// Other skills are reached only through their public scripts, found by role: the ledger skill's ledger.mjs for every
// read (show --json) and line (record), through lib/ledger-client.mjs, and the placement skill's `jev.mjs decide --json`
// for Jev's answer (state and questions on stdin; the Jev key, providers.json and the client stay that skill's). Only
// the Jev path needs the placement skill: --force and the verify-then-land continuation land without it. A missing
// role is exit 2 naming it. The policy parser, the project's paths, ids, locks and the redactor are this skill's own
// copies in lib/.
//
// Exit codes: 0 landed (or landed before), 2 refused with the reason, 3 not found, 6 verify-then-land, 7 ask-owner.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runRole } from './lib/roles.mjs';
import { loadPolicy, parseIdLines, requireSection } from './lib/policy.mjs';
import { ownerHome, projectPaths } from './lib/project.mjs';
import { compactTime } from './lib/ids.mjs';
import { acquire } from './lib/lock.mjs';
import { redactText, redactValue } from './lib/redact.mjs';
import { appendLine } from './lib/ledger-client.mjs';
import {
  GitSkillError,
  SKILL_DIR,
  currentBranch,
  defaultBranch,
  fetchOrigin,
  findWorktree,
  firstLine,
  git,
  gitEnv,
  gitIdentity,
  identityEnv,
  isAncestor,
  isMain,
  landingMode,
  lastOfKind,
  lastWorktree,
  listText,
  listWorktrees,
  parse,
  present,
  print,
  projectName,
  readProjectConfig,
  readTaskOr,
  remotes,
  requireRoot,
  requireTask,
  resolveRef,
  runCli,
  runSetup,
  statusEntries,
  uncommittedFiles,
  warn,
} from './worktree.mjs';
import { ghClient, ghEnvironment, githubRepo, runGh } from './lib/gh.mjs';
import { globPattern, pathMatches, scopeBlock, scopeCheck } from './lib/scope.mjs';
import { checkOverlap, recordOverlap } from './overlap.mjs';

export { ghEnvironment, githubRepo, pathMatches, globPattern };

export const POLICY_FILE = path.join(SKILL_DIR, 'SKILL.md');
export const LANDING_QUESTION = 'landing_route';
export const ROUTES = Object.freeze(['land', 'verify-then-land', 'ask-owner']);
export const OPTIONS = Object.freeze(['Land now', 'Leave it']);
export const OWNER_REASON = 'the owner said Land now';
export const VERIFY_BEFORE_LANDING =
  'Full verification before landing: run the whole test command and every browser journey the change could affect.';
export const STATE_LIMIT = 60000;
export const TASK_SHORTENED = '[Task shortened.]';
/** What a landing state over STATE_LIMIT is refused with (the Jev client's own words for it). */
export const STATE_TOO_LARGE = 'Jev: decision context exceeds the size limit';
/** What an answer without a usable landing_route is refused with. */
export const INVALID_RESPONSE = 'Jev: invalid response';
/** Default timeout of one landing check (Jevellan's TEST_TIMEOUT_MS). */
export const CHECK_TIMEOUT_MS = 30 * 60000;
/** Characters of a check's output kept in landing.checked. */
export const TAIL_CHARS = 4000;
/** Rounds of merge, checks and fast-forward when the target keeps moving. */
export const MAX_ROUNDS = 3;
/** How long a landing waits for another landing of the same project. */
export const LOCK_WAIT_MS = 60 * 60000;
// A live holder older than this can only be a reused pid; a landing never holds the lock this long.
const LOCK_STALE_MS = 24 * 60 * 60000;
// Landing events after which a landing.decided no longer waits for anything.
const CLOSING_KINDS = Object.freeze(['landing.checked', 'task.asked', 'task.landed']);
const CHECK_ENV_KEYS = Object.freeze(['PATH', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR']);

// ---- the landing policy --------------------------------------------------------------------------------------

// This skill's SKILL.md as the landing policy: the question's instructions, one criterion per route, the rules.
// Refuses (exit 2) when a section is missing or "## routes" does not hold exactly the three routes. Only those three
// sections reach Jev; every other section (the "## Interface" at the end included) is for people.
export function landingPolicy(file = POLICY_FILE) {
  const policy = loadPolicy(file);
  const instructions = requireSection(policy, LANDING_QUESTION);
  const where = `${file}, "## routes"`;
  const routes = parseIdLines(requireSection(policy, 'routes'), where);
  const unknown = [...routes.keys()].filter((r) => !ROUTES.includes(r));
  const missing = ROUTES.filter((r) => !routes.has(r));
  if (unknown.length || missing.length) {
    throw new GitSkillError(
      `${where} must have exactly the lines ${ROUTES.join(', ')}${missing.length ? `; missing ${missing.join(', ')}` : ''}${unknown.length ? `; unknown ${unknown.join(', ')}` : ''}`,
    );
  }
  const rules = requireSection(policy, 'rules');
  return { policy, instructions, routes, rules };
}

export function landingQuestions(lp) {
  return {
    [LANDING_QUESTION]: { type: 'choice', instructions: lp.instructions, criteria: Object.fromEntries(ROUTES.map((r) => [r, lp.routes.get(r)])) },
  };
}

// Ported resolveChoice: the highest probability wins; a tie goes to Jev's own choice. An answer whose probabilities
// are all zero keeps Jev's choice as it is (none, for no answer), which the caller refuses when it is not a route.
export function resolveChoice(question, answer) {
  const keys = Object.keys(question.criteria);
  const p = (key) => answer?.probabilities?.[key] ?? 0;
  const max = Math.max(...keys.map(p));
  const option = p(answer?.choice) === max ? answer?.choice : keys.find((key) => p(key) === max);
  return { option, probabilities: Object.fromEntries(keys.map((key) => [key, p(key)])) };
}

// ---- project settings ----------------------------------------------------------------------------------------

// The project.json fields landing reads, validated: riskyPaths, checks (commands, or {name, command, timeoutMs};
// an empty list means [testCommand]; nothing at all means no checks), pushAfterLanding, guidance, and landing ("local",
// the default, or "pr"; pushAfterLanding true with "pr" refuses).
export function landingSettings(config, file = 'project.json') {
  const bad = (message) => {
    throw new GitSkillError(`${file}: ${message}`);
  };
  const riskyPaths = config.riskyPaths ?? [];
  if (!Array.isArray(riskyPaths) || !riskyPaths.every((p) => typeof p === 'string' && p.trim())) bad('riskyPaths must be a list of paths');
  const testCommand = config.testCommand ?? null;
  if (testCommand !== null && typeof testCommand !== 'string') bad('testCommand must be a command or null');
  const raw = config.checks ?? [];
  if (!Array.isArray(raw)) bad('checks must be a list');
  const checks = raw.map((c, i) => {
    if (typeof c === 'string') {
      if (!c.trim()) bad(`checks[${i}] is empty`);
      return { name: cut(c.trim(), 80), command: c, timeoutMs: CHECK_TIMEOUT_MS };
    }
    if (!c || typeof c !== 'object' || Array.isArray(c)) bad(`checks[${i}] must be a command or {name, command, timeoutMs}`);
    const extra = Object.keys(c).find((k) => !['name', 'command', 'timeoutMs'].includes(k));
    if (extra !== undefined) bad(`checks[${i}] has an unknown key "${extra}"`);
    if (typeof c.command !== 'string' || !c.command.trim()) bad(`checks[${i}].command is required`);
    if (c.name !== undefined && (typeof c.name !== 'string' || !c.name.trim())) bad(`checks[${i}].name must be a text`);
    if (c.timeoutMs !== undefined && !(Number.isSafeInteger(c.timeoutMs) && c.timeoutMs > 0)) bad(`checks[${i}].timeoutMs must be a positive integer`);
    return { name: cut((c.name ?? c.command).trim(), 80), command: c.command, timeoutMs: c.timeoutMs ?? CHECK_TIMEOUT_MS };
  });
  const effective = checks.length
    ? checks
    : testCommand && testCommand.trim()
      ? [{ name: cut(testCommand.trim(), 80), command: testCommand, timeoutMs: CHECK_TIMEOUT_MS }]
      : [];
  const push = config.pushAfterLanding;
  if (push !== undefined && typeof push !== 'boolean') bad('pushAfterLanding must be true or false');
  const guidance = config.guidance ?? '';
  if (typeof guidance !== 'string') bad('guidance must be a text');
  const landing = landingMode(config, file);
  if (landing === 'pr' && push === true) bad('pushAfterLanding pushes the default branch, which "landing": "pr" never does; set it to false');
  return { riskyPaths: riskyPaths.map((p) => p.trim()), checks: effective, pushAfterLanding: push === true, guidance, landing };
}

// ---- the landing state ---------------------------------------------------------------------------------------

export function cut(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

function oneLine(text, max) {
  return cut(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
}

// Parses `git diff --numstat --no-renames -z`: "<add>\t<del>\t<path>\0" per file, "-" for a binary file's counts.
export function parseNumstat(output) {
  const out = [];
  for (const row of output.split('\0')) {
    if (row === '') continue;
    const [a, d, ...name] = row.split('\t');
    const file = name.join('\t');
    if (file === '') continue;
    out.push({ path: file, additions: Number(a) || 0, deletions: Number(d) || 0 });
  }
  return out;
}

// The files the branch changed since it left `base`: `git diff --numstat <base>...<head>`, with their size at head.
export function changedFiles(cwd, base, head) {
  const rows = parseNumstat(git(cwd, ['diff', '--numstat', '--no-renames', '-z', `${base}...${head}`]).stdout);
  const sizes = new Map();
  if (rows.length) {
    const wanted = new Set(rows.map((r) => r.path));
    for (const entry of git(cwd, ['ls-tree', '-r', '-l', '-z', head]).stdout.split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0 || !wanted.has(entry.slice(tab + 1))) continue;
      const size = Number(entry.slice(0, tab).trim().split(/\s+/)[3]);
      sizes.set(entry.slice(tab + 1), Number.isFinite(size) ? size : 0);
    }
  }
  return rows.map((r) => ({ path: r.path, bytes: sizes.get(r.path) ?? 0, additions: r.additions, deletions: r.deletions }));
}

// What the ledger says about the task's steps for the state: each step's duty and state, its last summary since it
// last started (or was reset), its latest testsRun, and the step.retrying reasons. `info` is the task as
// ledger-client's readTask gives it: the projection's steps, view(ordinal) since the step's last reset, the events.
export function landingFacts(info) {
  const steps = info.steps.map((s) => {
    const sv = info.view(s.ordinal);
    const reset = sv.resetSeq ?? 0;
    const reports = info.events.filter((e) => e.kind === 'step.report' && e.step === s.ordinal && e.seq > reset);
    const tested = [...reports].reverse().find((e) => e.data?.testsRun && typeof e.data.testsRun.passed === 'boolean');
    return {
      ordinal: s.ordinal,
      duty: s.duty ?? sv.started?.data?.duty ?? 'step',
      state: s.state,
      summary: sv.lastReport?.data?.summary ?? null,
      tested: tested ? { ...tested.data.testsRun, at: tested.t } : null,
      screenshots: Array.isArray(sv.lastReport?.data?.screenshots) ? sv.lastReport.data.screenshots.filter((x) => x && typeof x.path === 'string') : [],
    };
  });
  const dutyOf = (ordinal) => steps.find((s) => s.ordinal === ordinal)?.duty ?? `step ${ordinal}`;
  const corrections = info.events
    .filter((e) => e.kind === 'step.retrying')
    .map((e) => `${dutyOf(e.step ?? e.data?.ordinal)} failed (attempt ${e.data?.attempt ?? '?'}): ${e.data?.reason ?? ''}`);
  return { steps, corrections };
}

// The landing state as an object and as JSON within STATE_LIMIT. `redact` masks secrets before the size is measured.
export function buildLandingState({ project, task, steps, corrections, files, riskyPaths, rules, redact = (v) => v }) {
  const summaries = [];
  const checks = [];
  for (const step of steps) {
    if (step.state !== 'done') continue;
    if (step.summary) summaries.push({ duty: step.duty, summary: cut(step.summary, 4000) });
    if (step.tested) {
      checks.push({ duty: step.duty, command: cut(step.tested.command, 2000), passed: step.tested.passed, summary: cut(step.tested.summary, 600), at: step.tested.at });
    }
  }
  const isRisky = (f) => riskyPaths.some((p) => pathMatches(f.path, p));
  const sorted = [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path));
  const totals = {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    filesOmitted: 0,
  };
  const rows = (n) => sorted.slice(0, n).map((f) => ({ ...f, risky: isRisky(f) }));
  let state = redact({
    schema: 'landing-route-state-v1',
    project: { name: project.name, guidance: project.guidance ?? '' },
    title: task.title,
    task: { id: task.id, kind: task.kind, text: task.text },
    summaries,
    riskyAreas: [...riskyPaths],
    files: rows(3000),
    totals: { ...totals, filesOmitted: Math.max(0, sorted.length - 3000) },
    checks: checks.slice(-31),
    corrections: corrections.slice(-8).map((c) => oneLine(c, 500)),
    rules,
  });
  const size = () => JSON.stringify(state).length;
  // Risky files are never the ones left out.
  const risky = sorted.filter(isRisky);
  for (const n of [500, 100, 20]) {
    if (size() <= STATE_LIMIT) break;
    const kept = rows(n);
    const extra = risky.filter((f) => !kept.some((k) => k.path === f.path)).slice(0, 200).map((f) => ({ ...f, risky: true }));
    const list = redact([...kept, ...extra]);
    state = { ...state, files: list, totals: { ...totals, filesOmitted: sorted.length - list.length } };
  }
  if (size() > STATE_LIMIT) state = { ...state, summaries: state.summaries.map((s) => ({ ...s, summary: cut(s.summary, 1000) })) };
  if (size() > STATE_LIMIT) {
    const over = size() - STATE_LIMIT;
    const text = state.task.text;
    const keep = Math.max(0, text.length - over - TASK_SHORTENED.length - 2);
    state = { ...state, task: { ...state.task, text: `${text.slice(0, keep)}\n${TASK_SHORTENED}` } };
  }
  return { state, json: JSON.stringify(state) };
}

// ---- checks --------------------------------------------------------------------------------------------------

const runningChecks = new Set();

// The environment of a landing check: the base keys, the owner's own HOME (the project's tools keep their caches
// there), the git identity and Playwright's browsers. No provider login, no Jev key, nothing else.
export function checkEnvironment(ownerHome, identity, base = process.env) {
  const env = {};
  for (const key of CHECK_ENV_KEYS) if (base[key]) env[key] = base[key];
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  env.HOME = ownerHome;
  Object.assign(env, identityEnv(identity));
  const browsers = path.join(ownerHome, '.cache', 'ms-playwright');
  if (fs.existsSync(browsers)) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  return env;
}

function killGroup(child, signal) {
  try {
    if (child?.pid) process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

// Runs one check with `sh -c` in its own process group. On timeout the group gets SIGTERM, then SIGKILL after 5 s;
// when the shell exits, whatever it left running in its group is ended too, so a check never outlives the landing.
export function runCheck(cwd, check, env) {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killTimer = null;
    let drainTimer = null;
    let child = null;
    let exitCode = null;
    let exitSignal = null;
    const suffix = () => (timedOut ? `\n[timed out after ${check.timeoutMs} ms]` : exitSignal ? `\n[ended by ${exitSignal}]` : '');
    const keep = (chunk) => {
      out += chunk.toString('utf8');
      if (out.length > TAIL_CHARS * 4) out = out.slice(-TAIL_CHARS * 2);
    };
    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      runningChecks.delete(child);
      resolve({
        name: check.name,
        command: check.command,
        passed: code === 0 && !timedOut,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        tail: (out + extra).slice(-TAIL_CHARS),
      });
    };
    try {
      child = spawn('sh', ['-c', check.command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(null, `could not start: ${error.message}`);
      return;
    }
    runningChecks.add(child);
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 5000);
    }, check.timeoutMs);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => finish(null, `\n${error.message}`));
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      killGroup(child, 'SIGTERM');
      // Output still in the pipes arrives before 'close'; a grandchild that ignores SIGTERM cannot hold it forever.
      drainTimer = setTimeout(() => finish(exitCode, suffix()), 5000);
    });
    child.on('close', () => finish(exitCode, suffix()));
  });
}

// ---- git steps of the land route -----------------------------------------------------------------------------

function conflictedFiles(cwd) {
  return git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']).stdout.split('\0').filter(Boolean).slice(0, 200);
}

// Merges the target into the branch checked out in `worktree`. A conflict is aborted, so the worktree is left as it
// was, and the conflicted files are returned. `ref` and `name` merge another ref (origin/<branch> for landing by pull
// request) under that name.
export function mergeInto(worktree, into, branch, env, { ref = `refs/heads/${into}`, name = into } = {}) {
  const target = resolveRef(worktree, ref);
  if (!target) throw new GitSkillError(`the branch ${name} to land into does not exist`);
  const head = resolveRef(worktree, 'HEAD');
  if (isAncestor(worktree, target, head)) return { kind: 'up-to-date', head };
  // A branch with nothing of its own catches up without a merge commit, so an empty merge never lands.
  if (isAncestor(worktree, head, target)) {
    git(worktree, ['merge', '--ff-only', '--no-edit', target], { env });
    return { kind: 'fast-forward', head: target };
  }
  const r = git(worktree, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${name} into ${branch}`, target], { permitted: [0, 1, 2, 128], env });
  if (r.code === 0) return { kind: 'merged', head: resolveRef(worktree, 'HEAD') };
  const files = conflictedFiles(worktree);
  git(worktree, ['merge', '--abort'], { permitted: [0, 1, 128], env });
  if (!files.length) throw new GitSkillError(`git merge ${name} failed in ${worktree}: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}`);
  return { kind: 'conflict', files };
}

// The files git names under a "would be overwritten" or "would lose untracked files" refusal: its tab-indented lines.
export function refusedFiles(stderr) {
  return [...new Set(String(stderr ?? '').split('\n').filter((l) => l.startsWith('\t')).map((l) => l.trim()).filter(Boolean))];
}

// Moves the target to `branch` by fast-forward only. Where the target is checked out, the files the task touches must
// be clean there, and not ignored files either (the owner's build output, logs or local settings, which a plain
// `merge --ff-only` overwrites, or deletes to make room for a folder, without a word); `merge --ff-only
// --no-overwrite-ignore` then updates that working tree, and refuses whatever the check could not see (an ignored file
// where the task needs a folder), naming it. Elsewhere `push --no-recurse-submodules .` moves the ref and no working
// tree changes; without that flag, push.recurseSubmodules or submodule.recurse would make it push the submodules'
// commits to their remotes, and only pushAfterLanding may push anything. Returns {kind: landed | moved | refused}.
export function fastForward(root, into, branch, env) {
  const head = resolveRef(root, `refs/heads/${branch}`);
  if (!head) return { kind: 'refused', reason: `the branch ${branch} does not exist` };
  const current = resolveRef(root, `refs/heads/${into}`);
  if (!current) return { kind: 'refused', reason: `the branch ${into} to land into does not exist` };
  if (current === head) return { kind: 'landed', commit: head, method: 'up-to-date' };
  if (!isAncestor(root, current, head)) return { kind: 'moved' };
  const moved = () => {
    const now = resolveRef(root, `refs/heads/${into}`);
    return Boolean(now && now !== current);
  };
  const holder = listWorktrees(root).find((e) => e.branch === `refs/heads/${into}` && !e.bare && !e.prunable);
  if (holder) {
    const touched = git(root, ['diff', '--name-only', '--no-renames', '-z', current, head]).stdout.split('\0').filter(Boolean);
    const found = statusEntries(holder.path, touched, { ignored: true });
    const dirty = found.filter((e) => e.code !== '!!').map((e) => e.path);
    const ignored = found.filter((e) => e.code === '!!').map((e) => e.path);
    if (dirty.length || ignored.length) {
      const what = [
        ...(dirty.length ? [`uncommitted changes in files the task changes: ${listText(dirty)}`] : []),
        ...(ignored.length ? [`ignored files the task would overwrite: ${listText(ignored)}`] : []),
      ].join(', and ');
      return { kind: 'refused', reason: `${holder.path} has ${into} checked out with ${what}. Commit or move them away, then land again` };
    }
    const r = git(holder.path, ['merge', '--ff-only', '--no-overwrite-ignore', '--no-edit', head], { permitted: [0, 1, 128], env });
    if (r.code !== 0) {
      if (moved()) return { kind: 'moved' };
      const files = refusedFiles(r.stderr);
      if (files.length) {
        return { kind: 'refused', reason: `git merge --ff-only in ${holder.path} would overwrite or remove files there that are not committed: ${listText(files)}. Commit or move them away, then land again` };
      }
      return { kind: 'refused', reason: `git merge --ff-only in ${holder.path} failed: ${firstLine(r.stderr) || firstLine(r.stdout)}` };
    }
    return { kind: 'landed', commit: head, method: 'merge --ff-only', checkout: holder.path };
  }
  const r = git(root, ['push', '--quiet', '--no-recurse-submodules', '.', `refs/heads/${branch}:refs/heads/${into}`], { permitted: [0, 1, 128], env });
  if (r.code !== 0) {
    // A concurrent update of the target shows as a rejected non-fast-forward.
    if (moved()) return { kind: 'moved' };
    return { kind: 'refused', reason: `git push . ${branch}:${into} in ${root} failed: ${firstLine(r.stderr) || firstLine(r.stdout)}` };
  }
  return { kind: 'landed', commit: head, method: 'push .' };
}

// project.json pushAfterLanding: the target to origin, never forced, with the owner's HOME (credentials).
function pushTarget(root, into, env) {
  if (!remotes(root).includes('origin')) return { pushed: false, detail: 'pushAfterLanding is set but the repository has no origin' };
  const r = git(root, ['push', '--quiet', 'origin', `refs/heads/${into}:refs/heads/${into}`], { permitted: [0, 1, 128], env, timeoutMs: 120000 });
  return r.code === 0 ? { pushed: true, detail: `pushed ${into} to origin` } : { pushed: false, detail: `push to origin failed: ${firstLine(r.stderr) || firstLine(r.stdout)}` };
}

// The instructions of the implement step a forced landing needs when merging the target conflicts (ported
// resolveConflictInstructions).
export function resolveConflictInstructions(into, branch, files, { pr = false } = {}) {
  const after = pr
    ? `Never touch the default branch and push nothing: landing pushes ${branch} and updates its pull request after you report done.`
    : `Never touch ${into} itself: landing moves it after you report done.`;
  return (
    `Landing this task on ${into} needs a merge first: merging ${into} into ${branch} conflicts in ${files.join(', ')}. ` +
    `The owner said "Land now". Run git merge ${into} in this worktree and resolve every conflict keeping what both sides meant ` +
    '(for a changelog or another list, keep both entries); change nothing else. Run the tests that cover the conflicted files, ' +
    `then commit the merge on ${branch}. ${after}`
  );
}

// ---- preconditions -------------------------------------------------------------------------------------------

// Where the task lands: the default branch, or the parent's branch for a child task (D-048). Refuses with the reason.
// Landing by pull request compares with origin/<into> and never needs the local branch (H-041).
function landingTarget(root, info, config, settings) {
  const task = info.created.task;
  const parentId = info.created.data?.parent;
  if (!parentId) {
    const into = defaultBranch(root, config);
    if (settings.landing === 'pr') {
      if (!remotes(root).includes('origin')) throw new GitSkillError(`project.json sets "landing": "pr", but ${root} has no remote named origin`);
      return { into, parent: null, pr: true, remoteRef: `refs/remotes/origin/${into}` };
    }
    if (!resolveRef(root, `refs/heads/${into}`)) throw new GitSkillError(`the default branch ${into} does not exist in ${root}`);
    return { into, parent: null };
  }
  const of = `task ${task} lands into its parent's branch`;
  const parent = readTaskOr(root, parentId, () => new GitSkillError(`${of}, but the parent ${parentId} is not in the ledger`));
  if (parent.events.some((e) => e.kind === 'task.landed')) throw new GitSkillError(`${of}, but the parent ${parentId} already landed; its branch takes no more work`);
  if (parent.state === 'stopped') throw new GitSkillError(`${of}, but the parent ${parentId} was stopped (${parent.reason ?? 'no reason'})`);
  const pwt = lastWorktree(parent);
  if (!pwt) throw new GitSkillError(`${of}, but the parent ${parentId} has no worktree`);
  if (!resolveRef(root, `refs/heads/${pwt.branch}`)) throw new GitSkillError(`${of}, but the parent's branch ${pwt.branch} does not exist`);
  const entry = present(pwt.path) ? findWorktree(root, pwt.path) : undefined;
  if (!entry || entry.prunable) throw new GitSkillError(`${of}, but the parent's worktree ${pwt.path} is not a registered worktree of ${root}`);
  return { into: pwt.branch, parent: { task: parentId, worktree: pwt.path } };
}

// Everything that must hold before landing, read from the ledger (the projection's state, workflowResolved, steps and
// reason) and git. Throws the first refusal.
function preconditions(root, info) {
  const task = info.created.task;
  if (info.state === 'stopped') throw new GitSkillError(`task ${task} was stopped (${info.reason ?? 'no reason'}); there is nothing to land`);
  if (!info.workflowResolved) throw new GitSkillError(`task ${task} has no workflow yet (task.workflow); its steps must run before it lands`);
  if (!info.steps.length) throw new GitSkillError(`task ${task} has no steps to land`);
  const open = info.steps.filter((s) => s.state !== 'done' && s.state !== 'skipped');
  if (open.length) {
    throw new GitSkillError(`task ${task} has steps that are not done or skipped: ${open.map((s) => `${s.ordinal} ${s.duty ?? 'step'} (${s.state})`).join(', ')}`);
  }
  const wt = lastWorktree(info);
  if (!wt) throw new GitSkillError(`task ${task} has no worktree to land`);
  if (!present(wt.path)) throw new GitSkillError(`the worktree ${wt.path} of task ${task} is gone (archived or moved)`);
  const entry = findWorktree(root, wt.path);
  if (!entry || entry.prunable) throw new GitSkillError(`${wt.path} is not a registered worktree of ${root}`);
  const branch = currentBranch(wt.path);
  if (branch !== wt.branch) throw new GitSkillError(`the worktree ${wt.path} has ${branch ?? 'a detached HEAD'} checked out, not ${wt.branch}`);
  const dirty = uncommittedFiles(wt.path);
  if (dirty.length) throw new GitSkillError(`the worktree ${wt.path} has uncommitted changes: ${listText(dirty)}. Commit or discard them first`);
  const config = readProjectConfig(root);
  const settings = landingSettings(config, projectPaths(root).projectJson);
  const target = landingTarget(root, info, config, settings);
  if (target.pr && wt.branch === target.into) {
    throw new GitSkillError(`the task branch is ${wt.branch}, the default branch itself; landing by pull request never pushes the default branch`);
  }
  return { task, wt, settings, target };
}

// ---- the landing lock ----------------------------------------------------------------------------------------

function lockHolder(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0]) || '?';
  } catch {
    return '?';
  }
}

let releaseLock = null;

function acquireLandingLock(root) {
  const file = path.join(projectPaths(root).locks, 'landing.lock');
  const options = { retryMs: 500, staleMs: LOCK_STALE_MS };
  try {
    return acquire(file, { ...options, timeoutMs: 0 });
  } catch (error) {
    if (error.code !== 'LOCK_TIMEOUT') throw error;
  }
  warn(`waiting for another landing of ${projectName(root)} (process ${lockHolder(file)}) to finish`);
  try {
    return acquire(file, { ...options, timeoutMs: LOCK_WAIT_MS });
  } catch (error) {
    if (error.code !== 'LOCK_TIMEOUT') throw error;
    throw new GitSkillError(`another landing of ${projectName(root)} (process ${lockHolder(file)}) is still running after ${LOCK_WAIT_MS / 60000} minutes; try again later`);
  }
}

// A landing interrupted by a signal ends its checks and releases the lock before it exits.
function onSignal(signal) {
  for (const child of runningChecks) killGroup(child, 'SIGTERM');
  try {
    releaseLock?.();
  } catch {}
  process.stderr.write(`landing interrupted by ${signal}; nothing more was done\n`);
  process.exit(2);
}

// ---- the routes ----------------------------------------------------------------------------------------------

// The landing lines have no guard of their own to run in the ledger (the landing lock serializes landings), so they
// are recorded as they are. Returns the line as written, secrets masked.
function append(ctx, kind, data) {
  return appendLine(ctx.root, kind, { task: ctx.task, session: process.env.JH_SESSION, data });
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Jev's answer to `questions` about `state` (JSON text), through the placement skill's public script:
// `jev.mjs decide --json` with {state, questions} on stdin prints {jevModel, answeredBy, answers, usage, latencyMs}.
// Its refusal (no key, auth, network, timeout, an invalid request or response, a JH_JEV_URL off loopback) is exit 2
// with {error: "Jev: ..."}, which becomes this script's refusal word for word. No placement skill installed is exit 2
// naming the role (RoleMissing, thrown by runRole).
export function askJev(state, questions) {
  const started = Date.now();
  const r = runRole('placement', 'jev.mjs', ['decide', '--json'], { input: { state, questions } });
  if (r.code !== 0 || !isObject(r.json) || r.json.error !== undefined) {
    // Its message as it is ("Jev: ..." for a Jev failure; providers.json's own refusals keep their words).
    const said = typeof r.json?.error === 'string' && r.json.error.trim() ? r.json.error.trim() : `Jev: ${firstLine(r.stderr) || `the placement skill's jev.mjs decide exited ${r.code}`}`;
    throw new GitSkillError(said);
  }
  const out = r.json;
  if (!isObject(out.answers)) throw new GitSkillError(INVALID_RESPONSE);
  return {
    jevModel: typeof out.jevModel === 'string' ? out.jevModel : null,
    answeredBy: typeof out.answeredBy === 'string' ? out.answeredBy : null,
    answers: out.answers,
    usage: isObject(out.usage) ? out.usage : {},
    latencyMs: Number.isSafeInteger(out.latencyMs) && out.latencyMs >= 0 ? out.latencyMs : Date.now() - started,
  };
}

async function decide(ctx) {
  const { root, info, wt, settings, target } = ctx;
  const lp = landingPolicy();
  const facts = landingFacts(info);
  const files = changedFiles(wt.path, target.remoteRef ?? `refs/heads/${target.into}`, `refs/heads/${wt.branch}`);
  const created = info.created.data ?? {};
  const { state, json } = buildLandingState({
    project: { name: projectName(root), guidance: settings.guidance },
    task: { id: ctx.task, kind: created.kind, title: created.title, text: created.text ?? '' },
    steps: facts.steps,
    corrections: facts.corrections,
    files,
    riskyPaths: settings.riskyPaths,
    rules: lp.rules,
    redact: (v) => redactValue(v),
  });
  if (json.length > STATE_LIMIT) throw new GitSkillError(STATE_TOO_LARGE);
  const questions = landingQuestions(lp);
  const response = askJev(json, questions);
  const answer = response.answers[LANDING_QUESTION];
  if (!isObject(answer)) throw new GitSkillError(INVALID_RESPONSE);
  const { option, probabilities } = resolveChoice(questions[LANDING_QUESTION], answer);
  if (!ROUTES.includes(option)) throw new GitSkillError(INVALID_RESPONSE);
  const { latencyMs } = response;
  const reason = lp.routes.get(option);
  const t = new Date().toISOString();
  const id = `${ctx.task}-landing-${compactTime(t)}`;
  const file = path.join(projectPaths(root).dir, 'decisions', `${id}.json`);
  writeJsonAtomic(file, {
    schema: 'jh-decision-v1',
    id,
    kind: 'landing',
    task: ctx.task,
    t,
    policy: { file: lp.policy.file, hash: lp.policy.hash },
    jevModel: response.jevModel,
    answeredBy: response.answeredBy,
    state,
    questions,
    answers: response.answers,
    usage: response.usage,
    latencyMs,
    chosen: { route: option, probabilities, reason, source: 'jev' },
  });
  return { route: option, probabilities, reason, policyHash: lp.policy.hash, source: 'jev', jevModel: response.jevModel, latencyMs, decisionFile: path.relative(root, file) };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// The owner decides. With a draft pull request (landing by pull request), the question names it; "Land now" marks it
// ready for review and "Leave it" leaves it open on GitHub for the owner.
function askOwner(ctx, reason, { pr = null, checks } = {}) {
  const title = ctx.info.created.data?.title ?? ctx.task;
  const question = pr ? `Land ${title}? ${reason} It waits in a draft pull request: ${pr.url}` : `Land ${title}? ${reason}`;
  append(ctx, 'task.asked', { question, options: [...OPTIONS], reason, ...(pr ? { pr: pr.url } : {}) });
  const out = { task: ctx.task, route: 'ask-owner', question, options: [...OPTIONS], reason, ...(pr ? { pr: pr.url, draft: pr.draft } : {}), ...(checks ? { checks } : {}) };
  const options = pr
    ? `Options: 1) Land now (land.mjs --task ${ctx.task} --force: checks again, then marks the pull request ready for review)  2) Leave it (worktree.mjs archive --task ${ctx.task}; the draft stays open on GitHub for the owner to close)`
    : `Options: 1) Land now (land.mjs --task ${ctx.task} --force)  2) Leave it (worktree.mjs archive --task ${ctx.task})`;
  print(ctx.json, out, `${ctx.task}: the owner decides. ${question}\n${options}`);
  return 7;
}

function verifyThenLand(ctx, reason, again) {
  const out = { route: 'verify-then-land' };
  if (ctx.json) print(true, { ...out, task: ctx.task, reason: reason ?? null, instructions: VERIFY_BEFORE_LANDING, again });
  else process.stdout.write(`${JSON.stringify(out)}\n`);
  return 6;
}

// The worktree's setupCommand when it never succeeded (a worktree made before the project had one, or interrupted), so
// the checks run against the project's dependencies rather than fail for want of them; then every check in order, each
// recorded as landing.checked. The first failure, or a check that moved HEAD away from `head`, throws (exit 2) saying
// `stopped`, what did not happen. Returns the results.
async function runLandingChecks(ctx, head, round, stopped) {
  const { root, wt, settings } = ctx;
  const owner = ownerHome();
  const checkEnv = checkEnvironment(owner, gitIdentity(root, owner));
  const results = [];
  if (settings.checks.length) {
    const setup = runSetup(root, wt.path, readProjectConfig(root));
    if (setup.ran && !setup.ok) {
      const event = append(ctx, 'landing.checked', { command: setup.command, passed: false, tail: setup.tail });
      throw new GitSkillError(`the worktree's setupCommand "${setup.command}" failed (${setup.problem}) before the checks (landing.checked #${event.seq}):\n${String(event.data.tail ?? '').trimEnd()}`);
    }
  }
  for (const check of settings.checks) {
    const result = await runCheck(wt.path, check, checkEnv);
    const now = resolveRef(wt.path, 'HEAD');
    if (result.passed && now !== head) {
      result.passed = false;
      result.tail = `${result.tail}\n[the check changed the worktree's HEAD from ${head.slice(0, 12)} to ${now?.slice(0, 12) ?? 'nothing'}]`.slice(-TAIL_CHARS);
    }
    // The ledger masks secrets in the tail; what is printed below is the line as written.
    const event = append(ctx, 'landing.checked', { command: check.command, passed: result.passed, tail: result.tail });
    results.push({ name: check.name, command: check.command, passed: result.passed, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, round });
    if (!result.passed) {
      const why = result.timedOut ? `timed out after ${check.timeoutMs} ms` : `exit ${result.exitCode ?? 'none'}`;
      const error = new GitSkillError(`check ${check.name} failed (${why}); ${stopped}. Output tail:\n${event.data.tail}`);
      // A caller may route this failure to the owner instead (a failure the task's reports put outside its scope).
      error.failed = { name: check.name, tail: String(result.tail ?? '') };
      error.results = results;
      throw error;
    }
  }
  return results;
}

// ---- what the task's reports say beyond their summaries (0.4.0) ---------------------------------------------------

// The decisions and follow-ups of the task's reports, newest report of each step first, without repeats.
export function reportExtras(info) {
  const decisions = [];
  const followUps = [];
  const seen = new Set();
  for (const e of [...info.events].reverse()) {
    if (e.kind !== 'step.report') continue;
    for (const d of Array.isArray(e.data?.decisions) ? e.data.decisions : []) {
      const key = `d:${d.choice}`;
      if (d?.choice && !seen.has(key)) {
        seen.add(key);
        decisions.push(d);
      }
    }
    for (const f of Array.isArray(e.data?.followUps) ? e.data.followUps : []) {
      const key = `f:${f.kind}:${f.title}`;
      if (f?.title && !seen.has(key)) {
        seen.add(key);
        followUps.push(f);
      }
    }
  }
  return { decisions: decisions.reverse(), followUps: followUps.reverse() };
}

// The follow-ups (a failure outside the task's scope, or a host problem) that a failed check's output shows: a test file
// or an error code they name appears in it. Null when none does: the failure is then the task's own.
export function failureOutsideScope(followUps, tail) {
  const out = String(tail ?? '');
  const hits = [];
  for (const f of followUps.filter((x) => x.kind === 'unrelated-failure' || x.kind === 'host')) {
    const text = `${f.title ?? ''} ${f.evidence ?? ''}`;
    const tokens = new Set();
    for (const m of text.matchAll(/[A-Za-z0-9_@.\/-]+\.(?:test|spec)\.[A-Za-z0-9]+/g)) {
      tokens.add(m[0]);
      tokens.add(m[0].split('/').pop());
    }
    for (const m of text.matchAll(/\bE[A-Z]{3,}\b/g)) tokens.add(m[0]);
    if ([...tokens].some((t) => t.length >= 5 && out.includes(t))) hits.push(f.title);
  }
  return hits.length ? hits.join('; ') : null;
}

// The changed files against plan.md's scope block (0.4.0): {scope, outside, tolerated, files}. No plan.md, or no scope
// block in it, is nothing to compare.
export function landingScope(wtPath, baseRef, branch) {
  const plan = path.join(wtPath, 'plan.md');
  const scope = fs.existsSync(plan) ? scopeBlock(fs.readFileSync(plan, 'utf8')) : null;
  const r = git(wtPath, ['diff', '--name-only', `${baseRef}...refs/heads/${branch}`], { permitted: [0, 128] });
  const files = r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  return { ...scopeCheck(files, scope), files };
}

// The guards that make a landing the owner's question before anything is asked of Jev (0.4.0): files outside the
// plan's scope beyond the tolerance, and, when landing by pull request, work that reached origin/<defaultBranch> or a
// pull request since the task's last overlap check and that both changes files this branch changes and shares the
// task's intent (most of its title's words): the same file changed for another reason is what a merge handles. Found
// overlap is recorded as a note. A local default branch that moved under the task is the ordinary case a merge handles. Returns {reason, source,
// scope}. When the overlap check cannot run (the ledger or git refusing), landing goes on with a warning.
function landingGuard(ctx) {
  const { root, wt, target } = ctx;
  const baseRef = target.remoteRef ?? `refs/heads/${target.into}`;
  const scope = landingScope(wt.path, baseRef, wt.branch);
  ctx.scope = scope;
  if (!scope.tolerated) {
    return { source: 'scope', reason: `${scope.outside.length} changed file(s) outside the plan's scope: ${listText(scope.outside)}`, scope };
  }
  if (!target.pr) return { reason: null, source: null, scope };
  try {
    const overlap = checkOverlap(root, ctx.task, { checkpoint: 'landing', record: false });
    const same = overlap.items.filter((i) => i.kind !== 'task' && i.textRelated && i.filesOverlap.some((f) => scope.files.includes(f)));
    if (same.length) {
      recordOverlap(root, ctx.task, { ...overlap, items: same, verdict: 'possible' });
      const names = same.map((i) => `${i.number ? `#${i.number} ` : ''}${i.commit ? `${i.commit.slice(0, 9)} ` : ''}${i.kind === 'open-pr' ? '(open) ' : ''}"${i.title}" (${listText(i.filesOverlap, 3)})`);
      return { source: 'overlap', reason: `overlap: work on the same files reached ${overlap.base} or a pull request since the task's last check: ${names.join('; ')}`, scope };
    }
  } catch (error) {
    warn(`warning: the overlap check did not run (${firstLine(error.message)}); landing goes on without it`);
  }
  return { reason: null, source: null, scope };
}

async function landRoute(ctx, { forced, reason }) {
  const { root, wt, target, settings } = ctx;
  const into = target.into;
  const branch = wt.branch;
  const owner = ownerHome();
  const identity = gitIdentity(root, owner);
  const env = gitEnv(identityEnv(identity));
  const results = [];
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const merged = mergeInto(wt.path, into, branch, env);
    if (merged.kind === 'conflict') {
      const files = listText(merged.files);
      if (forced) {
        throw new GitSkillError(
          `merging ${into} into ${branch} conflicts in ${files}; the merge was aborted and nothing moved. The owner said Land now, so the task resolves it: ` +
            `run one implement step in the task's worktree with these instructions, record its step.done, then run land.mjs --task ${ctx.task} --force again. ` +
            `Instructions: ${resolveConflictInstructions(into, branch, merged.files)}`,
        );
      }
      return askOwner(ctx, `merge conflict in ${files}`);
    }
    try {
      results.push(...(await runLandingChecks(ctx, merged.head, round, `${into} did not move`)));
    } catch (error) {
      const outside = error.failed ? failureOutsideScope(reportExtras(ctx.info).followUps, error.failed.tail) : null;
      if (!outside) throw error;
      if (!forced) {
        const why = `a check fails outside this task's scope: ${outside}`;
        append(ctx, 'landing.decided', { route: 'ask-owner', source: 'checks', reason: why });
        return askOwner(ctx, why, { checks: [...results, ...(error.results ?? [])] });
      }
      results.push(...(error.results ?? []), { name: error.failed.name, passed: false, round });
    }
    const ff = fastForward(root, into, branch, env);
    if (ff.kind === 'moved') continue;
    if (ff.kind === 'refused') throw new GitSkillError(`${ff.reason}; ${into} did not move`);
    append(ctx, 'task.landed', { commit: ff.commit, target: into, method: ff.method });
    let push = null;
    if (settings.pushAfterLanding && !target.parent) {
      push = pushTarget(root, into, gitEnv({ HOME: owner, ...identityEnv(identity) }));
      if (!push.pushed) warn(`warning: ${push.detail}`);
    }
    const onto = target.parent ? `${into} (the branch of the parent ${target.parent.task})` : into;
    const checksText = settings.checks.length ? `checks passed: ${settings.checks.map((c) => c.name).join(', ')}` : 'no checks configured';
    const out = { task: ctx.task, route: 'land', landed: true, commit: ff.commit, target: into, method: ff.method, forced, reason, checks: results, push };
    print(ctx.json, out, `Landed ${ctx.task} on ${onto} at ${ff.commit.slice(0, 12)} (${ff.method}); ${checksText}${push ? `; ${push.detail}` : ''}.`);
    return 0;
  }
  throw new GitSkillError(`${into} kept moving during ${MAX_ROUNDS} landing rounds; nothing landed. Run land.mjs again`);
}

// ---- landing by pull request (H-041) ---------------------------------------------------------------------------

/** task.landed's method when landing opened (or found) a pull request. */
export const PR_METHOD = 'pr';
/** The longest pull request body written here; GitHub refuses one over 65 536 characters. */
export const PR_BODY_LIMIT = 60000;
/** At most this many evidence files are listed in a pull request body. */
const EVIDENCE_LIMIT = 50;

// The task branch's pull request from `gh pr list`'s JSON: an open one first, else a merged one, else a closed one.
// Pull requests from forks with a branch of the same name are not the task's.
export function pickPr(list, branch) {
  const mine = (Array.isArray(list) ? list : []).filter((p) => p && typeof p === 'object' && p.headRefName === branch && p.isCrossRepository !== true);
  return mine.find((p) => p.state === 'OPEN') ?? mine.find((p) => p.state === 'MERGED') ?? mine.find((p) => p.state === 'CLOSED') ?? null;
}

function findPr(gh, cwd, branch, into) {
  const fields = 'url,number,state,isDraft,headRefName,headRefOid,isCrossRepository,mergeCommit';
  const out = runGh(gh, cwd, ['pr', 'list', '--head', branch, '--base', into, '--state', 'all', '--limit', '20', '--json', fields]);
  let list;
  try {
    list = JSON.parse(out);
  } catch {
    throw new GitSkillError(`gh pr list printed no JSON: ${firstLine(out) || '(nothing)'}`);
  }
  return pickPr(list, branch);
}

// Opens the pull request, or updates the body of the open one (its title is the owner's to change) and marks a draft
// ready when `draft` is false. A ready pull request is never turned back into a draft.
function ensurePr(gh, cwd, { existing, draft, title, body, into, branch }) {
  if (existing) {
    runGh(gh, cwd, ['pr', 'edit', String(existing.number), '--body-file', '-'], body);
    let isDraft = existing.isDraft === true;
    if (isDraft && !draft) {
      runGh(gh, cwd, ['pr', 'ready', String(existing.number)]);
      isDraft = false;
    }
    return { url: existing.url, number: existing.number ?? null, draft: isDraft, opened: false };
  }
  const out = runGh(gh, cwd, ['pr', 'create', '--base', into, '--head', branch, '--title', title, '--body-file', '-', ...(draft ? ['--draft'] : [])], body);
  const url = out.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l)).pop();
  if (!url) throw new GitSkillError(`gh pr create printed no pull request URL: ${firstLine(out) || '(nothing)'}`);
  return { url, number: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || null, draft, opened: true };
}

// Pushes the task branch to origin under its own name: never forced, never the default branch.
function pushBranch(cwd, branch, into, env) {
  if (branch === into) throw new GitSkillError(`the task branch is ${branch}, the default branch itself; landing by pull request never pushes the default branch`);
  const r = git(cwd, ['push', '--quiet', '--no-recurse-submodules', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { permitted: [0, 1, 128], env, timeoutMs: 180000 });
  if (r.code !== 0) throw new GitSkillError(`git push origin ${branch} failed: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}. No pull request was opened or changed`);
  return { pushed: true, detail: `pushed ${branch} to origin` };
}

const EVIDENCE_DIR = '.jevellan/evidence/';

// An evidence file as the body names it: its path inside the evidence folder, whatever folder the report named, so
// the body carries neither machine paths nor the harness's folder names.
function evidencePath(p) {
  const s = String(p).replace(/\\/g, '/');
  const i = s.indexOf(EVIDENCE_DIR);
  return i >= 0 ? s.slice(i + EVIDENCE_DIR.length) : path.posix.basename(s);
}

// The files under the worktree's .jevellan/evidence/, as paths inside that folder, sorted.
export function evidenceFiles(wtPath) {
  const dir = path.join(wtPath, '.jevellan', 'evidence');
  let names = [];
  try {
    names = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)).split(path.sep).join('/'));
  } catch {}
  return names.sort();
}

function inlineCode(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``;
}

function duration(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// The pull request body: the done steps' final summaries, the landing checks and their results, the tests the steps
// ran, the evidence, and for a draft why it is one. Masked by the redactor and kept under PR_BODY_LIMIT; nothing in it
// says who or what wrote it.
export function prBody({ into, steps = [], checks = [], evidence = [], draftReason = null, conflict = null, decisions = [], followUps = [], outsideScope = [], limit = PR_BODY_LIMIT }) {
  const done = steps.filter((s) => s.state === 'done');
  const build = (summaryMax) => {
    const parts = [];
    if (conflict) parts.push(`**Draft: the merge conflicts.** Merging origin/${into} into this branch conflicts in ${conflict}, so the checks did not run.${draftReason ? ` ${draftReason}` : ''}`);
    else if (draftReason) parts.push(`**Draft for review.** ${draftReason}`);
    const summaries = done.filter((s) => s.summary);
    parts.push('## Summary');
    if (!summaries.length) parts.push('No step left a summary.');
    for (const s of summaries) parts.push(`${summaries.length > 1 ? `### ${capital(s.duty)}\n\n` : ''}${cut(String(s.summary).trim(), summaryMax)}`);
    parts.push('## Checks');
    if (conflict) parts.push('Not run: the merge conflicts.');
    else if (!checks.length) parts.push('No landing checks are configured for this project.');
    else parts.push(checks.map((c) => `- ${inlineCode(c.command)}: ${c.passed ? 'passed' : 'failed'}${c.durationMs !== undefined ? ` in ${duration(c.durationMs)}` : ''}`).join('\n'));
    const tested = done.filter((s) => s.tested);
    if (tested.length) {
      parts.push("Tests the task's steps ran:");
      parts.push(tested.map((s) => `- ${s.duty}: ${inlineCode(s.tested.command)} ${s.tested.passed ? 'passed' : 'failed'}${s.tested.summary ? `: ${oneLine(s.tested.summary, 300)}` : ''}`).join('\n'));
    }
    if (decisions.length) {
      parts.push('## Decisions taken');
      parts.push(decisions.map((d) => `- ${oneLine(d.choice, 300)}${d.question ? ` (${oneLine(d.question, 300)})` : ''}: ${oneLine(d.reason, 400)}${d.reversible === false ? ' Not easily undone.' : ''}`).join('\n'));
    }
    if (followUps.length) {
      parts.push('## Follow-ups');
      const kind = { 'unrelated-failure': 'Outside this change', host: 'The machine', scope: 'Outside the plan' };
      parts.push(followUps.map((f) => `- ${kind[f.kind] ?? f.kind}: ${oneLine(f.title, 300)}. ${oneLine(f.cause, 400)}${f.evidence ? ` (${inlineCode(oneLine(f.evidence, 200))})` : ''}`).join('\n'));
    }
    if (outsideScope.length) {
      parts.push("## Outside the plan's scope");
      parts.push(outsideScope.slice(0, 50).map((f) => `- ${inlineCode(f)}`).join('\n'));
    }
    parts.push('## Evidence');
    const lines = [];
    const seen = new Set();
    for (const s of done) {
      for (const shot of s.screenshots ?? []) {
        const p = evidencePath(shot.path);
        if (seen.has(p)) continue;
        seen.add(p);
        lines.push(`- ${inlineCode(p)}${shot.caption ? `: ${oneLine(shot.caption, 300)}` : ''}`);
      }
    }
    for (const file of evidence) {
      if (seen.has(file)) continue;
      seen.add(file);
      lines.push(`- ${inlineCode(file)}`);
    }
    if (!lines.length) parts.push('None.');
    else {
      const shown = lines.slice(0, EVIDENCE_LIMIT);
      if (lines.length > shown.length) shown.push(`- and ${lines.length - shown.length} more`);
      parts.push(shown.join('\n'));
      parts.push("These files are in the task's evidence folder on the machine that ran it; they are not part of this branch.");
    }
    return redactText(`${parts.join('\n\n')}\n`);
  };
  let body = build(4000);
  if (body.length > limit) body = build(1000);
  if (body.length > limit) body = `${body.slice(0, limit - 40)}\n\n[The rest was cut to fit.]\n`;
  return body;
}

// Land by pull request: merge origin/<into>, the checks, push, the pull request. `draft` is the ask-owner route.
async function prRoute(ctx, { forced, reason, draft }) {
  const { root, wt, target, info } = ctx;
  const into = target.into;
  const branch = wt.branch;
  const remoteName = `origin/${into}`;
  const owner = ownerHome();
  const identity = gitIdentity(root, owner);
  const env = gitEnv(identityEnv(identity));
  const pushEnv = gitEnv({ HOME: owner, ...identityEnv(identity) });
  const title = cut(redactText(String(info.created.data?.title ?? ctx.task).replace(/\s+/g, ' ').trim()), 250);
  const facts = landingFacts(info);
  const extras = reportExtras(info);
  const outsideScope = ctx.scope?.outside ?? [];
  const body = (extra) => prBody({ into, steps: facts.steps, evidence: evidenceFiles(wt.path), decisions: extras.decisions, followUps: extras.followUps, outsideScope, ...extra });

  const merged = mergeInto(wt.path, into, branch, env, { ref: target.remoteRef, name: remoteName });
  if (merged.kind === 'conflict') {
    const files = listText(merged.files);
    if (forced) {
      throw new GitSkillError(
        `merging ${remoteName} into ${branch} conflicts in ${files}; the merge was aborted and nothing was pushed. The owner said Land now, so the task resolves it: ` +
          `run one implement step in the task's worktree with these instructions, record its step.done, then run land.mjs --task ${ctx.task} --force again. ` +
          `Instructions: ${resolveConflictInstructions(remoteName, branch, merged.files, { pr: true })}`,
      );
    }
    // A conflict is ask-owner, which in this mode is a draft pull request and the question. When the owner was going
    // to be asked anyway (a guard's reason), both reasons are kept.
    const conflictReason = draft && reason ? `${reason}; merging ${remoteName} also conflicts in ${files}` : `merge conflict in ${files}`;
    pushBranch(wt.path, branch, into, pushEnv);
    const pr = ensurePr(ctx.gh, wt.path, { existing: ctx.existingPr, draft: true, title, body: body({ conflict: files, draftReason: draft ? reason : null }), into, branch });
    return askOwner(ctx, conflictReason, { pr, checks: [] });
  }

  let results;
  try {
    results = await runLandingChecks(ctx, merged.head, 1, 'nothing was pushed');
  } catch (error) {
    // A check that fails for a reason the task's reports put outside its scope (a failure that is not this change's,
    // a host problem) is the owner's question, with the draft; with Land now the owner already knows, and it goes on.
    const outside = error.failed ? failureOutsideScope(extras.followUps, error.failed.tail) : null;
    if (!outside) throw error;
    results = [...(error.results ?? []), { name: error.failed.name, command: ctx.settings.checks.find((c) => c.name === error.failed.name)?.command ?? error.failed.name, passed: false, round: 1 }];
    if (!forced) {
      const why = `a check fails outside this task's scope: ${outside}`;
      append(ctx, 'landing.decided', { route: 'ask-owner', source: 'checks', reason: why });
      pushBranch(wt.path, branch, into, pushEnv);
      const pr = ensurePr(ctx.gh, wt.path, { existing: ctx.existingPr, draft: true, title, body: body({ checks: results, draftReason: why }), into, branch });
      return askOwner(ctx, why, { pr, checks: results });
    }
  }
  const head = resolveRef(wt.path, 'HEAD');
  const push = pushBranch(wt.path, branch, into, pushEnv);
  const pr = ensurePr(ctx.gh, wt.path, { existing: ctx.existingPr, draft, title, body: body({ checks: results, draftReason: draft ? reason : null }), into, branch });
  if (draft) return askOwner(ctx, reason, { pr, checks: results });

  append(ctx, 'task.landed', { pr: pr.url, commit: head, target: into, method: PR_METHOD });
  const checksText = ctx.settings.checks.length ? `checks passed: ${ctx.settings.checks.map((c) => c.name).join(', ')}` : 'no checks configured';
  const did = pr.opened ? 'Opened' : ctx.existingPr?.isDraft ? 'Marked ready for review' : 'Updated';
  const out = { task: ctx.task, route: 'land', landed: true, pr: pr.url, draft: false, commit: head, target: into, method: PR_METHOD, forced, reason, checks: results, push };
  print(ctx.json, out, `${did} the pull request ${pr.url} for ${ctx.task} (${branch} into ${into}, at ${head.slice(0, 12)}); ${checksText}. Nothing was merged: the owner reviews and merges it on GitHub.`);
  return 0;
}

// The pull request half of landTask (section 8 of the header).
async function landTaskPr(ctx) {
  const { root, wt, target } = ctx;
  const into = target.into;
  ctx.gh = ghClient(root);
  ctx.existingPr = findPr(ctx.gh, wt.path, wt.branch, into);
  const existing = ctx.existingPr;
  if (existing?.state === 'MERGED') {
    const commit = resolveRef(root, `refs/heads/${wt.branch}`) ?? existing.headRefOid ?? null;
    append(ctx, 'task.landed', { pr: existing.url, commit, target: into, method: PR_METHOD, merged: true, ...(existing.mergeCommit?.oid ? { mergeCommit: existing.mergeCommit.oid } : {}) });
    const out = { task: ctx.task, route: 'land', landed: true, pr: existing.url, merged: true, commit, target: into, method: PR_METHOD };
    print(ctx.json, out, `The pull request ${existing.url} of ${ctx.task} was already merged on GitHub; the task is recorded as landed.`);
    return 0;
  }
  if (existing?.state === 'CLOSED') {
    throw new GitSkillError(`the pull request ${existing.url} of ${wt.branch} was closed without merging. Reopen it on GitHub and land again, or leave the task (worktree.mjs archive --task ${ctx.task})`);
  }
  fetchOrigin(root, 'landing by pull request compares with a fresh origin, so nothing was done');
  if (!resolveRef(root, target.remoteRef)) throw new GitSkillError(`origin has no branch ${into} (project.json defaultBranch); there is nothing to open a pull request against`);
  const ahead = Number(git(root, ['rev-list', '--count', `${target.remoteRef}..refs/heads/${wt.branch}`]).stdout.trim());
  if (!ahead) throw new GitSkillError(`${wt.branch} has no commits that origin/${into} does not have; there is nothing to open a pull request for`);

  const decided = lastOfKind(ctx.info.events, 'landing.decided');
  const open = Boolean(decided) && !ctx.info.events.some((e) => e.seq > decided.seq && CLOSING_KINDS.includes(e.kind));
  if (ctx.force) {
    ctx.scope = landingScope(wt.path, target.remoteRef, wt.branch);
    append(ctx, 'landing.decided', { route: 'land', source: 'owner', reason: OWNER_REASON });
    return prRoute(ctx, { forced: true, reason: OWNER_REASON, draft: false });
  }
  const guard = landingGuard(ctx);
  if (guard.reason) {
    append(ctx, 'landing.decided', { route: 'ask-owner', source: guard.source, reason: guard.reason });
    return prRoute(ctx, { forced: false, reason: guard.reason, draft: true });
  }
  if (open && decided.data?.route === 'verify-then-land') {
    const verify = ctx.info.events.find((e) => e.kind === 'step.started' && e.seq > decided.seq && e.data?.duty === 'verify');
    if (!verify) return verifyThenLand(ctx, decided.data?.reason, true);
    return prRoute(ctx, { forced: false, reason: `verified before landing (step ${verify.step})`, draft: false });
  }
  const decision = await decide(ctx);
  append(ctx, 'landing.decided', decision);
  if (decision.route === 'ask-owner') return prRoute(ctx, { forced: false, reason: decision.reason, draft: true });
  if (decision.route === 'verify-then-land') return verifyThenLand(ctx, decision.reason, false);
  return prRoute(ctx, { forced: false, reason: decision.reason, draft: false });
}

async function landTask(ctx) {
  if (ctx.target.pr) return landTaskPr(ctx);
  const decided = lastOfKind(ctx.info.events, 'landing.decided');
  const open = Boolean(decided) && !ctx.info.events.some((e) => e.seq > decided.seq && CLOSING_KINDS.includes(e.kind));
  if (ctx.force) {
    append(ctx, 'landing.decided', { route: 'land', source: 'owner', reason: OWNER_REASON });
    return landRoute(ctx, { forced: true, reason: OWNER_REASON });
  }
  const guard = landingGuard(ctx);
  if (guard.reason) {
    append(ctx, 'landing.decided', { route: 'ask-owner', source: guard.source, reason: guard.reason });
    return askOwner(ctx, guard.reason);
  }
  if (open && decided.data?.route === 'verify-then-land') {
    const verify = ctx.info.events.find((e) => e.kind === 'step.started' && e.seq > decided.seq && e.data?.duty === 'verify');
    if (!verify) return verifyThenLand(ctx, decided.data?.reason, true);
    // Every step is done (the preconditions said so), this verify step included: land without asking Jev again.
    return landRoute(ctx, { forced: false, reason: `verified before landing (step ${verify.step})` });
  }
  const decision = await decide(ctx);
  append(ctx, 'landing.decided', decision);
  if (decision.route === 'ask-owner') return askOwner(ctx, decision.reason);
  if (decision.route === 'verify-then-land') return verifyThenLand(ctx, decision.reason, false);
  return landRoute(ctx, { forced: false, reason: decision.reason });
}

function alreadyLanded(info) {
  const landed = lastOfKind(info.events, 'task.landed');
  if (!landed) return null;
  return { commit: landed.data?.commit ?? null, target: landed.data?.target ?? null, ...(landed.data?.pr ? { pr: landed.data.pr } : {}) };
}

function printAlready(json, task, landed) {
  const where = landed.pr ? ` in the pull request ${landed.pr}` : landed.target ? ` on ${landed.target}` : '';
  print(json, { task, landed: true, already: true, ...landed }, `${task} already landed at ${String(landed.commit ?? '?').slice(0, 12)}${where}.`);
  return 0;
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('land.mjs --task T [--force] [--json]\n');
    return 0;
  }
  const { values } = parse(argv, { task: { type: 'string' }, force: { type: 'boolean' }, json: { type: 'boolean' } });
  const root = requireRoot();
  let info = requireTask(root, values.task);
  let landed = alreadyLanded(info);
  if (landed) return printAlready(values.json, info.created.task, landed);
  // Refuse at once when the task cannot land, before waiting for another landing; checked again under the lock.
  preconditions(root, info);
  const release = acquireLandingLock(root);
  releaseLock = release;
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    info = requireTask(root, values.task);
    landed = alreadyLanded(info);
    if (landed) return printAlready(values.json, info.created.task, landed);
    const ctx = { root, info, json: Boolean(values.json), force: Boolean(values.force), ...preconditions(root, info) };
    return await landTask(ctx);
  } finally {
    release();
    releaseLock = null;
  }
}

if (isMain(import.meta.url)) runCli(main);
