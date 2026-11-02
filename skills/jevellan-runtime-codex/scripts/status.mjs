#!/usr/bin/env node
// Says whether a Codex step's runner is alive or has exited, with the last event of its log.
//
//   node status.mjs --task T --step N [--json]

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { RuntimeError, ledger, loadTask, projectLib, rootFor } from './lib/task.mjs';
import { pidAlive } from './lib/proc.mjs';
import { isEntry, main } from './lib/cli.mjs';
import { importFromRole } from './lib/roles.mjs';

const { redactText } = await importFromRole('ledger', 'scripts/lib/redact.mjs');

// The last line of the log that says something, as a short text: the result line, or the last assistant text, or
// the last tool used.
export function lastLogLine(file) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    fs.closeSync(fd);
    text = buffer.toString('utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const j = JSON.parse(lines[i]);
      if (j.type === 'turn.completed') return `turn completed (${j.usage?.output_tokens ?? '?'} output tokens)`;
      if (j.type === 'item.completed' && j.item?.type === 'agent_message') return `said: ${String(j.item.text ?? '').replace(/\s+/g, ' ').slice(0, 200)}`;
      if (j.type === 'item.completed' && j.item?.type) return `item: ${j.item.type}${j.item.command ? ` ${String(j.item.command).slice(0, 120)}` : ''}`;
      if (j.type === 'result') return `result: ${j.subtype ?? ''} ${String(j.result ?? '').replace(/\s+/g, ' ').slice(0, 200)}`.trim();
      if (j.type === 'assistant') {
        const parts = j.message?.content ?? [];
        const tool = parts.find((c) => c.type === 'tool_use');
        if (tool) return `tool: ${tool.name}`;
        const said = parts.find((c) => c.type === 'text');
        if (said) return `said: ${said.text.replace(/\s+/g, ' ').slice(0, 200)}`;
      }
    } catch {
      return lines[i].slice(0, 200);
    }
  }
  return null;
}

export async function status(argv) {
  const { values } = parseArgs({ args: argv, options: { task: { type: 'string' }, step: { type: 'string' }, json: { type: 'boolean' } }, strict: true });
  if (!values.task) throw new RuntimeError('--task is required');
  const step = Number(values.step);
  if (!(Number.isInteger(step) && step > 0)) throw new RuntimeError('--step must be a positive integer');
  const root = projectLib.projectRoot(process.cwd()) ?? rootFor(process.cwd());
  const info = loadTask(root, values.task);
  // The step's newest start, even when a retry reset the step since: its process may still be running.
  const view = ledger.stepView(info.events, step);
  if (!view.started) throw new RuntimeError(`step ${step} of ${values.task} has not started`, 3);
  const d = view.started.data;
  const alive = pidAlive(d.pid);
  const last = d.logFile ? lastLogLine(d.logFile) : null;
  const thread = d.nativeSessionId ?? [...info.events].reverse().find((e) => e.kind === 'session.started' && e.session === view.started.session && e.data?.nativeSessionId)?.data?.nativeSessionId ?? null;
  const out = { task: values.task, step, state: alive ? 'alive' : 'exited', pid: d.pid, session: thread, startedAt: view.started.t, model: d.model, effort: d.effort, provider: d.provider, ended: view.end ? view.end.kind : null, lastLine: last ? redactText(last) : null };
  return { out, text: `${values.task} step ${step}: ${out.state} (pid ${d.pid}, session ${d.nativeSessionId}, ${d.model} ${d.effort} via ${d.provider})${out.ended ? `, ended by ${out.ended}` : ''}${out.lastLine ? `\nlast: ${out.lastLine}` : ''}` };
}

if (isEntry(import.meta.url)) main(status);
