#!/usr/bin/env node
// Stops a step: SIGTERM to the runner's process group (the runner and codex), SIGKILL after 10 s, then step.stopped
// in the ledger.
//
//   node stop.mjs --task T --step N [--reason "..."] [--json]
//
// The worker is the step's newest start, whatever came after it: a report, a step.failed or a retry reset does not
// mean its process has gone, so the group is signalled whenever it still has a member. step.stopped goes to the
// ledger through the ledger skill's public script.

import { parseArgs } from 'node:util';
import { RuntimeError, loadTask, newestStart, rootFor } from './lib/task.mjs';
import { stopGroup } from './lib/proc.mjs';
import { appendLine } from './lib/ledger-client.mjs';
import { isEntry, main } from './lib/cli.mjs';

export async function stop(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { task: { type: 'string' }, step: { type: 'string' }, reason: { type: 'string' }, json: { type: 'boolean' } },
    strict: true,
  });
  if (!values.task) throw new RuntimeError('--task is required');
  const step = Number(values.step);
  if (!(Number.isInteger(step) && step > 0)) throw new RuntimeError('--step must be a positive integer');
  const root = rootFor(process.cwd());
  const info = loadTask(root, values.task);
  const started = newestStart(info, step);
  if (!started) throw new RuntimeError(`step ${step} of ${values.task} has not started`, 3);
  const pid = started.data?.pid;
  const how = stopGroup(pid);
  const reason = values.reason ?? (how === 'not running' ? 'stopped (the process had already ended)' : `stopped (${how})`);
  const event = appendLine(root, 'step.stopped', { task: values.task, step, session: started.session, data: { ordinal: step, reason, pid } });
  return { out: { task: values.task, step, pid, how, seq: event.seq }, text: `Stopped ${values.task} step ${step}: ${how}.` };
}

export const USAGE = 'usage: node stop.mjs --task T --step N [--reason "..."] [--json]';

if (isEntry(import.meta.url)) main(stop, USAGE);
