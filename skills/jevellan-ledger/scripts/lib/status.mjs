// The status view of every open task, and how it reads: grouped for people, five lines for a session's context.

import { projectAll } from './ledger.mjs';

export const OPEN_STATES = ['waiting-owner', 'running', 'landing', 'failed', 'queued'];
const DAY = 24 * 60 * 60 * 1000;

export const ORDER = { 'waiting-owner': 0, running: 1, landing: 2, failed: 3, queued: 4 };
export const HEADINGS = { 'waiting-owner': 'Waiting on the owner', running: 'Running', landing: 'Landing', failed: 'Failed', queued: 'Queued' };

export function stepLabel(task) {
  const step = task.steps.find((s) => s.ordinal === task.currentStep);
  if (!step) return '';
  const where = step.model ? ` on ${step.model} ${step.effort ?? ''} via ${step.provider}`.replace(/\s+/g, ' ') : '';
  return ` - step ${step.ordinal} ${step.duty ?? ''}${where}`.replace(/\s+$/, '');
}

export function optionsText(options) {
  return (options ?? []).map((o, i) => `${i + 1}) ${typeof o === 'string' ? o : o.label}`).join('  ');
}

export function describe(task) {
  const lines = [`  ${task.task}  ${task.title} (${task.kind}${task.duty ? ` ${task.duty}` : ''})${stepLabel(task)}`];
  if (task.state === 'waiting-owner') {
    const w = task.waiting ?? {};
    const label = w.source === 'landing' ? 'Landing' : w.source === 'coordinator' ? 'Question' : w.status;
    if (w.question) lines.push(`          ${label}: ${w.question}`);
    else if (w.summary) lines.push(`          ${w.status}: ${w.summary.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (w.options?.length) lines.push(`          ${optionsText(w.options)}${w.recommended ? ` (recommended: ${w.recommended})` : ''}`);
  }
  if (task.state === 'running' && task.alive === false) lines.push('          (process gone)');
  if (task.state === 'landing') lines.push(`          route ${task.landing?.route}${task.landing?.reason ? `: ${task.landing.reason}` : ''}`);
  if (task.reason && task.state !== 'landing') lines.push(`          ${task.reason}`);
  if (task.next) lines.push(`          next: ${task.next}`);
  return lines.join('\n');
}

export function briefLine(task) {
  let line = `${task.task} ${task.state}: ${task.title}${stepLabel(task)}`;
  if (task.state === 'waiting-owner' && task.waiting?.question) line += ` | ${task.waiting.question} ${optionsText(task.waiting.options)}`;
  if (task.next) line += ` (next: ${task.next})`;
  return line.length > 400 ? `${line.slice(0, 399)}…` : line;
}

export function statusView(at, { now = Date.now() } = {}) {
  const { tasks, lost } = projectAll(at);
  const open = tasks.filter((t) => OPEN_STATES.includes(t.state)).sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.createdAt.localeCompare(b.createdAt));
  const recent = tasks
    .filter((t) => ['done', 'stopped'].includes(t.state) && now - Date.parse(t.updatedAt) < DAY)
    .map((t) => ({ task: t.task, title: t.title, kind: t.kind, state: t.state, commit: t.landedCommit ?? null, ...(t.landedPr ? { pr: t.landedPr } : {}), at: t.landedAt ?? t.doneAt ?? t.updatedAt, reason: t.reason ?? null }));
  return { tasks: open, recent, lost: lost.map((e) => ({ seq: e.seq, task: e.task, step: e.step })) };
}


export function briefLines(view, max = 5) {
  const lines = view.tasks.map(briefLine);
  if (lines.length > max) {
    const more = lines.length - (max - 1);
    lines.splice(max - 1, lines.length, `and ${more} more (ledger.mjs status)`);
  }
  return lines;
}
