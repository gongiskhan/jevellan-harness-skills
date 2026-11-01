// The ledger: .jevellan/ledger.jsonl at the project root, append-only, one JSON object per line, never edited and
// never truncated. This module is the only code that writes it. Every other script and hook appends through
// appendEvent, which takes the lock, numbers the line, masks secrets and writes it with one writeSync.

import fs from 'node:fs';
import path from 'node:path';
import { withLock, pidAlive } from './lock.mjs';
import { projectPaths } from './project.mjs';
import { redactValue } from './redact.mjs';

export const KINDS = Object.freeze([
  'task.created',
  'task.worktree',
  'task.workflow',
  'task.placed',
  'step.started',
  'step.message',
  'step.report',
  'step.done',
  'step.failed',
  'step.retrying',
  'step.lost',
  'step.stopped',
  'session.event',
  'session.started',
  'session.ended',
  'landing.decided',
  'landing.checked',
  'task.landed',
  'task.asked',
  'note',
]);

export const DUTIES = Object.freeze(['answer', 'converse', 'investigate', 'plan', 'implement', 'document', 'verify', 'automate']);
export const READ_ONLY_DUTIES = Object.freeze(['answer', 'converse', 'investigate', 'plan']);
export const TASK_KINDS = Object.freeze(['feature', 'bug', 'automation', 'single']);
export const MAX_LINE = 64 * 1024;

// Exit codes shared by every script: 0 ok, 2 refused with a reason, 3 not found.
export class LedgerError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The last complete line of the file, read from its end (lines are at most 64 KB).
function lastLine(fd, size) {
  if (size === 0) return null;
  const length = Math.min(size, MAX_LINE + 2);
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, size - length);
  const text = buffer.toString('utf8').replace(/\n+$/, '');
  const index = text.lastIndexOf('\n');
  return index >= 0 ? text.slice(index + 1) : text;
}

function lastSeq(fd, size) {
  const line = lastLine(fd, size);
  if (!line) return 0;
  try {
    const seq = JSON.parse(line).seq;
    if (Number.isInteger(seq)) return seq;
  } catch {}
  throw new LedgerError('the ledger\'s last line does not parse; run ledger.mjs verify');
}

export function buildLine(seq, { kind, task, step, session, data }) {
  const event = { seq, t: new Date().toISOString(), kind };
  if (task) event.task = task;
  if (step !== undefined && step !== null) event.step = step;
  if (session) event.session = session;
  event.data = redactValue(data ?? {});
  return event;
}

// Appends one event and returns it as written. Refuses unknown kinds, non-object data and lines over 64 KB.
// `check(events)` (optional) runs inside the lock against the current lines and may throw to refuse, so a
// conditional append (step.lost, a guarded step.done) cannot race another writer.
export function appendEvent(root, input, { check } = {}) {
  if (!KINDS.includes(input.kind)) throw new LedgerError(`unknown event kind "${input.kind}"`);
  if (input.data !== undefined && !isObject(input.data)) throw new LedgerError('data must be a JSON object');
  if (input.step !== undefined && input.step !== null && !(Number.isInteger(input.step) && input.step > 0)) {
    throw new LedgerError('step must be a positive integer');
  }
  const paths = projectPaths(root);
  fs.mkdirSync(paths.locks, { recursive: true });
  return withLock(paths.ledgerLock, () => {
    if (check) check(readEvents(root).events);
    const fd = fs.openSync(paths.ledger, 'a+', 0o600);
    try {
      const size = fs.fstatSync(fd).size;
      const seq = lastSeq(fd, size) + 1;
      const event = buildLine(seq, input);
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line) > MAX_LINE) throw new LedgerError(`the ${input.kind} line is over 64 KB; refused`);
      // A file whose last line lacks its newline (a crash mid-write cannot happen with one writeSync, but a hand
      // edit can) would glue two lines together; start on a fresh line instead.
      let prefix = '';
      if (size > 0) {
        const tail = Buffer.alloc(1);
        fs.readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) prefix = '\n';
      }
      fs.writeSync(fd, prefix + line);
      return event;
    } finally {
      fs.closeSync(fd);
    }
  });
}

export function parseLines(text) {
  const events = [];
  const problems = [];
  let lineNo = 0;
  for (const raw of text.split('\n')) {
    lineNo += 1;
    if (raw.trim() === '') continue;
    try {
      const event = JSON.parse(raw);
      if (!isObject(event)) throw new Error('not an object');
      events.push(event);
    } catch (error) {
      problems.push({ line: lineNo, problem: `line ${lineNo} does not parse (${error.message})` });
    }
  }
  return { events, problems };
}

