#!/usr/bin/env node
// Starts one task step as a `codex exec` turn under a small detached parent (lib/runner.mjs), and returns at once.
//
//   node start.mjs --task T --step N --duty D --cwd <worktree> --provider P --model M --effort E [--prompt-file F] [--json]
//
// The same guards as the Claude runtime: a placement since the step last ran naming exactly this provider, model and
// effort; the task's newest worker gone and the step not done, checked again on a fresh reading of the task when
// step.started is appended (only if the task did not change since that reading); the task's worktree as the working
// folder. Codex has no system prompt channel, so the worker rules, the duty's instructions (inline: Codex does not
// load Claude skills), AGENTS.md and the task block go first in the message, after "Instructions for this session:".
// The thread id Codex announces becomes the session's native id (session.started), and the runner hands the turn's
// report to the ledger when it ends. A refused or failed start kills the runner and Codex with it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  currentView,
  loadTask,
  logsDir,
  providerFor,
  requirePlacement,
  rootFor,
  startCheck,
  workflowOf,
  worktreeOf,
} from './lib/task.mjs';
import { DUTIES, START_PROMPT } from './lib/prompt.mjs';
import { codexStartArgs, firstMessage, nodeBinary, workerEnv } from './lib/env.mjs';
import { isEntry, main } from './lib/cli.mjs';

// Internal: spawned by start.mjs and resume.mjs only.
export const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'runner.mjs');

// Writes the runner's spec (mode 600; it holds no secret) and spawns the runner detached in its own process group.
export function spawnRunner(spec, logs, session) {
  const specFile = path.join(logs, `${session}.${Date.now()}.spec.json`);
  fs.writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600 });
  const err = fs.openSync(path.join(logs, `${session}.runner.log`), 'a', 0o600);
  const child = spawn(nodeBinary(), [RUNNER, '--spec', specFile], { cwd: spec.cwd, env: { ...process.env, ...(process.env.JH_CODEX_BIN ? { JH_CODEX_BIN: process.env.JH_CODEX_BIN } : {}) }, detached: true, stdio: ['ignore', err, err] });
  fs.closeSync(err);
  if (!child.pid) throw new RuntimeError('the runner did not start');
  child.on('error', () => {});
  child.unref();
  return child.pid;
}

export async function start(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: 'string' }, step: { type: 'string' }, duty: { type: 'string' }, cwd: { type: 'string' }, provider: { type: 'string' },
      model: { type: 'string' }, effort: { type: 'string' }, 'prompt-file': { type: 'string' }, json: { type: 'boolean' },
    },
    strict: true,
  });
  for (const key of ['task', 'step', 'duty', 'cwd', 'provider', 'model', 'effort']) if (!values[key]) throw new RuntimeError(`--${key} is required`);
  const step = Number(values.step);
  if (!(Number.isInteger(step) && step > 0)) throw new RuntimeError('--step must be a positive integer');
  if (!DUTIES.includes(values.duty)) throw new RuntimeError(`--duty must be one of ${DUTIES.join(', ')}`);
  assertDutyInstalled(values.duty);
  const cwd = path.resolve(values.cwd);
  if (!fs.existsSync(cwd)) throw new RuntimeError(`--cwd ${cwd} does not exist`);
  const root = rootFor(cwd);
  const info = loadTask(root, values.task);
  const wt = worktreeOf(info);
  if (!wt) throw new RuntimeError(`task ${values.task} has no worktree; use the git skill to make it first`);
  if (path.resolve(wt.path) !== cwd) throw new RuntimeError(`the task's worktree is ${wt.path}; start the step there, not in ${cwd}`);
  const spec = workflowOf(info).steps.find((s) => s.ordinal === step);
  if (!spec) throw new RuntimeError(`task ${values.task} has no step ${step}`);
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
  fs.writeFileSync(appendFile, buildAppend(root, info, step, values.duty, cwd, block, { inlineDuty: true }), { mode: 0o600 });
  fs.mkdirSync(path.join(cwd, '.jevellan', 'evidence'), { recursive: true });
  const stale = archiveStaleReport(root, cwd, values.task, step);
  const logFile = path.join(logs, `${session}.log`);
  const pid = spawnRunner({
    root, task: values.task, step, session, cwd, model: values.model, logFile, env,
    args: codexStartArgs({ cwd, model: values.model, effort: values.effort }),
    message: firstMessage(fs.readFileSync(appendFile, 'utf8'), START_PROMPT),
  }, logs, session);
  // The guards run again on a fresh reading of the task; a refused or failed start kills the runner it spawned.
  const data = { ordinal: step, duty: values.duty, runtime: 'codex', provider: provider.name, model: values.model, effort: values.effort, cwd, nativeSessionId: null, pid, logFile };
  appendStarted(root, values.task, (fresh) => {
    startCheck(fresh, step, placed);
    return { kind: 'step.started', step, session, data };
  }, pid);
  const out = { task: values.task, step, duty: values.duty, session, pid, provider: provider.name, model: values.model, effort: values.effort, cwd, logFile, appendFile, staleReport: stale };
  return { out, text: `Started ${values.task} step ${step} (${values.duty}) on ${values.model} ${values.effort} via ${provider.name} (codex exec): session ${session}, pid ${pid}. Use the ledger skill to wait for its report.` };
}

export const USAGE = 'usage: node start.mjs --task T --step N --duty D --cwd <worktree> --provider P --model M --effort E [--prompt-file F] [--json]';

if (isEntry(import.meta.url)) main(start, USAGE);
