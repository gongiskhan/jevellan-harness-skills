#!/usr/bin/env node
// Starts one task step as its own `claude -p` session, detached, and returns at once.
//
//   node start.mjs --task T --step N --duty D --cwd <worktree> --provider P --model M --effort E [--prompt-file F] [--json]
//
// Guards (exit 2 with the reason): the step must have a placement since it last ran that names exactly this
// provider, model and effort (nothing but placement chooses where a step runs); the task's newest worker must be
// gone (whatever its step and whatever the ledger says after its start) and the step not done, checked again on a
// fresh reading of the task when step.started is appended (only if the task did not change since that reading), so
// two concurrent starts never both run; the provider must be a Claude provider whose token or key file has a value;
// a step that may touch files runs in the task's worktree, never in the project's main checkout. The worker gets the
// environment of lib/env.mjs, the system prompt append of lib/prompt.mjs (written to
// ~/.jevellan-harness/logs/<session>.append.md) and the prompt "Start the step now. End by writing
// .jevellan/report.json."; its stdout and stderr go to ~/.jevellan-harness/logs/<session>.log. The ledger (the
// ledger skill's public script) gets step.started and session.started; when either is refused the worker is killed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  EXIT_GRACE_MS,
  RuntimeError,
  appendStarted,
  archiveStaleReport,
  assertDutyInstalled,
  assertNoLiveWorker,
  buildAppend,
  buildTaskBlock,
  claudeArgs,
  currentView,
  loadTask,
  logsDir,
  providerFor,
  requirePlacement,
  rootFor,
  startCheck,
  workerEnv,
  workflowOf,
  worktreeOf,
} from './lib/step.mjs';
import { DUTIES, NO_TOOL_DUTIES, START_PROMPT } from './lib/prompt.mjs';
import { killGroup } from './lib/proc.mjs';
import { appendLine } from './lib/ledger-client.mjs';
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
  if (!DUTIES.includes(values.duty)) throw new RuntimeError(`--duty must be one of ${DUTIES.join(', ')}`);
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
  // The task's newest worker must be gone, whatever the ledger says about its turn.
  assertNoLiveWorker(info, step, { graceMs: EXIT_GRACE_MS });
  if (currentView(info, step).done) throw new RuntimeError(`step ${step} of ${values.task} is done`);
  const provider = providerFor(values.provider, values.model, values.effort);
  const placed = requirePlacement(info, step, values);

  const session = crypto.randomUUID();
  const env = workerEnv({ provider, task: values.task, step, duty: values.duty, project: root, session, cwd });
  const block = values['prompt-file'] ? fs.readFileSync(values['prompt-file'], 'utf8').trim() : buildTaskBlock(root, info, step, values.duty);
  const logs = logsDir();
  const appendFile = path.join(logs, `${session}.append.md`);
  fs.writeFileSync(appendFile, buildAppend(root, info, step, values.duty, cwd, block), { mode: 0o600 });
  fs.mkdirSync(path.join(cwd, '.jevellan', 'evidence'), { recursive: true });
  const stale = archiveStaleReport(root, cwd, values.task, step);

  const logFile = path.join(logs, `${session}.log`);
  const log = fs.openSync(logFile, 'a', 0o600);
  const args = claudeArgs({ duty: values.duty, session, model: values.model, effort: values.effort, appendFile, prompt: START_PROMPT, cwd });
  const child = spawn(process.env.JH_CLAUDE_BIN || 'claude', args, { cwd, env, detached: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  if (!child.pid) throw new RuntimeError('claude did not start');
  child.on('error', () => {});
  child.unref();
  // The guards run again on a fresh reading of the task; a refused or failed start kills the process it spawned.
  const data = { ordinal: step, duty: values.duty, runtime: 'claude', provider: provider.name, model: values.model, effort: values.effort, cwd, nativeSessionId: session, pid: child.pid, logFile };
  appendStarted(root, values.task, (fresh) => {
    startCheck(fresh, step, placed);
    return { kind: 'step.started', step, session, data };
  }, child.pid);
  try {
    appendLine(root, 'session.started', { task: values.task, step, session, data: { role: 'worker', nativeSessionId: session, model: values.model } });
  } catch (error) {
    killGroup(child.pid);
    throw error;
  }
  const out = { task: values.task, step, duty: values.duty, session, pid: child.pid, provider: provider.name, model: values.model, effort: values.effort, cwd, logFile, appendFile, staleReport: stale };
  return { out, text: `Started ${values.task} step ${step} (${values.duty}) on ${values.model} ${values.effort} via ${provider.name}: session ${session}, pid ${child.pid}. Use the ledger skill to wait for its report.` };
}

export const USAGE = 'usage: node start.mjs --task T --step N --duty D --cwd <worktree> --provider P --model M --effort E [--prompt-file F] [--json]';

if (isEntry(import.meta.url)) main(start, USAGE);
