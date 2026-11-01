#!/usr/bin/env node
// SessionStart hook (startup, resume, compact): hands the ledger to a session that starts or resumes. Stdout
// reaches the session's context (verified for 2.1.316 in -p and interactive sessions, docs/findings.md).
// - A worker (JH_TASK set): its task's last 20 events, one line each.
// - Any other session in an installed project: the role line and the open work (ledger.mjs status --brief), and a
//   session.started line marking a coordinator session.
// - Anywhere else: nothing.

import fs from 'node:fs';
import { isMain, runHook } from '../scripts/lib/hook.mjs';
import { appendEvent, findTask, readEvents } from '../scripts/lib/ledger.mjs';
import { projectPaths } from '../scripts/lib/project.mjs';
import { oneLine } from '../scripts/lib/format.mjs';
import { briefLines, statusView } from '../scripts/lib/status.mjs';

export const COORDINATOR_LINE =
  "This project's work runs through the coordinator skill: use it for any request to do, plan, track or report on work here.";

export function sessionStartHook(input, root) {
  if (!root) return;
  const paths = projectPaths(root);
  const task = process.env.JH_TASK;
  if (task) {
    if (!fs.existsSync(paths.ledger)) return;
    const info = findTask(readEvents(root).events, task);
    if (!info) return;
    const lines = info.events.slice(-20).map(oneLine);
    process.stdout.write(`Ledger for task ${task}, step ${process.env.JH_STEP ?? '?'}:\n${lines.join('\n')}\n`);
    return;
  }
  if (!fs.existsSync(paths.dir)) return;
  const out = [COORDINATOR_LINE];
  if (fs.existsSync(paths.ledger)) {
    const lines = briefLines(statusView(root));
    out.push(`Open work in this project's ledger:${lines.length ? '' : ' none.'}`);
    out.push(...lines);
  }
  process.stdout.write(`${out.join('\n')}\n`);
  if (input.session_id && ['startup', 'resume', undefined].includes(input.source)) {
    appendEvent(root, {
      kind: 'session.started',
      session: input.session_id,
      data: { role: 'coordinator', nativeSessionId: input.session_id, model: input.model ?? null, source: input.source ?? null },
    });
  }
}

if (isMain(import.meta.url)) runHook('session-start', sessionStartHook);
