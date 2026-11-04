#!/usr/bin/env node
// The ledger's command line: create tasks, append the few events a session may append by hand, and read the
// ledger back (status, show, report, wait, tail, verify). Every command accepts --json. Exit codes: 0 ok,
// 2 refused with a reason, 3 not found; wait also uses 4 (failed, lost or stopped) and 5 (timeout).

import fs from 'node:fs';
import path from 'node:path';
import {
  DUTIES,
  KINDS,
  LedgerError,
  TASK_KINDS,
  appendEvent,
  findTask,
  groupByTask,
  lastSeqOf,
  latestReport,
  projectAll,
  projectTask,
  readEvents,
  resetFor,
  resetPoints,
  stepView,
  stepViews,
  unchangedSince,
  verifyLedger,
} from './lib/ledger.mjs';
import { readReportFile, recordReport } from './lib/report-file.mjs';
import { isTaskId, newTaskId } from './lib/ids.mjs';
import { projectPaths, projectRoot } from './lib/project.mjs';
import { oneLine, renderReport } from './lib/format.mjs';
import { parse, print, run } from './lib/cli.mjs';
import { isMain } from './lib/hook.mjs';
import { pidAlive, sleepMs } from './lib/lock.mjs';
import { HEADINGS, OPEN_STATES, ORDER, briefLines, describe, statusView } from './lib/status.mjs';

const USAGE = `ledger.mjs task create --kind feature|bug|automation|single [--duty D] --title "..." (--text "..." | --text-file F) [--parent T] [--after T] [--origin owner|coordinator]
ledger.mjs append <kind> [--task T] [--step N] [--session S] --data '<json>' [--force] [--if-last-seq N]
ledger.mjs status [--brief]
ledger.mjs show T
ledger.mjs report T [--step N]
ledger.mjs wait --task T [--step N] [--timeout S]
ledger.mjs tail [--follow] [--task T]
ledger.mjs verify
ledger.mjs ask --task T (--data '<json>' | --data-file F|-)   {question, options: [{label, means}], recommended, reason?}
ledger.mjs answer --task T --text "..." [--option LABEL]
For the scripts of other skills:
ledger.mjs record <kind> --task T [--step N] [--session S] (--data '<json>' | --data-file F) [--if-last-seq N]
ledger.mjs events [--task T]... [--kind K]... [--since SEQ]
ledger.mjs take-report --task T --step N --session S --cwd DIR [--native-session ID] [--ended "..."]
Every command accepts --json.`;

// What a session may append by hand. Everything else belongs to a script or a hook that guards it.
const HAND_KINDS = ['note', 'step.message', 'task.workflow', 'step.done', 'step.failed', 'step.retrying'];
// What `record` appends for the scripts of other skills (placement, worktrees, starts, landings, sessions). task.created
// has its own command; step.lost is written by this skill alone, when it sees a worker's process gone; step.report
// only through the Stop hook or take-report, which check the report against its schema and fit it to one line.
const RECORD_KINDS = KINDS.filter((kind) => !HAND_KINDS.includes(kind) && !['task.created', 'step.lost', 'step.report'].includes(kind));

function root() {
  const found = projectRoot();
  if (!found) throw new LedgerError('not inside a git repository: the ledger lives at the project root', 2);
  return found;
}

function requireTask(events, id) {
  if (!isTaskId(id)) throw new LedgerError(`"${id}" is not a task id (T and six characters)`);
  const info = findTask(events, id);
  if (!info) throw new LedgerError(`no task ${id} in this project's ledger`, 3);
  return info;
}

function readText(values) {
  if (values.text !== undefined && values['text-file'] !== undefined) throw new LedgerError('give --text or --text-file, not both');
  if (values.text !== undefined) return values.text;
  if (values['text-file'] === '-') return fs.readFileSync(0, 'utf8');
  if (values['text-file'] !== undefined) {
    try {
      return fs.readFileSync(values['text-file'], 'utf8');
    } catch (error) {
      throw new LedgerError(`cannot read --text-file: ${error.code ?? error.message}`);
    }
  }
  throw new LedgerError('the task needs a brief: --text "..." or --text-file F');
}

// ---- task create ---------------------------------------------------------------------------------------------

