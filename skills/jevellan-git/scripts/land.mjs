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
import { spawn } from 'node:child_process';
import { runRole } from './lib/roles.mjs';
import { loadPolicy, parseIdLines, requireSection } from './lib/policy.mjs';
import { ownerHome, projectPaths } from './lib/project.mjs';
import { compactTime } from './lib/ids.mjs';
import { acquire } from './lib/lock.mjs';
import { redactValue } from './lib/redact.mjs';
import { appendLine } from './lib/ledger-client.mjs';
import {
  GitSkillError,
  SKILL_DIR,
  currentBranch,
  defaultBranch,
  findWorktree,
  firstLine,
  git,
  gitEnv,
  gitIdentity,
  identityEnv,
  isAncestor,
  isMain,
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
// an empty list means [testCommand]; nothing at all means no checks), pushAfterLanding, guidance.
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
  return { riskyPaths: riskyPaths.map((p) => p.trim()), checks: effective, pushAfterLanding: push === true, guidance };
}

// ---- the landing state ---------------------------------------------------------------------------------------

export function cut(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

function oneLine(text, max) {
  return cut(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
}

// Ported pathMatches: a file is under a risky path when it is that path or below it.
export function pathMatches(file, riskyPath) {
  const p = riskyPath.replace(/^\.\//, '').replace(/\/+$/u, '');
  return p !== '' && (file === p || file.startsWith(`${p}/`));
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
// was, and the conflicted files are returned.
export function mergeInto(worktree, into, branch, env) {
  const target = resolveRef(worktree, `refs/heads/${into}`);
  if (!target) throw new GitSkillError(`the branch ${into} to land into does not exist`);
  const head = resolveRef(worktree, 'HEAD');
  if (isAncestor(worktree, target, head)) return { kind: 'up-to-date', head };
  // A branch with nothing of its own catches up without a merge commit, so an empty merge never lands.
  if (isAncestor(worktree, head, target)) {
    git(worktree, ['merge', '--ff-only', '--no-edit', target], { env });
    return { kind: 'fast-forward', head: target };
  }
  const r = git(worktree, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${into} into ${branch}`, target], { permitted: [0, 1, 2, 128], env });
  if (r.code === 0) return { kind: 'merged', head: resolveRef(worktree, 'HEAD') };
  const files = conflictedFiles(worktree);
  git(worktree, ['merge', '--abort'], { permitted: [0, 1, 128], env });
  if (!files.length) throw new GitSkillError(`git merge ${into} failed in ${worktree}: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}`);
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
export function resolveConflictInstructions(into, branch, files) {
  return (
    `Landing this task on ${into} needs a merge first: merging ${into} into ${branch} conflicts in ${files.join(', ')}. ` +
    `The owner said "Land now". Run git merge ${into} in this worktree and resolve every conflict keeping what both sides meant ` +
    '(for a changelog or another list, keep both entries); change nothing else. Run the tests that cover the conflicted files, ' +
    `then commit the merge on ${branch}. Never touch ${into} itself: landing moves it after you report done.`
  );
}

// ---- preconditions -------------------------------------------------------------------------------------------

// Where the task lands: the default branch, or the parent's branch for a child task (D-048). Refuses with the reason.
function landingTarget(root, info, config) {
  const task = info.created.task;
  const parentId = info.created.data?.parent;
  if (!parentId) {
    const into = defaultBranch(root, config);
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
  const target = landingTarget(root, info, config);
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
  const files = changedFiles(wt.path, `refs/heads/${target.into}`, `refs/heads/${wt.branch}`);
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

function askOwner(ctx, reason) {
  const title = ctx.info.created.data?.title ?? ctx.task;
  const question = `Land ${title}? ${reason}`;
  append(ctx, 'task.asked', { question, options: [...OPTIONS], reason });
  const out = { task: ctx.task, route: 'ask-owner', question, options: [...OPTIONS], reason };
  print(ctx.json, out, `${ctx.task}: the owner decides. ${question}\nOptions: 1) Land now (land.mjs --task ${ctx.task} --force)  2) Leave it (worktree.mjs archive --task ${ctx.task})`);
  return 7;
}

function verifyThenLand(ctx, reason, again) {
  const out = { route: 'verify-then-land' };
  if (ctx.json) print(true, { ...out, task: ctx.task, reason: reason ?? null, instructions: VERIFY_BEFORE_LANDING, again });
  else process.stdout.write(`${JSON.stringify(out)}\n`);
  return 6;
}

async function landRoute(ctx, { forced, reason }) {
  const { root, wt, target, settings } = ctx;
  const into = target.into;
  const branch = wt.branch;
  const owner = ownerHome();
  const identity = gitIdentity(root, owner);
  const env = gitEnv(identityEnv(identity));
  const checkEnv = checkEnvironment(owner, identity);
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
    // A worktree whose setup command never succeeded (made before the project had one, or interrupted) gets it now,
    // so the checks run against the project's dependencies rather than fail for want of them.
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
      if (result.passed && now !== merged.head) {
        result.passed = false;
        result.tail = `${result.tail}\n[the check changed the worktree's HEAD from ${merged.head.slice(0, 12)} to ${now?.slice(0, 12) ?? 'nothing'}]`.slice(-TAIL_CHARS);
      }
      // The ledger masks secrets in the tail; what is printed below is the line as written.
      const event = append(ctx, 'landing.checked', { command: check.command, passed: result.passed, tail: result.tail });
      results.push({ name: check.name, command: check.command, passed: result.passed, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, round });
      if (!result.passed) {
        const why = result.timedOut ? `timed out after ${check.timeoutMs} ms` : `exit ${result.exitCode ?? 'none'}`;
        throw new GitSkillError(`check ${check.name} failed (${why}); ${into} did not move. Output tail:\n${event.data.tail}`);
      }
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

async function landTask(ctx) {
  const decided = lastOfKind(ctx.info.events, 'landing.decided');
  const open = Boolean(decided) && !ctx.info.events.some((e) => e.seq > decided.seq && CLOSING_KINDS.includes(e.kind));
  if (ctx.force) {
    append(ctx, 'landing.decided', { route: 'land', source: 'owner', reason: OWNER_REASON });
    return landRoute(ctx, { forced: true, reason: OWNER_REASON });
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
  return landed ? { commit: landed.data?.commit ?? null, target: landed.data?.target ?? null } : null;
}

function printAlready(json, task, landed) {
  print(json, { task, landed: true, already: true, ...landed }, `${task} already landed at ${String(landed.commit ?? '?').slice(0, 12)}${landed.target ? ` on ${landed.target}` : ''}.`);
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
