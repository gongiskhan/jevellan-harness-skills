#!/usr/bin/env node
// Starts one task step as its own `claude -p` session, detached, and returns at once.
//
//   node start.mjs --task T --step N --duty D --cwd <worktree> --provider P --model M --effort E [--prompt-file F] [--json]
//
// Guards (exit 2 with the reason): the step must have a placement since it last ran that names exactly this
// provider, model and effort (nothing but placement chooses where a step runs); the step must not be running; the
// provider must be a Claude provider whose token or key file has a value; a step that may touch files runs in the
// task's worktree, never in the project's main checkout. The worker gets the environment of lib/env.mjs, the system
// prompt append of lib/prompt.mjs (written to ~/.jevellan-harness/logs/<session>.append.md) and the prompt
// "Start the step now. End by writing .jevellan/report.json."; its stdout and stderr go to
// ~/.jevellan-harness/logs/<session>.log. The ledger gets step.started and session.started.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  RuntimeError,
  archiveStaleReport,
  assertDutyInstalled,
  buildAppend,
  buildTaskBlock,
  claudeArgs,
  currentView,
  ledger,
  loadTask,
  logsDir,
  providerFor,
  requirePlacement,
  rootFor,
  workerEnv,
  workflowOf,
  worktreeOf,
} from './lib/step.mjs';
import { NO_TOOL_DUTIES, START_PROMPT } from './lib/prompt.mjs';
import { pidAlive } from './lib/proc.mjs';
import { isEntry, main } from './lib/cli.mjs';

export async function start(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: 'string' },
      step: { type: 'string' },
      duty: { type: 'string' },
      cwd: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'prompt-file': { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  for (const key of ['task', 'step', 'duty', 'cwd', 'provider', 'model', 'effort']) {
    if (!values[key]) throw new RuntimeError(`--${key} is required`);
  }
  const step = Number(values.step);
  if (!(Number.isInteger(step) && step > 0)) throw new RuntimeError('--step must be a positive integer');
  if (!ledger.DUTIES.includes(values.duty)) throw new RuntimeError(`--duty must be one of ${ledger.DUTIES.join(', ')}`);
  assertDutyInstalled(values.duty);
  const cwd = path.resolve(values.cwd);
  if (!fs.existsSync(cwd)) throw new RuntimeError(`--cwd ${cwd} does not exist`);
  const root = rootFor(cwd);
  const info = loadTask(root, values.task);

  // Where the step may run.
  const wt = worktreeOf(info);
  if (wt) {
    if (path.resolve(wt.path) !== cwd) throw new RuntimeError(`the task's worktree is ${wt.path}; start the step there, not in ${cwd}`);
  } else if (!NO_TOOL_DUTIES.includes(values.duty)) {
    throw new RuntimeError(`task ${values.task} has no worktree; use the git skill to make it first`);
  }
  const { steps } = workflowOf(info);
  const spec = steps.find((s) => s.ordinal === step);
  if (!spec) throw new RuntimeError(`task ${values.task} has no step ${step}${steps.length ? '' : ' (no workflow recorded yet)'}`);
  if (spec.duty !== values.duty) throw new RuntimeError(`step ${step} of ${values.task} is ${spec.duty}, not ${values.duty}`);
  const view = currentView(info, step);
  if (view.started && !view.end && pidAlive(view.started.data?.pid)) {
    throw new RuntimeError(`step ${step} of ${values.task} is running (pid ${view.started.data.pid}); wait for its report or stop it`);
  }
  if (view.done) throw new RuntimeError(`step ${step} of ${values.task} is done`);
  const provider = providerFor(values.provider, values.model, values.effort);
  requirePlacement(info, step, values);

  const session = crypto.randomUUID();
  const env = workerEnv({ provider, task: values.task, step, duty: values.duty, project: root, session });
  const block = values['prompt-file'] ? fs.readFileSync(values['prompt-file'], 'utf8').trim() : buildTaskBlock(root, info, step, values.duty);
  const logs = logsDir();
  const appendFile = path.join(logs, `${session}.append.md`);
  fs.writeFileSync(appendFile, buildAppend(root, info, step, values.duty, cwd, block), { mode: 0o600 });
  fs.mkdirSync(path.join(cwd, '.jevellan', 'evidence'), { recursive: true });
  const stale = archiveStaleReport(root, cwd, values.task, step);

  const logFile = path.join(logs, `${session}.log`);
  const log = fs.openSync(logFile, 'a', 0o600);
  const args = claudeArgs({ duty: values.duty, session, model: values.model, effort: values.effort, appendFile, prompt: START_PROMPT });
  const child = spawn(process.env.JH_CLAUDE_BIN || 'claude', args, { cwd, env, detached: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  if (!child.pid) throw new RuntimeError('claude did not start');
  child.on('error', () => {});
  child.unref();
  try {
    ledger.appendEvent(root, {
      kind: 'step.started',
      task: values.task,
      step,
      session,
      data: { ordinal: step, duty: values.duty, runtime: 'claude', provider: provider.name, model: values.model, effort: values.effort, cwd, nativeSessionId: session, pid: child.pid, logFile },
    });
    ledger.appendEvent(root, { kind: 'session.started', task: values.task, step, session, data: { role: 'worker', nativeSessionId: session, model: values.model } });
  } catch (error) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    throw error;
  }
  const out = { task: values.task, step, duty: values.duty, session, pid: child.pid, provider: provider.name, model: values.model, effort: values.effort, cwd, logFile, appendFile, staleReport: stale };
  return { out, text: `Started ${values.task} step ${step} (${values.duty}) on ${values.model} ${values.effort} via ${provider.name}: session ${session}, pid ${child.pid}. Use the ledger skill to wait for its report.` };
}

if (isEntry(import.meta.url)) main(start);