function taskCreate(argv) {
  const { values } = parse(argv, {
    kind: { type: 'string' },
    duty: { type: 'string' },
    title: { type: 'string' },
    text: { type: 'string' },
    'text-file': { type: 'string' },
    parent: { type: 'string' },
    after: { type: 'string' },
    origin: { type: 'string' },
    json: { type: 'boolean' },
  }, { allowPositionals: false });
  if (!TASK_KINDS.includes(values.kind)) throw new LedgerError(`--kind must be one of ${TASK_KINDS.join(', ')}`);
  if (values.kind === 'single') {
    if (!DUTIES.includes(values.duty)) throw new LedgerError(`a single task needs --duty, one of ${DUTIES.join(', ')}`);
  } else if (values.duty !== undefined) {
    throw new LedgerError('--duty is only for --kind single; the workflow gives the other kinds their duties');
  }
  const title = (values.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) throw new LedgerError('--title is required');
  if (title.length > 200) throw new LedgerError('--title must be at most 200 characters');
  const text = readText(values).replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (!text.trim()) throw new LedgerError('the brief is empty');
  const origin = values.origin ?? 'owner';
  if (!['owner', 'coordinator'].includes(origin)) throw new LedgerError('--origin must be owner or coordinator');
  const at = root();
  const { events } = readEvents(at);
  for (const ref of ['parent', 'after']) if (values[ref] !== undefined) requireTask(events, values[ref]);

  // The same task typed twice while the first is still open is one task.
  for (const info of groupByTask(events).values()) {
    const d = info.created.data ?? {};
    if (d.kind === values.kind && d.title === title && d.text === text && (d.duty ?? null) === (values.duty ?? null)) {
      const state = projectTask(info).state;
      if (OPEN_STATES.includes(state)) {
        const existing = { task: info.created.task, kind: d.kind, title, state, existing: true };
        print(values.json, existing, `${existing.task} already exists (${state}): ${title}`);
        return 0;
      }
    }
  }
  const taken = new Set([...groupByTask(events).keys()]);
  const id = newTaskId(taken);
  const data = { kind: values.kind, title, text, parent: values.parent ?? null, after: values.after ?? null, origin };
  if (values.kind === 'single') data.duty = values.duty;
  const event = appendEvent(at, { kind: 'task.created', task: id, session: process.env.JH_SESSION, data }, {
    check: (now) => {
      if (groupByTask(now).has(id)) throw new LedgerError(`task id ${id} was taken meanwhile; run the command again`);
    },
  });
  print(values.json, { task: id, kind: data.kind, title, seq: event.seq, existing: false }, `Created ${id} (${data.kind}${data.duty ? ` ${data.duty}` : ''}): ${title}`);
  return 0;
}

// ---- append --------------------------------------------------------------------------------------------------

function parseJsonArg(text, flag) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new LedgerError(`${flag} is not JSON: ${error.message}`);
  }
}

