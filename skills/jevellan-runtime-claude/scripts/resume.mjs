#!/usr/bin/env node
// Resumes a step's session with a message, detached, and returns at once.
//
//   node resume.mjs --task T --step N --message "<text>" [--from owner|coordinator] [--json]
//
// The message reaches the worker as "From the owner: <text>" or "From the coordinator: <text>" (default
// coordinator), through `claude -p --resume <session>` with the same provider, model, effort, permissions and system
// prompt append as the step's start. Refused (exit 2) while the task's newest worker is alive (whatever the ledger
// says after its start), before the step ever started, after it is done, and after 20 continues of one placement;
// the guards run again on a fresh reading of the task before each append, which the ledger writes only if the task
// did not change since. The ledger gets step.message and a new step.started with the same nativeSessionId.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  EXIT_GRACE_MS,
  MAX_CONTINUES,
  RuntimeError,
  appendStarted,
  archiveStaleReport,
  assertNoLiveWorker,
  assertProjectAllowed,
  claudeArgs,
  currentView,
  loadTask,
  logsDir,
  providerFor,
  resumeCheck,
  rootFor,
  workerEnv,
  worktreeOf,
} from './lib/step.mjs';
import { resumeMessage } from './lib/prompt.mjs';
import { appendChecked } from './lib/ledger-client.mjs';
import { isEntry, main } from './lib/cli.mjs';

export async function resume(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { task: { type: 'string' }, step: { type: 'string' }, message: { type: 'string' }, from: { type: 'string' }, json: { type: 'boolean' } },
    strict: true,
  });
  if (!values.task) throw new RuntimeError('--task is required');
  const step = Number(values.step);
  if (!(Number.isInteger(step) && step > 0)) throw new RuntimeError('--step must be a positive integer');
  const message = (values.message ?? '').trim();
  if (!message) throw new RuntimeError('--message is required');
  const from = values.from ?? 'coordinator';
  if (!['owner', 'coordinator'].includes(from)) throw new RuntimeError('--from must be owner or coordinator');

  const root = rootFor(process.cwd());
  const info = loadTask(root, values.task);
  const view = currentView(info, step);
  const started = view.started;
  if (!started) throw new RuntimeError(`step ${step} of ${values.task} has not started; start it with start.mjs`);
  if (started.data?.runtime !== 'claude') throw new RuntimeError(`step ${step} runs on the ${started.data?.runtime} runtime; resume it with that runtime's skill`);
  // The task's newest worker must be gone, whatever the ledger says about its turn.
  assertNoLiveWorker(info, step, { graceMs: EXIT_GRACE_MS });
  if (view.done) throw new RuntimeError(`step ${step} of ${values.task} is done`);
  // At most 20 continues per placement: the turns since the latest placement of this step.
  const placed = [...info.events].reverse().find((e) => e.kind === 'task.placed' && e.data?.step === step);
  const turns = info.events.filter((e) => e.kind === 'step.started' && e.step === step && e.seq > (placed?.seq ?? 0)).length;
  if (turns > MAX_CONTINUES) throw new RuntimeError(`step ${step} was resumed ${turns - 1} times since its placement; tell the owner instead of resuming again`);

  const d = started.data;
  const provider = providerFor(d.provider, d.model, d.effort);
  assertProjectAllowed(provider, root);
  const session = d.nativeSessionId;
  const cwd = d.cwd;
  const wt = worktreeOf(info);
  if (wt && path.resolve(wt.path) !== path.resolve(cwd)) throw new RuntimeError(`the task's worktree moved to ${wt.path}; the step's session ran in ${cwd}`);
  if (!fs.existsSync(cwd)) throw new RuntimeError(`the step's folder ${cwd} is gone (archived?)`);
  const logs = logsDir();
  const appendFile = path.join(logs, `${session}.append.md`);
  if (!fs.existsSync(appendFile)) throw new RuntimeError(`the step's system prompt file ${appendFile} is missing`);
  const env = workerEnv({ provider, task: values.task, step, duty: d.duty, project: root, session, cwd });
  archiveStaleReport(root, cwd, values.task, step);

  // The guards run again on a fresh reading of the task, before the message and again with the new start: a
  // concurrent resume or start is refused before it spawns, or has its process killed after (exit 2).
  const guard = (fresh) => resumeCheck(fresh, step, started);
  appendChecked(root, values.task, (fresh) => {
    guard(fresh);
    return { kind: 'step.message', step, session, data: { direction: from, text: message }, command: 'append' };
  });
  const logFile = path.join(logs, `${session}.log`);
  const log = fs.openSync(logFile, 'a', 0o600);
  const args = claudeArgs({ duty: d.duty, session, resume: true, model: d.model, effort: d.effort, appendFile, prompt: resumeMessage(from, message), cwd });
  const child = spawn(process.env.JH_CLAUDE_BIN || 'claude', args, { cwd, env, detached: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  if (!child.pid) throw new RuntimeError('claude did not start');
  child.on('error', () => {});
  child.unref();
  const data = { ordinal: step, duty: d.duty, runtime: 'claude', provider: d.provider, model: d.model, effort: d.effort, cwd, nativeSessionId: session, pid: child.pid, logFile, resumed: true };
  appendStarted(root, values.task, (fresh) => {
    guard(fresh);
    return { kind: 'step.started', step, session, data };
  }, child.pid);
  const out = { task: values.task, step, session, pid: child.pid, from, logFile };
  return { out, text: `Resumed ${values.task} step ${step} in session ${session} (pid ${child.pid}). Use the ledger skill to wait for its report.` };
}

export const USAGE = 'usage: node resume.mjs --task T --step N --message "<text>" [--from owner|coordinator] [--json]';

if (isEntry(import.meta.url)) main(resume, USAGE);