export function readEvents(root) {
  let text = '';
  try {
    text = fs.readFileSync(projectPaths(root).ledger, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return parseLines(text);
}

export function ledgerExists(root) {
  return fs.existsSync(projectPaths(root).ledger);
}

export function verifyLedger(root) {
  const { events, problems } = readEvents(root);
  const issues = problems.map((p) => p.problem);
  let expected = 1;
  for (const event of events) {
    if (event.seq !== expected) issues.push(`seq ${event.seq} where ${expected} was expected`);
    expected = (Number.isInteger(event.seq) ? event.seq : expected) + 1;
    if (!KINDS.includes(event.kind)) issues.push(`seq ${event.seq}: unknown kind "${event.kind}"`);
    if (typeof event.t !== 'string' || Number.isNaN(Date.parse(event.t))) issues.push(`seq ${event.seq}: bad time`);
    if (!isObject(event.data)) issues.push(`seq ${event.seq}: data is not an object`);
  }
  return { ok: issues.length === 0, lines: events.length, issues };
}

// ---- the projection (section 4) --------------------------------------------------------------------------------

// Events that move a task's life on. Hook noise (session.*) and notes never decide a state.
const LIFECYCLE = new Set(KINDS.filter((kind) => !kind.startsWith('session.') && kind !== 'note'));
const STEP_KINDS = new Set(['step.started', 'step.report', 'step.done', 'step.failed', 'step.retrying', 'step.lost', 'step.stopped']);
const STEP_END = new Set(['step.report', 'step.failed', 'step.lost', 'step.stopped']);
const LANDING_KINDS = new Set(['landing.decided', 'landing.checked', 'task.asked', 'task.landed']);

export function groupByTask(events) {
  const tasks = new Map();
  for (const event of events) {
    if (event.kind === 'task.created' && event.task && !tasks.has(event.task)) {
      tasks.set(event.task, { created: event, events: [] });
    }
    if (event.task && tasks.has(event.task)) tasks.get(event.task).events.push(event);
  }
  return tasks;
}

// A step's view: its latest start, what ended that start, whether it is done, and how many times it ran.
// Events at or before `resetSeq` are ignored: a step.retrying that goes back to this step or an earlier one makes
// it pending again.
export function stepView(taskEvents, ordinal, resetSeq = 0) {
  let started = null;
  let end = null;
  let done = null;
  let starts = 0;
  let lastReport = null;
  let placed = null;
  for (const event of taskEvents) {
    if (event.seq <= resetSeq) continue;
    if (event.kind === 'task.placed' && event.data?.step === ordinal) placed = event;
    if (event.step !== ordinal) continue;
    if (event.kind === 'step.started') {
      started = event;
      end = null;
      done = null;
      starts += 1;
    } else if (STEP_END.has(event.kind) && started) {
      // The last end wins: a step.failed appended after a blocked report fails the step.
      end = event;
      if (event.kind === 'step.report') lastReport = event;
    } else if (event.kind === 'step.report') {
      lastReport = event;
    } else if (event.kind === 'step.done') {
      done = event;
    }
  }
  let state = 'pending';
  if (done) state = 'done';
  else if (started && !end) state = 'running';
  else if (end?.kind === 'step.report') state = `reported-${end.data?.status ?? 'unknown'}`;
  else if (end) state = end.kind.slice('step.'.length);
  return { ordinal, started, end, done, starts, lastReport, placed, state };
}

function workflowSteps(info) {
  const workflow = [...info.events].reverse().find((e) => e.kind === 'task.workflow');
  const created = info.created.data ?? {};
  if (created.kind === 'single') {
    return { steps: [{ ordinal: 1, duty: created.duty }], skipped: [], resolved: true };
  }
  if (!workflow) return { steps: [], skipped: [], resolved: false };
  return { steps: workflow.data?.steps ?? [], skipped: workflow.data?.skipped ?? [], resolved: true };
}

// Every step.retrying {gotoOrdinal}: the steps from gotoOrdinal on start again.
export function resetPoints(events) {
  return events
    .filter((e) => e.kind === 'step.retrying' && Number.isInteger(e.data?.gotoOrdinal))
    .map((e) => ({ seq: e.seq, from: e.data.gotoOrdinal }));
}

export function resetFor(resets, ordinal) {
  let seq = 0;
  for (const r of resets) if (ordinal >= r.from && r.seq > seq) seq = r.seq;
  return seq;
}

function lastOf(events, predicate) {
  for (let i = events.length - 1; i >= 0; i -= 1) if (predicate(events[i])) return { event: events[i], index: i };
  return null;
}

// The state of one task from its lines alone. Rules in order (section 4, with H-008):
// stopped, done, waiting-owner, landing, failed, running, queued.
export function projectTask(info, { alive = pidAlive } = {}) {
  const events = info.events;
  const created = info.created;
  const meta = created.data ?? {};
  const { steps, skipped, resolved } = workflowSteps(info);
  const worktree = lastOf(events, (e) => e.kind === 'task.worktree')?.event?.data ?? null;
  const ordinals = new Set(steps.map((s) => s.ordinal));
  for (const e of events) if (e.kind === 'step.started' && Number.isInteger(e.step)) ordinals.add(e.step);
  const resets = resetPoints(events);
  const views = [...ordinals].sort((a, b) => a - b).map((ordinal) => {
    const view = stepView(events, ordinal, resetFor(resets, ordinal));
    const spec = steps.find((s) => s.ordinal === ordinal);
    return { ...view, duty: spec?.duty ?? view.started?.data?.duty ?? null, skipped: skipped.includes(ordinal) };
  });
  const startedOrdinals = views.filter((v) => v.started).map((v) => v.ordinal);
  const currentOrdinal = startedOrdinals.length ? Math.max(...startedOrdinals) : null;
  const current = views.find((v) => v.ordinal === currentOrdinal) ?? null;
  const lastReport = lastOf(events, (e) => e.kind === 'step.report')?.event ?? null;
  const landed = lastOf(events, (e) => e.kind === 'task.landed');
  const decided = lastOf(events, (e) => e.kind === 'landing.decided');
  const lastLanding = lastOf(events, (e) => LANDING_KINDS.has(e.kind));
  const lastStep = lastOf(events, (e) => STEP_KINDS.has(e.kind));
  const lastLife = lastOf(events, (e) => LIFECYCLE.has(e.kind));

  const result = {
    task: created.task,
    kind: meta.kind,
    duty: meta.duty,
    title: meta.title,
    parent: meta.parent ?? null,
    after: meta.after ?? null,
    origin: meta.origin ?? null,
    createdAt: created.t,
    updatedAt: events[events.length - 1]?.t ?? created.t,
    worktree,
    workflowResolved: resolved,
    steps: views.map((v) => ({
      ordinal: v.ordinal,
      duty: v.duty,
      state: v.skipped ? 'skipped' : v.state,
      starts: v.starts,
      model: v.started?.data?.model ?? v.placed?.data?.model ?? null,
      effort: v.started?.data?.effort ?? v.placed?.data?.effort ?? null,
      provider: v.started?.data?.provider ?? v.placed?.data?.provider ?? null,
      pid: v.started?.data?.pid ?? null,
      nativeSessionId: v.started?.data?.nativeSessionId ?? null,
      startedAt: v.started?.t ?? null,
    })),
    currentStep: currentOrdinal,
    state: 'queued',
    reason: null,
  };

  const reportOf = (view) => (view?.end?.kind === 'step.report' ? view.end : null);
  const currentReport = reportOf(current);

  // 1. stopped: the last step.stopped came after every later lifecycle event of the task.
  if (lastLife?.event.kind === 'step.stopped') {
    result.state = 'stopped';
    result.reason = lastLife.event.data?.reason ?? null;
    return result;
  }
  // 2. done: landed, or a single task whose step reported done and has nothing to land (H-008).
  if (landed) {
    result.state = 'done';
    result.landedCommit = landed.event.data?.commit ?? null;
    result.landedAt = landed.event.t;
    return result;
  }
  if (meta.kind === 'single' && currentReport?.data?.status === 'done') {
    const writes = !READ_ONLY_DUTIES.includes(meta.duty);
    const changed = Array.isArray(currentReport.data.changedFiles) && currentReport.data.changedFiles.length > 0;
    if (!(writes && changed)) {
      result.state = 'done';
      result.doneAt = currentReport.t;
      return result;
    }
  }
  // 3. waiting-owner: the current step asks (needs-decision or blocked), or a landing question is open.
  if (lastLanding?.event.kind === 'task.asked' && (!lastStep || lastStep.index < lastLanding.index)) {
    result.state = 'waiting-owner';
    result.waiting = { source: 'landing', question: lastLanding.event.data?.question, options: lastLanding.event.data?.options ?? [] };
    return result;
  }
  if (currentReport && ['needs-decision', 'blocked'].includes(currentReport.data?.status)) {
    result.state = 'waiting-owner';
    result.waiting = {
      source: 'step',
      step: currentOrdinal,
      status: currentReport.data.status,
      question: currentReport.data.question ?? null,
      options: currentReport.data.options ?? [],
      summary: currentReport.data.summary,
    };
    return result;
  }
  // 4. landing: decided and not landed. A failed landing check is a failure (H-008). Step activity after the last
  // landing event (a fix after a failed check) is judged by the step rules below, except the extra verify step of
  // verify-then-land, which is part of landing.
  if (decided) {
    const landingInfo = { route: decided.event.data?.route ?? null, reason: decided.event.data?.reason ?? null };
    const stepAfter = lastStep && lastStep.index > lastLanding.index;
    if (!stepAfter) {
      if (lastLanding.event.kind === 'landing.checked' && lastLanding.event.data?.passed === false) {
        result.state = 'failed';
        result.reason = `landing check failed: ${lastLanding.event.data?.command ?? ''}`.trim();
        return result;
      }
      result.state = 'landing';
      result.landing = landingInfo;
      return result;
    }
    const extraVerify = landingInfo.route === 'verify-then-land' && current?.started && current.started.seq > decided.event.seq;
    if (extraVerify && current.state === 'running') {
      result.state = 'landing';
      result.landing = { ...landingInfo, verifyStep: current.ordinal };
      return result;
    }
  }
  // 5. failed: the last step event is a failure or a lost session.
  if (lastStep && ['step.failed', 'step.lost'].includes(lastStep.event.kind)) {
    result.state = 'failed';
    result.reason = lastStep.event.kind === 'step.lost' ? `step ${lastStep.event.step} lost (pid ${lastStep.event.data?.pid ?? '?'} gone)` : lastStep.event.data?.reason ?? null;
    return result;
  }
  // 6. running: any started step with nothing after it (normally the current one).
  const running = views.filter((v) => !v.skipped && v.state === 'running');
  if (running.length) {
    const view = running[running.length - 1];
    result.state = 'running';
    result.runningStep = view.ordinal;
    result.alive = alive(view.started.data?.pid);
    return result;
  }
  result.state = 'queued';
  return result;
}

// What the coordinator should do next, from the projection. A hint, never a decision.
export function nextHint(task) {
  switch (task.state) {
    case 'waiting-owner':
      return task.waiting?.source === 'landing' ? 'ask the owner: Land now or Leave it' : 'answer the step or ask the owner';
    case 'running':
      return 'wait for the step report';
    case 'landing':
      return task.landing?.route === 'verify-then-land' ? 'run the extra verify step, then land again' : 'finish landing';
    case 'failed':
      return 'apply the workflow retry rule or tell the owner';
    case 'queued': {
      if (task.kind !== 'single' && !task.worktree) return 'make the worktree';
      if (!task.workflowResolved) return 'resolve the workflow';
      const current = task.steps.find((s) => s.ordinal === task.currentStep);
      if (current?.state === 'reported-done') return `record step.done for step ${current.ordinal}`;
      if (current?.state === 'reported-progress') return `resume step ${current.ordinal} with "Continue."`;
      const pending = task.steps.find((s) => s.state === 'pending');
      if (pending) return `place and start step ${pending.ordinal} (${pending.duty})`;
      return 'land the task';
    }
    default:
      return null;
  }
}

// Every task's projection; marks lost steps (pid gone, nothing after its start) by appending step.lost, the one
// write a read command does. The append re-checks the condition under the lock, so a report that arrives between
// reading and appending wins.
export function projectAll(root, { alive = pidAlive, markLost = true } = {}) {
  let { events } = readEvents(root);
  const lost = [];
  if (markLost) {
    for (const [task, info] of groupByTask(events)) {
      const view = projectTask(info, { alive });
      for (const running of view.steps.filter((s) => s.state === 'running')) {
      const step = running.ordinal;
      const started = stepView(info.events, step, resetFor(resetPoints(info.events), step)).started;
      const pid = started?.data?.pid;
      if (!Number.isInteger(pid) || alive(pid)) continue;
      try {
        const event = appendEvent(
          root,
          { kind: 'step.lost', task, step, session: started.session, data: { ordinal: step, pid } },
          {
            check: (now) => {
              const fresh = groupByTask(now).get(task);
              const v = fresh && stepView(fresh.events, step, resetFor(resetPoints(fresh.events), step));
              if (!v || v.started?.seq !== started.seq || v.end || v.done) throw new LedgerError('no longer lost', 0);
              if (alive(pid)) throw new LedgerError('alive again', 0);
            },
          },
        );
        lost.push(event);
      } catch (error) {
        if (!(error instanceof LedgerError) || error.exitCode !== 0) throw error;
      }
      }
    }
    if (lost.length) events = readEvents(root).events;
  }
  const tasks = [...groupByTask(events).values()].map((info) => {
    const view = projectTask(info, { alive });
    view.next = nextHint(view);
    return view;
  });
  return { tasks, lost, events };
}

export function findTask(events, id) {
  return groupByTask(events).get(id) ?? null;
}

export function latestReport(events, task, step) {
  const info = findTask(events, task);
  if (!info) return null;
  const reports = info.events.filter((e) => e.kind === 'step.report' && (step === undefined || e.step === step));
  return reports[reports.length - 1] ?? null;
}

export function relativeToRoot(root, file) {
  return path.relative(root, file) || '.';
}