function readArgFile(file, flag) {
  try {
    return fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (error) {
    throw new LedgerError(`cannot read ${flag} ${file}: ${error.code ?? error.message}`);
  }
}

// A workflow file ({name, steps: [{duty, when?, instructions, onFail?}]}) and placement's answers to its questions
// become the task.workflow data: ordinals 1..n in file order, onFail.goto as an ordinal (a duty name goes to the
// nearest earlier step with that duty), and skipped = the steps whose when is jev:<id> and whose answer is false.
export function resolveWorkflow(file, answers = {}, info = null) {
  if (!file || !Array.isArray(file.steps) || file.steps.length === 0) throw new LedgerError('the workflow file has no steps');
  const steps = file.steps.map((s, index) => ({
    ordinal: index + 1,
    duty: s.duty,
    instructions: String(s.instructions ?? ''),
    when: s.when ?? null,
    onFail: null,
    _onFail: s.onFail ?? null,
  }));
  for (const s of steps) {
    const fail = s._onFail;
    delete s._onFail;
    if (!fail) continue;
    let goto = fail.goto;
    if (typeof goto === 'string') {
      const earlier = steps.filter((t) => t.ordinal < s.ordinal && t.duty === goto);
      if (!earlier.length) throw new LedgerError(`step ${s.ordinal}: onFail goes to "${goto}", which no earlier step is`);
      goto = earlier[earlier.length - 1].ordinal;
    }
    s.onFail = { goto, maxLoops: fail.maxLoops };
  }
  const questions = {};
  const skipped = [];
  for (const s of steps) {
    const rule = /^jev:([A-Za-z0-9_.:-]+)$/.exec(s.when ?? '');
    if (s.when && !rule) throw new LedgerError(`step ${s.ordinal}: when "${s.when}" is not jev:<question>`);
    if (!rule) continue;
    const answer = answers[rule[1]];
    if (typeof answer !== 'boolean') throw new LedgerError(`step ${s.ordinal} depends on ${rule[1]}; give placement's answer in --answers`);
    questions[rule[1]] = answer;
    if (answer === false) skipped.push(s.ordinal);
  }
  if (info?.created?.data?.kind === 'single') throw new LedgerError('a single task has no workflow file; use --add-step for an extra step');
  return { steps, skipped, questions, source: file.name ?? null };
}

// The current steps (a single task's one step, or the recorded workflow) plus one more at the next ordinal: the
// extra verify step of verify-then-land.
export function addStep(info, extra) {
  if (!extra || !ledgerDuties().includes(extra.duty)) throw new LedgerError(`--add-step needs {"duty", "instructions"} with a duty of ${ledgerDuties().join(', ')}`);
  const created = info.created.data ?? {};
  const line = [...info.events].reverse().find((e) => e.kind === 'task.workflow');
  const base = line?.data ?? { steps: [{ ordinal: 1, duty: created.duty, instructions: '', when: null, onFail: null }], skipped: [], questions: {} };
  const next = Math.max(...base.steps.map((s) => s.ordinal)) + 1;
  return { ...base, steps: [...base.steps, { ordinal: next, duty: extra.duty, instructions: String(extra.instructions ?? ''), when: null, onFail: null }], added: next };
}

function ledgerDuties() {
  return DUTIES;
}

function validateHandData(kind, data, step, info) {
  const need = (cond, message) => {
    if (!cond) throw new LedgerError(`${kind}: ${message}`);
  };
  switch (kind) {
    case 'note':
      need(typeof data.text === 'string' && data.text.trim(), 'data.text is required');
      break;
    case 'step.message':
      need(['owner', 'coordinator'].includes(data.direction), 'data.direction must be owner or coordinator');
      need(typeof data.text === 'string' && data.text.trim(), 'data.text is required');
      need(step, '--step is required');
      break;
    case 'task.workflow': {
      need(Array.isArray(data.steps) && data.steps.length > 0, 'data.steps must be a non-empty list');
      const seen = new Set();
      for (const s of data.steps) {
        need(Number.isInteger(s.ordinal) && s.ordinal > 0 && !seen.has(s.ordinal), 'every step needs a unique positive ordinal');
        seen.add(s.ordinal);
        need(DUTIES.includes(s.duty), `step ${s.ordinal}: duty must be one of ${DUTIES.join(', ')}`);
        need(typeof s.instructions === 'string', `step ${s.ordinal}: instructions must be a text`);
        if (s.onFail !== undefined && s.onFail !== null) {
          need(Number.isInteger(s.onFail.goto) && Number.isInteger(s.onFail.maxLoops), `step ${s.ordinal}: onFail needs goto and maxLoops`);
        }
      }
      need(Array.isArray(data.skipped ?? []), 'data.skipped must be a list of ordinals');
      for (const ordinal of data.skipped ?? []) need(seen.has(ordinal), `skipped step ${ordinal} is not in steps`);
      if (info.created.data?.kind === 'single') {
        const first = data.steps.find((s) => s.ordinal === 1);
        need(first && first.duty === info.created.data.duty, `a single task's workflow keeps step 1 as its ${info.created.data.duty} step`);
      }
      break;
    }
    case 'step.done':
    case 'step.failed':
      need(step, '--step is required');
      if (kind === 'step.failed') need(typeof data.reason === 'string' && data.reason.trim(), 'data.reason is required');
      break;
    case 'step.retrying':
      need(step, '--step is required');
      need(Number.isInteger(data.attempt) && data.attempt > 0, 'data.attempt must be a positive integer');
      need(Number.isInteger(data.gotoOrdinal) && data.gotoOrdinal > 0, 'data.gotoOrdinal must be a positive integer');
      need(typeof data.reason === 'string' && data.reason.trim(), 'data.reason is required');
      break;
    default:
  }
}

// The newest step.started of the task when its worker may still be running: its pid is alive and no step.lost was
// recorded for it (step.lost is written only after its pid was seen gone, so a live pid now is another process).
function liveStart(info) {
  const newest = [...info.events].reverse().find((e) => e.kind === 'step.started');
  if (!newest || !pidAlive(newest.data?.pid)) return null;
  const lost = info.events.some((e) => e.kind === 'step.lost' && e.step === newest.step && e.seq > newest.seq);
  return lost ? null : newest;
}

// step.retrying applies the workflow's onFail rule and nothing else: the step is in the recorded workflow and not
// skipped, its onFail goes back to gotoOrdinal, it ended in a failure since it last started (step.failed,
// step.lost, a blocked report or failing tests), and it has retries left. A failed or lost step without onFail is
// not retried; it is placed and started again.
function retryGuard(info, step, data, view) {
  const created = info.created.data ?? {};
  const line = [...info.events].reverse().find((e) => e.kind === 'task.workflow');
  if (!line && created.kind !== 'single') throw new LedgerError(`task ${info.created.task} has no recorded workflow; there is no onFail rule to apply`);
  const steps = line?.data?.steps ?? [{ ordinal: 1, duty: created.duty, onFail: null }];
  const spec = steps.find((s) => s.ordinal === step);
  if (!spec) throw new LedgerError(`step ${step} is not in the task's workflow`);
  if ((line?.data?.skipped ?? []).includes(step)) throw new LedgerError(`step ${step} is skipped in the task's workflow`);
  if (!spec.onFail) {
    throw new LedgerError(`step ${step} has no onFail in the workflow, so it is not retried with step.retrying: a failed or lost step without onFail is placed and started again (the placement skill, then the runtime skill)`);
  }
  if (spec.onFail.goto !== data.gotoOrdinal) {
    throw new LedgerError(`step ${step}'s onFail goes back to step ${spec.onFail.goto}, not ${data.gotoOrdinal}`);
  }
  if (!view.started) {
    const reset = resetFor(resetPoints(info.events), step) > 0;
    throw new LedgerError(`step ${step} has not run ${reset ? 'since the last retry reset it' : 'yet'}; there is nothing to retry`);
  }
  const end = view.end;
  if (!end) throw new LedgerError(`step ${step} has not ended since it last started; wait for its report`);
  const failure = end.kind === 'step.failed' || end.kind === 'step.lost'
    || (end.kind === 'step.report' && (end.data?.status === 'blocked' || end.data?.testsRun?.passed === false));
  if (!failure) {
    const what = end.kind === 'step.report' ? `a ${end.data?.status ?? 'unknown'} report` : end.kind;
    throw new LedgerError(`step ${step} ended with ${what}; step.retrying follows a failed or lost step, a blocked report or failing tests`);
  }
  const max = spec.onFail.maxLoops;
  if (!Number.isInteger(max)) throw new LedgerError(`step ${step}'s onFail has no maxLoops`);
  const used = info.events.filter((e) => e.kind === 'step.retrying' && e.step === step).length;
  if (used >= max) throw new LedgerError(`step ${step} already retried ${used} of ${max} times; tell the owner`);
}

// Guards that need the task's current lines; run inside the ledger lock.
function guard(kind, step, data, force) {
  return (events) => {
    const info = findTask(events, data.__task);
    if (!info) return;
    const view = step ? stepView(info.events, step, resetFor(resetPoints(info.events), step)) : null;
    if (kind === 'task.workflow' && !force && info.events.some((e) => e.kind === 'task.workflow')) {
      throw new LedgerError('the task already has a workflow; append with --force to replace it');
    }
    if (kind === 'step.done' && !force) {
      const report = view?.end?.kind === 'step.report' ? view.end : null;
      if (!report) throw new LedgerError(`step ${step} has no report since it last started; wait for it`);
      if (report.data?.status !== 'done') throw new LedgerError(`step ${step} reported ${report.data?.status}, not done`);
      if (report.data?.testsRun?.passed === false) {
        throw new LedgerError(`step ${step} reported failing tests (${report.data.testsRun.command}); apply the workflow's retry rule instead`);
      }
      if (view.done) throw new LedgerError(`step ${step} is already done`);
    }
    // Never beside a live worker, with --force or without: ending its start would let a second worker start next to
    // it, and the next step or retry would run while it still changes the worktree.
    if (kind === 'step.failed' || kind === 'step.retrying') {
      const live = liveStart(info);
      if (live) {
        throw new LedgerError(`step ${live.step} of ${info.created.task} is still running (pid ${live.data.pid}); stop it with the runtime skill's stop script, or wait until its process has exited, then append again`);
      }
    }
    if (kind === 'step.retrying' && !force) retryGuard(info, step, data, view);
  };
}

function append(argv) {
  const { values, positionals } = parse(argv, {
    task: { type: 'string' },
    step: { type: 'string' },
    session: { type: 'string' },
    data: { type: 'string' },
    'data-file': { type: 'string' },
    'from-workflow': { type: 'string' },
    answers: { type: 'string' },
    'add-step': { type: 'string' },
    'if-last-seq': { type: 'string' },
    force: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const kind = positionals[0];
  if (!KINDS.includes(kind)) throw new LedgerError(`unknown event kind "${kind}"; the kinds are ${KINDS.join(', ')}`);
  if (!HAND_KINDS.includes(kind)) {
    throw new LedgerError(`${kind} is written by the skills' scripts and hooks, not by hand; a session appends only ${HAND_KINDS.join(', ')}`);
  }
  const ifLastSeq = lastSeqOption(values['if-last-seq'], values.task);
  const given = ['data', 'data-file', 'from-workflow', 'add-step'].filter((k) => values[k] !== undefined);
  if (given.length > 1) throw new LedgerError(`give one of --${given.join(', --')}`);
  if ((values['from-workflow'] !== undefined || values['add-step'] !== undefined) && kind !== 'task.workflow') {
    throw new LedgerError('--from-workflow and --add-step are for task.workflow only');
  }
  let data = {};
  if (values.data !== undefined) data = parseJsonArg(values.data, '--data');
  if (values['data-file'] !== undefined) data = parseJsonArg(readArgFile(values['data-file'], '--data-file'), '--data-file');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LedgerError('--data must be a JSON object');
  const step = values.step === undefined ? undefined : Number(values.step);
  if (step !== undefined && !(Number.isInteger(step) && step > 0)) throw new LedgerError('--step must be a positive integer');
  const at = root();
  const { events } = readEvents(at);
  let info = null;
  if (kind !== 'note' || values.task !== undefined) {
    if (values.task === undefined) throw new LedgerError(`${kind} needs --task`);
    info = requireTask(events, values.task);
  }
  if (values['from-workflow'] !== undefined) {
    const answers = values.answers === undefined ? {} : parseJsonArg(values.answers.trim().startsWith('{') ? values.answers : readArgFile(values.answers, '--answers'), '--answers');
    data = resolveWorkflow(parseJsonArg(readArgFile(values['from-workflow'], '--from-workflow'), '--from-workflow'), answers, info);
  }
  if (values['add-step'] !== undefined) data = addStep(info, parseJsonArg(values['add-step'], '--add-step'));
  validateHandData(kind, data, step, info);
  if (['step.done', 'step.failed'].includes(kind) && data.ordinal === undefined) data.ordinal = step;
  if (kind === 'step.retrying' && data.ordinal === undefined) data.ordinal = step;
  if (kind === 'step.done' && values.force) data.forced = true;
  const checks = [unchangedOption(values.task, ifLastSeq), guard(kind, step, { ...data, __task: values.task }, values.force)].filter(Boolean);
  const event = appendEvent(at, {
    kind,
    task: values.task,
    step,
    session: values.session ?? process.env.JH_SESSION,
    data,
  }, { check: (events) => checks.forEach((check) => check(events)) });
  print(values.json, event, oneLine(event));
  return 0;
}

// --if-last-seq N: the append happens only when the task's newest line is still #N, the one the caller read before it
// checked its own guards; otherwise exit 6 and nothing is written. The task must be named.
function lastSeqOption(text, task) {
  if (text === undefined) return null;
  const seq = Number(text);
  if (!(Number.isInteger(seq) && seq > 0)) throw new LedgerError('--if-last-seq must be a positive integer (the lastSeq that show --json printed)');
  if (task === undefined) throw new LedgerError('--if-last-seq needs --task');
  return seq;
}

function unchangedOption(task, seq) {
  return seq === null ? null : unchangedSince(task, seq);
}

// ---- record (the scripts of other skills) -----------------------------------------------------------------------

// Appends one of the kinds the skills' scripts own, for a script that reaches this skill as a process. What the line
// means is the calling script's business and its guards are its own: it reads the task (show --json), decides, and
// appends with --if-last-seq, so a line written by anyone else in between refuses the append (exit 6) and the script
// reads again. This command checks only the shape: a known kind, an existing task, a step for the step kinds.
function record(argv) {
  const { values, positionals } = parse(argv, {
    task: { type: 'string' },
    step: { type: 'string' },
    session: { type: 'string' },
    data: { type: 'string' },
    'data-file': { type: 'string' },
    'if-last-seq': { type: 'string' },
    json: { type: 'boolean' },
  });
  const kind = positionals[0];
  if (positionals.length !== 1) throw new LedgerError('record takes one event kind');
  if (!KINDS.includes(kind)) throw new LedgerError(`unknown event kind "${kind}"; the kinds are ${KINDS.join(', ')}`);
  if (!RECORD_KINDS.includes(kind)) {
    throw new LedgerError(kind === 'task.created' ? 'task.created is written by task create' : `${kind} is ${HAND_KINDS.includes(kind) ? 'appended with append, which checks it' : 'written by this skill alone'}; record takes ${RECORD_KINDS.join(', ')}`);
  }
  if (values.task === undefined) throw new LedgerError(`${kind} needs --task`);
  if (values.data !== undefined && values['data-file'] !== undefined) throw new LedgerError('give --data or --data-file, not both');
  let data = {};
  if (values.data !== undefined) data = parseJsonArg(values.data, '--data');
  if (values['data-file'] !== undefined) data = parseJsonArg(readArgFile(values['data-file'], '--data-file'), '--data-file');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LedgerError('--data must be a JSON object');
  const step = values.step === undefined ? undefined : Number(values.step);
  if (step !== undefined && !(Number.isInteger(step) && step > 0)) throw new LedgerError('--step must be a positive integer');
  if (kind.startsWith('step.') && step === undefined) throw new LedgerError(`${kind} needs --step`);
  const ifLastSeq = lastSeqOption(values['if-last-seq'], values.task);
  const at = root();
  requireTask(readEvents(at).events, values.task);
  const event = appendEvent(at, { kind, task: values.task, step, session: values.session ?? process.env.JH_SESSION, data }, {
    check: (events) => {
      if (!findTask(events, values.task)) throw new LedgerError(`no task ${values.task} in this project's ledger`, 3);
      unchangedOption(values.task, ifLastSeq)?.(events);
    },
  });
  print(values.json, event, oneLine(event));
  return 0;
}

// ---- the coordinator's own questions to the owner ------------------------------------------------------------------

// A question from the coordinator (not landing's "Land now" / "Leave it", which land.mjs records) is a task.asked line
// with source "coordinator". It must stand on its own for an owner who has forgotten the task: its text and the
// options' meanings together are at most QUESTION_WORDS words, it has two to four options each saying what it means
// for the owner, and it names the option it recommends, which is also what the coordinator does when the owner's reply
// does not choose. A task has at most one open question: the next one waits for `answer`.
export const QUESTION_WORDS = 120;
const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;

// Code and internal names an owner cannot be expected to read: backticks, an HTTP method with a path, a file path,
// snake_case or camelCase identifiers, commit hashes. Links (http, https) are fine: the owner can open them.
export function codeTerms(text) {
  const plain = String(text ?? '').replace(/https?:\/\/\S+/g, ' ');
  const found = new Set();
  const add = (re) => {
    for (const m of plain.matchAll(re)) found.add(m[0].trim());
  };
  add(/`[^`]*`/g);
  add(/\b(GET|POST|PUT|PATCH|DELETE)\s+\/\S*/g);
  add(/(?<![\w@])(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,5}\b/gi);
  add(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g);
  add(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g);
  add(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/g);
  return [...found];
}

export function openQuestion(events) {
  const asked = [...events].reverse().find((e) => e.kind === 'task.asked' && e.data?.source === 'coordinator');
  if (!asked) return null;
  const answered = events.some((e) => e.seq > asked.seq && e.kind === 'note' && e.data?.answerTo === asked.seq);
  return answered ? null : asked;
}

export function checkQuestion(data) {
  const bad = (message) => {
    throw new LedgerError(`ask: ${message}`);
  };
  if (!data || typeof data !== 'object' || Array.isArray(data)) bad('give one JSON object {question, options, recommended, reason}');
  const extra = Object.keys(data).find((k) => !['question', 'options', 'recommended', 'reason'].includes(k));
  if (extra) bad(`unknown field "${extra}"`);
  if (typeof data.question !== 'string' || !data.question.trim()) bad('question is required: one or two plain sentences on what the task is and why, then the question');
  if (!Array.isArray(data.options) || data.options.length < 2 || data.options.length > 4) bad('options must have 2 to 4 items');
  const labels = new Set();
  for (const [i, o] of data.options.entries()) {
    if (!o || typeof o !== 'object' || typeof o.label !== 'string' || !o.label.trim() || o.label.length > 120) bad(`options[${i}].label must be a short text`);
    if (typeof o.means !== 'string' || !o.means.trim() || o.means.length > 300) bad(`options[${i}].means must say what the option means for the owner`);
    if (Object.keys(o).some((k) => !['label', 'means'].includes(k))) bad(`options[${i}] takes label and means only`);
    if (labels.has(o.label)) bad(`options[${i}].label repeats another option's label`);
    labels.add(o.label);
  }
  if (!labels.has(data.recommended)) bad('recommended must be one of the options\' labels: the option you recommend, which you take when the reply does not choose');
  if (!data.question.includes(data.recommended)) bad(`the question must say, in its own words, that "${data.recommended}" is what happens when the owner's reply does not choose: name that option's label in it`);
  if (data.reason !== undefined && (typeof data.reason !== 'string' || data.reason.length > 300)) bad('reason must be a short text');
  const jargon = codeTerms([data.question, ...data.options.flatMap((o) => [o.label, o.means])].join('\n'));
  if (jargon.length) bad(`the question uses code or internal names (${jargon.slice(0, 4).join(', ')}): say what each is in plain words for an owner who has forgotten the task`);
  const total = words(data.question) + data.options.reduce((n, o) => n + words(o.label) + words(o.means), 0);
  if (total > QUESTION_WORDS) bad(`the question and its options are ${total} words; keep them under ${QUESTION_WORDS}`);
  return { question: data.question.trim(), options: data.options.map((o) => o.label), meanings: Object.fromEntries(data.options.map((o) => [o.label, o.means])), recommended: data.recommended, reason: data.reason ?? '', source: 'coordinator', words: total };
}

function ask(argv) {
  const { values } = parse(argv, { task: { type: 'string' }, data: { type: 'string' }, 'data-file': { type: 'string' }, json: { type: 'boolean' } }, { allowPositionals: false });
  if (values.task === undefined) throw new LedgerError('ask needs --task');
  if ((values.data === undefined) === (values['data-file'] === undefined)) throw new LedgerError('give --data or --data-file');
  const raw = values.data !== undefined ? parseJsonArg(values.data, '--data') : parseJsonArg(readArgFile(values['data-file'], '--data-file'), '--data-file');
  const data = checkQuestion(raw);
  const at = root();
  requireTask(readEvents(at).events, values.task);
  const event = appendEvent(at, { kind: 'task.asked', task: values.task, session: process.env.JH_SESSION, data }, {
    check: (events) => {
      const info = findTask(events, values.task);
      if (!info) throw new LedgerError(`no task ${values.task} in this project's ledger`, 3);
      const open = openQuestion(info.events);
      if (open) throw new LedgerError(`${values.task} already has an open question (#${open.seq}: ${open.data.question.slice(0, 120)}); record the owner's answer with answer before asking again`);
    },
  });
  print(values.json, event, oneLine(event));
  return 0;
}

function answer(argv) {
  const { values } = parse(argv, { task: { type: 'string' }, text: { type: 'string' }, option: { type: 'string' }, json: { type: 'boolean' } }, { allowPositionals: false });
  if (values.task === undefined) throw new LedgerError('answer needs --task');
  if (typeof values.text !== 'string' || !values.text.trim()) throw new LedgerError('answer needs --text: what the owner said');
  const at = root();
  requireTask(readEvents(at).events, values.task);
  // The answer names the question it answers, which is only known inside the lock: check() fills the line's data.
  const input = { kind: 'note', task: values.task, session: process.env.JH_SESSION, data: {} };
  const event = appendEvent(at, input, {
    check: (events) => {
      const info = findTask(events, values.task);
      const open = info ? openQuestion(info.events) : null;
      if (!open) throw new LedgerError(`${values.task} has no open question from the coordinator to answer`);
      if (values.option !== undefined && !(open.data.options ?? []).includes(values.option)) {
        throw new LedgerError(`--option must be one of ${(open.data.options ?? []).join(', ')}`);
      }
      input.data = { text: `The owner answered #${open.seq}: ${values.text.trim()}`, answerTo: open.seq, option: values.option ?? null, answer: values.text.trim() };
    },
  });
  print(values.json, event, oneLine(event));
  return 0;
}

// ---- events (the scripts of other skills) -----------------------------------------------------------------------

// The ledger's lines as data, optionally only some tasks' or some kinds', after a seq: {lastSeq, events}. lastSeq is
// the newest seq of the whole ledger.
function events(argv) {
  const { values } = parse(argv, { task: { type: 'string', multiple: true }, kind: { type: 'string', multiple: true }, since: { type: 'string' }, json: { type: 'boolean' } }, { allowPositionals: false });
  for (const kind of values.kind ?? []) if (!KINDS.includes(kind)) throw new LedgerError(`unknown event kind "${kind}"`);
  for (const id of values.task ?? []) if (!isTaskId(id)) throw new LedgerError(`"${id}" is not a task id (T and six characters)`);
  const since = values.since === undefined ? 0 : Number(values.since);
  if (!(Number.isInteger(since) && since >= 0)) throw new LedgerError('--since must be a seq (0 or more)');
  const all = readEvents(root()).events;
  const lastSeq = all.reduce((m, e) => (Number.isInteger(e.seq) && e.seq > m ? e.seq : m), 0);
  const chosen = all.filter((e) => (!values.task || values.task.includes(e.task)) && (!values.kind || values.kind.includes(e.kind)) && (e.seq ?? 0) > since);
  print(values.json, { lastSeq, events: chosen }, chosen.map(oneLine).join('\n') || '(no lines)');
  return 0;
}

// ---- take-report (runtimes without a Stop hook) --------------------------------------------------------------------

// What the Stop hook does for a Claude worker, for a runtime whose agent has no hook (Codex), called once its turn's
// process has ended: <cwd>/.jevellan/report.json becomes step.report and moves to .jevellan/reports/; an invalid one
// becomes a blocked report with the problem in limitations; none becomes a blocked report marked synthesized. Then
// session.ended. The line is appended before the file moves, so a refused line leaves the report where it was.
function takeReport(argv) {
  const { values } = parse(argv, {
    task: { type: 'string' },
    step: { type: 'string' },
    session: { type: 'string' },
    cwd: { type: 'string' },
    'native-session': { type: 'string' },
    ended: { type: 'string' },
    json: { type: 'boolean' },
  }, { allowPositionals: false });
  if (values.task === undefined) throw new LedgerError('--task is required');
  const step = Number(values.step);
  if (!(Number.isInteger(step) && step > 0)) throw new LedgerError('--step must be a positive integer');
  if (!values.session) throw new LedgerError('--session is required');
  if (!values.cwd || !path.isAbsolute(values.cwd)) throw new LedgerError('--cwd must be the step\'s folder, an absolute path');
  const at = root();
  requireTask(readEvents(at).events, values.task);
  const ended = (values.ended ?? '').replace(/\s+/g, ' ').trim() || 'the session ended';
  const file = path.join(values.cwd, '.jevellan', 'report.json');
  const read = readReportFile(file);
  const data = read ? read.data : { status: 'blocked', summary: 'No report was written.', synthesized: true, limitations: `${ended} and no .jevellan/report.json` };
  const ctx = { task: values.task, step, session: values.session };
  let moveError = null;
  const event = recordReport(at, ctx, data, { file: read ? file : null, suffix: read?.suffix ?? '', onMoveError: (error, from, to) => { moveError = `${from} could not be moved to ${to}: ${error?.message ?? error}`; } });
  // What went wrong after the line was written is told in the output (warnings) as well as on stderr, so a caller that
  // reads only the JSON still has it for its own log.
  const warnings = [];
  if (moveError) warnings.push(`report recorded, but ${moveError}`);
  let endedEvent = null;
  try {
    endedEvent = appendEvent(at, { kind: 'session.ended', task: values.task, step, session: values.session, data: { nativeSessionId: values['native-session'] ?? null, reason: `${ended} with a ${data.status} report` } });
  } catch (error) {
    warnings.push(`session.ended not recorded: ${error?.message ?? error}`);
  }
  for (const warning of warnings) process.stderr.write(`${values.task} s${step}: ${warning}\n`);
  const out = { task: values.task, step, seq: event.seq, status: event.data.status, synthesized: Boolean(event.data.synthesized), reportFile: event.data.reportFile ?? null, sessionEndedSeq: endedEvent?.seq ?? null, warnings };
  print(values.json, out, `${values.task} step ${step}: ${out.status} report recorded (#${event.seq})${out.synthesized ? ', synthesized' : ''}.`);
  return 0;
}

// ---- status --------------------------------------------------------------------------------------------------

function status(argv) {
  const { values } = parse(argv, { brief: { type: 'boolean' }, json: { type: 'boolean' } }, { allowPositionals: false });
  const at = root();
  const view = statusView(at);
  if (values.json) {
    print(true, values.brief ? { ...view, tasks: view.tasks.slice(0, 5) } : view);
    return 0;
  }
  if (values.brief) {
    const lines = briefLines(view);
    if (lines.length) print(false, null, lines.join('\n'));
    return 0;
  }
  const out = [];
  if (!view.tasks.length) out.push('No open tasks.');
  for (const state of Object.keys(ORDER)) {
    const group = view.tasks.filter((t) => t.state === state);
    if (!group.length) continue;
    out.push(`${HEADINGS[state]}:`);
    for (const task of group) out.push(describe(task));
  }
  if (view.recent.length) {
    out.push('Finished in the last 24 hours:');
    for (const r of view.recent) out.push(`  ${r.task}  ${r.title} (${r.state}${r.pr ? `, pull request ${r.pr}` : r.commit ? `, ${r.commit.slice(0, 7)}` : ''})`);
  }
  for (const l of view.lost) out.push(`Marked lost: ${l.task} step ${l.step} (#${l.seq})`);
  print(false, null, out.join('\n'));
  return 0;
}

// ---- show, report --------------------------------------------------------------------------------------------

function show(argv) {
  const { values, positionals } = parse(argv, { json: { type: 'boolean' } });
  const at = root();
  const { events } = readEvents(at);
  const info = requireTask(events, positionals[0]);
  const view = projectTask(info);
  if (values.json) {
    print(true, { ...view, text: info.created.data?.text, lastSeq: lastSeqOf(info), views: stepViews(info), events: info.events });
    return 0;
  }
  const out = [`${view.task} ${view.title}`, `kind ${view.kind}${view.duty ? ` ${view.duty}` : ''}, state ${view.state}${view.reason ? ` (${view.reason})` : ''}`];
  out.push('', 'Brief:', info.created.data?.text ?? '', '', 'Events:');
  for (const event of info.events) {
    if (event.kind === 'step.report') out.push(`#${event.seq} ${event.t} step.report s${event.step}`, renderReport(event).replace(/^/gm, '    '));
    else out.push(oneLine(event));
  }
  print(false, null, out.join('\n'));
  return 0;
}

function report(argv) {
  const { values, positionals } = parse(argv, { step: { type: 'string' }, json: { type: 'boolean' } });
  const at = root();
  const { events } = readEvents(at);
  requireTask(events, positionals[0]);
  const step = values.step === undefined ? undefined : Number(values.step);
  const event = latestReport(events, positionals[0], step);
  if (!event) throw new LedgerError(`no report for ${positionals[0]}${step ? ` step ${step}` : ''} yet`, 3);
  // A report is JSON by contract; --json only adds nothing here, so both forms print the same object.
  print(true, { task: event.task, step: event.step, seq: event.seq, t: event.t, session: event.session, ...event.data });
  return 0;
}

// ---- wait ----------------------------------------------------------------------------------------------------

function endOfStep(info, step) {
  const ordinal = step ?? currentOrdinal(info);
  if (!ordinal) return { ordinal: null, view: null };
  const view = stepView(info.events, ordinal, resetFor(resetPoints(info.events), ordinal));
  return { ordinal, view };
}

// The highest ordinal with a start that no step.retrying reset since, the projection's current step: after a retry
// back to an earlier step, the later steps' old starts do not count.
function currentOrdinal(info) {
  const resets = resetPoints(info.events);
  const started = info.events
    .filter((e) => e.kind === 'step.started' && Number.isInteger(e.step) && e.seq > resetFor(resets, e.step))
    .map((e) => e.step);
  return started.length ? Math.max(...started) : null;
}

function wait(argv) {
  const { values } = parse(argv, { task: { type: 'string' }, step: { type: 'string' }, timeout: { type: 'string' }, json: { type: 'boolean' } }, { allowPositionals: false });
  if (!values.task) throw new LedgerError('wait needs --task T');
  const step = values.step === undefined ? undefined : Number(values.step);
  if (step !== undefined && !(Number.isInteger(step) && step > 0)) throw new LedgerError('--step must be a positive integer');
  const timeoutS = values.timeout === undefined ? 7200 : Number(values.timeout);
  if (!(timeoutS > 0)) throw new LedgerError('--timeout must be a positive number of seconds');
  const at = root();
  const file = projectPaths(at).ledger;
  const deadline = Date.now() + timeoutS * 1000;
  let fixedStep = step;
  let lastSize = -1;
  let lastAliveCheck = 0;
  for (;;) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    const now = Date.now();
    if (size !== lastSize || now - lastAliveCheck >= 2000) {
      lastSize = size;
      const { events } = readEvents(at);
      const info = requireTask(events, values.task);
      const { ordinal, view } = endOfStep(info, fixedStep);
      if (ordinal && fixedStep === undefined && view?.started) fixedStep = ordinal;
      if (view?.end) return finishWait(view.end, values.json);
      if (view?.started && now - lastAliveCheck >= 2000) {
        lastAliveCheck = now;
        const pid = view.started.data?.pid;
        if (Number.isInteger(pid) && !pidAlive(pid)) {
          projectAll(at); // appends step.lost under the lock when it is still true
          continue;
        }
      }
    }
    if (Date.now() >= deadline) {
      print(values.json, { timeout: true, task: values.task, step: fixedStep ?? null }, `Timed out after ${timeoutS} s waiting for ${values.task}${fixedStep ? ` step ${fixedStep}` : ''}.`);
      return 5;
    }
    sleepMs(500);
  }
}

function finishWait(event, json) {
  if (event.kind === 'step.report') {
    print(json, { kind: event.kind, task: event.task, step: event.step, seq: event.seq, ...event.data }, renderReport(event));
    return 0;
  }
  print(json, { kind: event.kind, task: event.task, step: event.step, seq: event.seq, ...event.data }, oneLine(event));
  return 4;
}

// ---- tail, verify --------------------------------------------------------------------------------------------

function tail(argv) {
  const { values } = parse(argv, { follow: { type: 'boolean' }, task: { type: 'string' }, json: { type: 'boolean' }, lines: { type: 'string' } }, { allowPositionals: false });
  const at = root();
  const file = projectPaths(at).ledger;
  const show = (event) => {
    if (values.task && event.task !== values.task) return;
    process.stdout.write(values.json ? `${JSON.stringify(event)}\n` : `${oneLine(event)}\n`);
  };
  const count = values.lines === undefined ? 40 : Number(values.lines);
  const { events } = readEvents(at);
  const chosen = events.filter((e) => !values.task || e.task === values.task);
  for (const event of chosen.slice(-count)) show(event);
  if (!values.follow) return 0;
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {}
  let carry = '';
  for (;;) {
    sleepMs(500);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size <= offset) continue;
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    fs.closeSync(fd);
    offset = size;
    const text = carry + buffer.toString('utf8');
    const parts = text.split('\n');
    carry = parts.pop();
    for (const line of parts) {
      if (!line.trim()) continue;
      try {
        show(JSON.parse(line));
      } catch {}
    }
  }
}

