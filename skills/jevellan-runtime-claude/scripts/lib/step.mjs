// What the runtime scripts share: the ledger (reached through its role), the task and step as the ledger tells them,
// the guards every start and resume passes, and the claude command line.

import fs from 'node:fs';
import path from 'node:path';
import { importFromRole, skillsWithRole } from './roles.mjs';
import { RuntimeError, harnessHome, findProvider, loadProvidersFile, nodeBinary, workerEnv, workerSettings } from './env.mjs';
import { NO_TOOL_DUTIES, READ_ONLY_DUTIES, dutyMode, projectInstructions, systemAppend, taskBlock, workerRules } from './prompt.mjs';

export const ledger = await importFromRole('ledger', 'scripts/lib/ledger.mjs');
export const projectLib = await importFromRole('ledger', 'scripts/lib/project.mjs');
export const ids = await importFromRole('ledger', 'scripts/lib/ids.mjs');
export const MAX_CONTINUES = 20;

export function logsDir() {
  const dir = path.join(harnessHome(), 'logs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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

export function buildAppend(root, info, step, duty, cwd, blockText) {
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
  if (NO_TOOL_DUTIES.includes(duty)) {
    text = text.replace(
      `Your step is duty ${duty}. Use the duty skill for ${duty} now and follow it.`,
      `Your step is duty ${duty}. You have no tools, so the duty's instructions follow here:\n\n${dutyBody(duty)}`,
    );
  }
  return text;
}

// The claude command line for a turn. The prompt always follows "--" (H-005).
export function claudeArgs({ duty, session, resume = false, model, effort, appendFile, prompt }) {
  const mode = dutyMode(duty);
  const args = ['-p', resume ? '--resume' : '--session-id', session, '--model', model, '--effort', effort];
  if (mode === 'write') {
    args.push('--permission-mode', 'bypassPermissions');
  } else if (mode === 'no-tools') {
    args.push('--max-turns', '1', '--tools', '');
  } else {
    const writes = ['./.jevellan/report.json', ...(mode === 'plan' ? ['./plan.md'] : [])];
    args.push(
      '--permission-mode', 'dontAsk',
      '--tools', 'Read,Glob,Grep,WebSearch,WebFetch,Skill,Write,Edit',
      '--allowedTools', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill',
      ...writes.flatMap((file) => [`Write(${file})`, `Edit(${file})`]),
    );
  }
  args.push('--append-system-prompt-file', appendFile, '--settings', workerSettings(), '--output-format', 'stream-json', '--verbose', '--', prompt);
  return args;
}

export function isReadOnly(duty) {
  return READ_ONLY_DUTIES.includes(duty) || NO_TOOL_DUTIES.includes(duty);
}

export { RuntimeError, workerEnv, nodeBinary, dutyMode };
