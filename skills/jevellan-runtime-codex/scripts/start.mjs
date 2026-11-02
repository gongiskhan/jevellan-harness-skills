#!/usr/bin/env node
// Starts one task step as a `codex exec` turn under a small detached parent (runner.mjs), and returns at once.
//
//   node start.mjs --task T --step N --duty D --cwd <worktree> --provider P --model M --effort E [--prompt-file F] [--json]
//
// The same guards as the Claude runtime: a placement since the step last ran naming exactly this provider, model and
// effort; the step not running and not done; the task's worktree as the working folder. Codex has no system prompt
// channel, so the worker rules, the duty's instructions (inline: Codex does not load Claude skills), AGENTS.md and the
// task block go first in the message, after "Instructions for this session:". The thread id Codex announces becomes
// the session's native id (session.started), and the runner records the report when the turn ends.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  RuntimeError,
  archiveStaleReport,
  assertDutyInstalled,
  buildAppend,
  buildTaskBlock,
  currentView,
  ledger,
  loadTask,
  logsDir,
  providerFor,
  requirePlacement,
  rootFor,
  workflowOf,
  worktreeOf,
} from './lib/task.mjs';
import { START_PROMPT } from './lib/prompt.mjs';
import { codexStartArgs, firstMessage, nodeBinary, workerEnv } from './lib/env.mjs';
import { pidAlive } from './lib/proc.mjs';
import { isEntry, main } from './lib/cli.mjs';

export const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner.mjs');

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
  if (!ledger.DUTIES.includes(values.duty)) throw new RuntimeError(`--duty must be one of ${ledger.DUTIES.join(', ')}`);
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
  const view = currentView(info, step);
  if (view.started && !view.end && pidAlive(view.started.data?.pid)) throw new RuntimeError(`step ${step} of ${values.task} is running (pid ${view.started.data.pid}); wait for its report or stop it`);
  if (view.done) throw new RuntimeError(`step ${step} of ${values.task} is done`);
  const provider = providerFor(values.provider, values.model, values.effort);
  requirePlacement(info, step, values);

  const session = crypto.randomUUID();
  const env = workerEnv({ provider, task: values.task, step, duty: values.duty, project: root, session });
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
  ledger.appendEvent(root, {
    kind: 'step.started', task: values.task, step, session,
    data: { ordinal: step, duty: values.duty, runtime: 'codex', provider: provider.name, model: values.model, effort: values.effort, cwd, nativeSessionId: null, pid, logFile },
  });
  const out = { task: values.task, step, duty: values.duty, session, pid, provider: provider.name, model: values.model, effort: values.effort, cwd, logFile, appendFile, staleReport: stale };
  return { out, text: `Started ${values.task} step ${step} (${values.duty}) on ${values.model} ${values.effort} via ${provider.name} (codex exec): session ${session}, pid ${pid}. Use the ledger skill to wait for its report.` };
}

if (isEntry(import.meta.url)) main(start);
