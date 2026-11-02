#!/usr/bin/env node
// Resumes a Codex step's thread with a message: `codex exec resume <thread id>` under the runner, and returns at once.
//
//   node resume.mjs --task T --step N --message "<text>" [--from owner|coordinator] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  EXIT_GRACE_MS,
  MAX_CONTINUES,
  RuntimeError,
  appendStarted,
  archiveStaleReport,
  assertNoLiveWorker,
  currentView,
  ledger,
  loadTask,
  logsDir,
  projectLib,
  providerFor,
  resumeCheck,
  rootFor,
} from './lib/task.mjs';
import { resumeMessage } from './lib/prompt.mjs';
import { codexResumeArgs, workerEnv } from './lib/env.mjs';
import { isEntry, main } from './lib/cli.mjs';
import { spawnRunner } from './start.mjs';

export async function resume(argv) {
  const { values } = parseArgs({ args: argv, options: { task: { type: 'string' }, step: { type: 'string' }, message: { type: 'string' }, from: { type: 'string' }, json: { type: 'boolean' } }, strict: true });
  if (!values.task) throw new RuntimeError('--task is required');
  const step = Number(values.step);
  if (!(Number.isInteger(step) && step > 0)) throw new RuntimeError('--step must be a positive integer');
  const message = (values.message ?? '').trim();
  if (!message) throw new RuntimeError('--message is required');
  const from = values.from ?? 'coordinator';
  if (!['owner', 'coordinator'].includes(from)) throw new RuntimeError('--from must be owner or coordinator');
  const root = projectLib.projectRoot(process.cwd()) ?? rootFor(process.cwd());
  const info = loadTask(root, values.task);
  const view = currentView(info, step);
  const started = view.started;
  if (!started) throw new RuntimeError(`step ${step} of ${values.task} has not started; start it with start.mjs`);
  if (started.data?.runtime !== 'codex') throw new RuntimeError(`step ${step} runs on the ${started.data?.runtime} runtime; resume it with that runtime's skill`);
  // The task's newest worker must be gone, whatever the ledger says about its turn.
  assertNoLiveWorker(info, step, { graceMs: EXIT_GRACE_MS });
  if (view.done) throw new RuntimeError(`step ${step} of ${values.task} is done`);
  const placed = [...info.events].reverse().find((e) => e.kind === 'task.placed' && e.data?.step === step);
  const turns = info.events.filter((e) => e.kind === 'step.started' && e.step === step && e.seq > (placed?.seq ?? 0)).length;
  if (turns > MAX_CONTINUES) throw new RuntimeError(`step ${step} was resumed ${turns - 1} times since its placement; tell the owner instead of resuming again`);
  const session = started.session;
  const threadId = started.data.nativeSessionId
    ?? [...info.events].reverse().find((e) => e.kind === 'session.started' && e.session === session && e.data?.nativeSessionId)?.data?.nativeSessionId;
  if (!threadId) throw new RuntimeError(`step ${step} has no Codex thread id recorded; start it again instead`);
  const d = started.data;
  const provider = providerFor(d.provider, d.model, d.effort);
  if (!fs.existsSync(d.cwd)) throw new RuntimeError(`the step's folder ${d.cwd} is gone (archived?)`);
  const env = workerEnv({ provider, task: values.task, step, duty: d.duty, project: root, session, cwd: d.cwd });
  archiveStaleReport(root, d.cwd, values.task, step);
  // The guards run again inside the ledger lock, before the message and again with the new start: a concurrent
  // resume or start is refused before it spawns, or has its runner killed after (exit 2).
  const check = resumeCheck(values.task, step, started);
  ledger.appendEvent(root, { kind: 'step.message', task: values.task, step, session, data: { direction: from, text: message } }, { check });
  const logs = logsDir();
  const logFile = path.join(logs, `${session}.log`);
  const pid = spawnRunner({ root, task: values.task, step, session, cwd: d.cwd, model: d.model, logFile, env, threadId, args: codexResumeArgs({ threadId, model: d.model, effort: d.effort }), message: resumeMessage(from, message) }, logs, session);
  appendStarted(root, {
    kind: 'step.started', task: values.task, step, session,
    data: { ordinal: step, duty: d.duty, runtime: 'codex', provider: d.provider, model: d.model, effort: d.effort, cwd: d.cwd, nativeSessionId: threadId, pid, logFile, resumed: true },
  }, check, pid);
  return { out: { task: values.task, step, session, threadId, pid, from, logFile }, text: `Resumed ${values.task} step ${step} in Codex thread ${threadId} (pid ${pid}). Use the ledger skill to wait for its report.` };
}

if (isEntry(import.meta.url)) main(resume);
