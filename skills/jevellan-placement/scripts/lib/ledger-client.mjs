// This skill's way to the ledger: the ledger skill's public script (ledger.mjs, see its SKILL.md "## Interface"),
// found by role and run as a process with --json. Nothing of the ledger's own code is imported; what a line means is
// read from what the ledger prints (show --json gives each step's views, so the reset and end rules stay the
// ledger's).

import path from 'node:path';
import { runRole } from './roles.mjs';

// The ledger's exit codes: 2 refused with a reason, 3 not found, 6 the task changed after --if-last-seq.
export const REFUSED = 2;
export const NOT_FOUND = 3;
export const CHANGED = 6;

export class LedgerCallError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

// Runs `ledger.mjs <args> --json` for the project at `cwd` (its root) and returns what it printed. The ledger looks at
// JH_PROJECT before its working folder, so JH_PROJECT is set to `cwd` for the call: the project read or written is
// always the one the caller named, whatever this process's environment says. A non-zero exit throws LedgerCallError
// with the ledger's message and exit code.
export function callLedger(args, { cwd, input } = {}) {
  const env = cwd ? { ...process.env, JH_PROJECT: path.resolve(cwd) } : undefined;
  const r = runRole('ledger', 'ledger.mjs', [...args, '--json'], { cwd, input, env });
  if (r.code === 0 && r.json) return r.json;
  const message = r.json?.error ?? (r.stderr.trim() || `ledger.mjs ${args[0]} exited ${r.code}${r.stdout ? `: ${r.stdout.trim().slice(0, 300)}` : ''}`);
  throw new LedgerCallError(message, r.code === 0 ? 1 : r.code);
}

const EMPTY_VIEW = { state: 'pending', starts: 0, started: null, end: null, done: null, lastReport: null, placed: null };

// The task as the ledger reads it (`show T --json`): the projection's fields (state, steps, currentStep, worktree...),
// `created` (the task.created line), `events` (the task's lines), `lastSeq` (what --if-last-seq compares), and
// view(ordinal) / overall(ordinal): the step's view since its last retry reset and over all lines, with started, end,
// done, lastReport and placed as the events themselves (null when there is none).
export function readTask(root, task) {
  const json = callLedger(['show', task], { cwd: root });
  if (!Array.isArray(json.events) || !Array.isArray(json.views) || !Number.isInteger(json.lastSeq)) {
    throw new LedgerCallError("the installed ledger skill's show --json has no events, views or lastSeq (its Interface is older than this skill needs); tell the owner to update the ledger skill and do not improvise it", REFUSED);
  }
  const bySeq = new Map(json.events.map((event) => [event.seq, event]));
  const hydrate = (v) => ({
    state: v.state,
    starts: v.starts,
    started: bySeq.get(v.started) ?? null,
    end: bySeq.get(v.end) ?? null,
    done: bySeq.get(v.done) ?? null,
    lastReport: bySeq.get(v.lastReport) ?? null,
    placed: bySeq.get(v.placed) ?? null,
  });
  const views = new Map(json.views.map((v) => [v.ordinal, { resetSeq: v.resetSeq, current: hydrate(v.current), overall: hydrate(v.overall) }]));
  const pick = (ordinal, which) => {
    const v = views.get(ordinal);
    return { ordinal, resetSeq: v?.resetSeq ?? 0, ...(v ? v[which] : EMPTY_VIEW) };
  };
  return {
    ...json,
    created: json.events.find((event) => event.kind === 'task.created') ?? null,
    view: (ordinal) => pick(ordinal, 'current'),
    overall: (ordinal) => pick(ordinal, 'overall'),
  };
}

// Lines of the whole ledger (`events --json`): {lastSeq, events}, narrowed to some tasks or kinds when given.
export function readEvents(root, { tasks = [], kinds = [], since } = {}) {
  const args = ['events', ...tasks.flatMap((t) => ['--task', t]), ...kinds.flatMap((k) => ['--kind', k])];
  if (since !== undefined) args.push('--since', String(since));
  return callLedger(args, { cwd: root });
}

// Appends one line of a kind this skill's scripts own (`record`), or of a hand kind with the ledger's own checks
// (`append`, for step.message). With ifLastSeq the line is written only when the task's newest line is still that
// seq; otherwise LedgerCallError with exit 6 (CHANGED) and nothing is written. Returns the line as written.
export function appendLine(root, kind, { task, step, session, data = {}, ifLastSeq, command = 'record' } = {}) {
  const args = [command, kind, '--task', task];
  if (step !== undefined && step !== null) args.push('--step', String(step));
  if (session) args.push('--session', session);
  args.push('--data-file', '-');
  if (ifLastSeq !== undefined && ifLastSeq !== null) args.push('--if-last-seq', String(ifLastSeq));
  return callLedger(args, { cwd: root, input: JSON.stringify(data) });
}

// Reads the task, runs `decide(task)` on it, and appends what it returns ({kind, step, session, data}, or null for
// nothing to write) only if the task did not change in between; when it did, reads again and decides again, up to
// `attempts` times. `decide` holds the caller's guards and throws to refuse. Returns {task, event}.
export function appendChecked(root, taskId, decide, { attempts = 5 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const task = readTask(root, taskId);
    const line = decide(task);
    if (!line) return { task, event: null };
    try {
      return { task, event: appendLine(root, line.kind, { ...line, task: taskId, ifLastSeq: task.lastSeq }) };
    } catch (error) {
      if (!(error instanceof LedgerCallError) || error.exitCode !== CHANGED) throw error;
      last = error;
    }
  }
  throw new LedgerCallError(`${taskId} kept changing while this script wrote to it (${attempts} attempts): ${last?.message ?? ''}; run it again`, REFUSED);
}