function verify(argv) {
  const { values } = parse(argv, { json: { type: 'boolean' } }, { allowPositionals: false });
  const result = verifyLedger(root());
  print(values.json, result, result.ok ? `ok: ${result.lines} lines, seq contiguous` : `problems:\n${result.issues.map((i) => `  ${i}`).join('\n')}`);
  return result.ok ? 0 : 2;
}

// ---- main ----------------------------------------------------------------------------------------------------

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'task':
      if (rest[0] === 'create') return taskCreate(rest.slice(1));
      throw new LedgerError(`unknown task command "${rest[0] ?? ''}"\n${USAGE}`);
    case 'append':
      return append(rest);
    case 'status':
      return status(rest);
    case 'show':
      return show(rest);
    case 'report':
      return report(rest);
    case 'wait':
      return wait(rest);
    case 'tail':
      return tail(rest);
    case 'verify':
      return verify(rest);
    case 'record':
      return record(rest);
    case 'ask':
      return ask(rest);
    case 'answer':
      return answer(rest);
    case 'events':
      return events(rest);
    case 'take-report':
      return takeReport(rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return command ? 0 : 2;
    default:
      throw new LedgerError(`unknown command "${command}"\n${USAGE}`);
  }
}

if (isMain(import.meta.url)) run(main);
