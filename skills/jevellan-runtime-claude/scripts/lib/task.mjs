// What every runtime skill's scripts share, identical in each of them: the ledger (reached through its role), the task
// and step as the ledger tells them, the guards every start and resume passes, and what the worker is told.

import fs from 'node:fs';
import path from 'node:path';
import { importFromRole, skillsWithRole } from './roles.mjs';
import { RuntimeError, harnessHome, findProvider, loadProvidersFile } from './common.mjs';
import { NO_TOOL_DUTIES, projectInstructions, systemAppend, taskBlock, workerRules } from './prompt.mjs';
import { killGroup, pidAlive, waitForExit } from './proc.mjs';

export const ledger = await importFromRole('ledger', 'scripts/lib/ledger.mjs');
export const projectLib = await importFromRole('ledger', 'scripts/lib/project.mjs');
export const ids = await importFromRole('ledger', 'scripts/lib/ids.mjs');
export const MAX_CONTINUES = 20;
// How long a start or resume waits for a worker whose turn the ledger already shows ended (its report is in, the
// process is still exiting) before it refuses.
export const EXIT_GRACE_MS = 3000;
export { RuntimeError } from './common.mjs';

// Mode 700: the logs hold the workers' raw output.
export function logsDir() {
  const dir = path.join(harnessHome(), 'logs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

export function rootFor(cwd) {
  const root = projectLib.projectRoot(cwd);
  if (!root) throw new RuntimeError(`${cwd} is not inside a git repository`);
  return root;
}

export function loadTask(root, task) {
  const { events } = ledger.readEvents(root);
  const info = ledger.findTask(events, task);
  if (!info) throw new RuntimeError(`no task ${task} in the ledger of ${root}`, 3);
  return info;
}

export function currentView(info, step) {
  return ledger.stepView(info.events, step, ledger.resetFor(ledger.resetPoints(info.events), step));
}

// The newest step.started of the task (of one step when `step` is given), by seq, whatever came after it: no
// retry reset and no end event hides it. Its pid is the worker that may still be running, because a report, a
// step.failed or a step.retrying is written by others and says nothing about whether the process has gone.
export function newestStart(info, step) {
  let newest = null;
  for (const event of info.events) {
    if (event.kind !== 'step.started' || (step !== undefined && event.step !== step)) continue;
    if (!newest || event.seq > newest.seq) newest = event;
  }
  return newest;
}

// The task's newest start when its pid is alive, else null. One worker per task at a time: every step of a task
// runs in the same worktree. A worker whose turn already ended in the ledger gets `graceMs` to exit first.
export function liveWorker(info, { graceMs = 0 } = {}) {
  const start = newestStart(info);
  const pid = start?.data?.pid;
  if (!pidAlive(pid)) return null;
  if (graceMs > 0 && ledger.stepView(info.events, start.step).end && waitForExit(pid, graceMs)) return null;
  return start;
}

export function assertNoLiveWorker(info, step, options) {
  const live = liveWorker(info, options);
  if (!live) return;
  const which = live.step === step ? `step ${step} of ${info.created.task} is running` : `step ${live.step} of ${info.created.task} is still running`;
  throw new RuntimeError(`${which} (pid ${live.data.pid}); wait for its report or stop it`);
}

// The guards of start.mjs again, inside the ledger lock on the lines as they are then (appendEvent's check), so two
// starts that both passed them before spawning cannot both record a start: nothing started this step since its
// placement, the task's newest worker is gone, the step is not done.
export function startCheck(task, step, placed) {
  return (events) => {
    const info = ledger.findTask(events, task);
    if (!info) throw new RuntimeError(`no task ${task} in the ledger`, 3);
    const other = info.events.find((e) => e.kind === 'step.started' && e.step === step && e.seq > placed.seq);
    if (other) throw new RuntimeError(`step ${step} of ${task} was started meanwhile on the same placement (pid ${other.data?.pid}); wait for its report or stop it`);
    assertNoLiveWorker(info, step);
    if (currentView(info, step).done) throw new RuntimeError(`step ${step} of ${task} is done`);
  };
}

// The guards of resume.mjs again, inside the ledger lock: the step's current start is still the one being resumed
// (no other start, resume or retry came in between), the task's newest worker is gone, the step is not done.
export function resumeCheck(task, step, started) {
  return (events) => {
    const info = ledger.findTask(events, task);
    if (!info) throw new RuntimeError(`no task ${task} in the ledger`, 3);
    const view = currentView(info, step);
    if (view.started?.seq !== started.seq) throw new RuntimeError(`step ${step} of ${task} was started, resumed or reset meanwhile; look at its status first`);
    assertNoLiveWorker(info, step);
    if (view.done) throw new RuntimeError(`step ${step} of ${task} is done`);
  };
}

// Appends the step.started of a process just spawned, under `check`; when the append is refused or fails, the
// process group is killed before the error goes on, so no worker runs without its start in the ledger.
export function appendStarted(root, input, check, pid) {
  try {
    return ledger.appendEvent(root, input, { check });
  } catch (error) {
    killGroup(pid);
    throw error;
  }
}

export function workflowOf(info) {
  const created = info.created.data ?? {};
  const line = [...info.events].reverse().find((e) => e.kind === 'task.workflow');
  if (created.kind === 'single' && !line) return { steps: [{ ordinal: 1, duty: created.duty, instructions: '' }], skipped: [] };
  return { steps: line?.data?.steps ?? [], skipped: line?.data?.skipped ?? [] };
}

export function worktreeOf(info) {
  return [...info.events].reverse().find((e) => e.kind === 'task.worktree')?.data ?? null;
}

// The duty skill's body, for the duties that run without tools (they cannot invoke the skill).
export function dutyBody(duty) {
  const skill = skillsWithRole('duty', { duty })[0];
  if (!skill) throw new RuntimeError(`no installed skill has the role duty (duty ${duty})`);
  return skill.body.trim();
}

export function assertDutyInstalled(duty) {
  if (!skillsWithRole('duty', { duty }).length) throw new RuntimeError(`no installed skill has the role duty (duty ${duty})`);
}

// The guard on quota: a step starts only on what placement chose for it, after its latest start.
export function requirePlacement(info, step, { provider, model, effort }) {
  const view = currentView(info, step);
  const after = view.started?.seq ?? ledger.resetFor(ledger.resetPoints(info.events), step);
  const placed = [...info.events].reverse().find((e) => e.kind === 'task.placed' && e.data?.step === step && e.seq > after);
  if (!placed) throw new RuntimeError(`step ${step} of ${info.created.task} has no placement since it last ran; use the placement skill first`);
  const d = placed.data;
  if (d.provider !== provider || d.model !== model || d.effort !== effort) {
    throw new RuntimeError(`step ${step} is placed on ${d.provider} ${d.model} ${d.effort}, not ${provider} ${model} ${effort}; start it as placed`);
  }
  return placed;
}

export function providerFor(name, model, effort) {
  const provider = findProvider(name, loadProvidersFile());
  const entry = provider.models.find((m) => m.id === model);
  if (!entry) throw new RuntimeError(`provider ${name} has no model ${model}`);
  if (!entry.efforts.includes(effort)) throw new RuntimeError(`model ${model} on ${name} has no effort ${effort} (${entry.efforts.join(', ')})`);
  return provider;
}

// Moves a report.json left by an earlier turn out of the way, so this turn's Stop hook never records it.
export function archiveStaleReport(root, cwd, task, step) {
  const file = path.join(cwd, '.jevellan', 'report.json');
  if (!fs.existsSync(file)) return null;
  const dir = projectLib.projectPaths(root).reports;
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${task}-s${step}-${ids.compactTime()}-stale.json`);
  fs.renameSync(file, target);
  return target;
}

export function buildTaskBlock(root, info, step, duty) {
  const created = info.created.data ?? {};
  const { steps, skipped } = workflowOf(info);
  const live = steps.filter((s) => !skipped.includes(s.ordinal));
  const position = Math.max(1, live.findIndex((s) => s.ordinal === step) + 1);
  const spec = steps.find((s) => s.ordinal === step);
  const earlier = [];
  let plan = false;
  for (const s of live) {
    if (s.ordinal >= step) continue;
    const v = currentView(info, s.ordinal);
    const report = v.lastReport;
    if (!report) continue;
    earlier.push({ duty: s.duty, status: report.data?.status ?? 'unknown', summary: report.data?.summary ?? '' });
    if (s.duty === 'plan' && report.data?.status === 'done') plan = true;
  }
  // On a retry the failure that sent the task back is told to the step.
  let failure = null;
  const retry = [...info.events].reverse().find((e) => e.kind === 'step.retrying' && e.data?.gotoOrdinal <= step);
  if (retry) {
    const failed = ledger.stepView(info.events, retry.step).lastReport;
    failure = `${retry.data?.reason ?? ''}${failed?.data?.summary ? ` Report of step ${retry.step}: ${failed.data.summary}` : ''}`;
  }
  return taskBlock({
    task: info.created.task,
    title: created.title,
    kind: created.kind,
    position,
    total: Math.max(live.length, position),
    duty,
    text: created.text,
    instructions: spec?.instructions ?? '',
    settings: projectLib.readProjectJson(root),
    earlier,
    plan,
    failure,
  });
}

// inlineDuty: the session cannot invoke the duty skill (no tools, or a runtime without Claude skills), so the duty
// skill's body goes into the append instead of the sentence that names it.
export function buildAppend(root, info, step, duty, cwd, blockText, { inlineDuty = NO_TOOL_DUTIES.includes(duty) } = {}) {
  const wt = worktreeOf(info);
  const projectJson = projectLib.readProjectJson(root);
  const rules = workerRules({
    project: projectJson.name ?? path.basename(root),
    cwd,
    branch: wt?.branch ?? '(none: this step has no worktree)',
    base: wt?.base ?? projectJson.defaultBranch ?? 'main',
    duty,
  });
  let text = systemAppend({ rules, duty, agents: projectInstructions(root), block: blockText });
  if (inlineDuty) {
    text = text.replace(
      `Your step is duty ${duty}. Use the duty skill for ${duty} now and follow it.`,
      `Your step is duty ${duty}. ${NO_TOOL_DUTIES.includes(duty) ? 'You have no tools, so the' : 'The'} duty's instructions follow here:\n\n${dutyBody(duty)}`,
    );
  }
  return text;
}

