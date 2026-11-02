#!/usr/bin/env node
// Stops a step: SIGTERM to the worker's process group, SIGKILL after 10 s, then step.stopped in the ledger.
//
//   node stop.mjs --task T --step N [--reason "..."] [--json]

import { parseArgs } from 'node:util';
import { RuntimeError, currentView, ledger, loadTask, projectLib, rootFor } from './lib/step.mjs';
import { stopGroup } from './lib/proc.mjs';
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
  const root = projectLib.projectRoot(process.cwd()) ?? rootFor(process.cwd());
  const info = loadTask(root, values.task);
  const view = currentView(info, step);
  if (!view.started) throw new RuntimeError(`step ${step} of ${values.task} has not started`, 3);
  const pid = view.started.data?.pid;
  const how = view.end ? 'not running' : stopGroup(pid);
  const reason = values.reason ?? (how === 'not running' ? 'stopped (the process had already ended)' : `stopped (${how})`);
  const event = ledger.appendEvent(root, { kind: 'step.stopped', task: values.task, step, session: view.started.session, data: { ordinal: step, reason, pid } });
  return { out: { task: values.task, step, pid, how, seq: event.seq }, text: `Stopped ${values.task} step ${step}: ${how}.` };
}

if (isEntry(import.meta.url)) main(stop);
