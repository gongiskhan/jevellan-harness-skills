#!/usr/bin/env node
// PostToolUse hook (matcher Bash|Edit|Write|MultiEdit|NotebookEdit): records what a session did as session.event
// lines, the tool and a short summary: the command's first 200 characters for Bash, the file path for the others.
// Never file contents and never tool output. Sessions outside an installed project (no .jevellan/ at the project
// root) and not running a task are left alone.

import fs from 'node:fs';
import { isMain, runHook } from '../scripts/lib/hook.mjs';
import { appendEvent } from '../scripts/lib/ledger.mjs';
import { projectPaths } from '../scripts/lib/project.mjs';
import { redactText } from '../scripts/lib/redact.mjs';

export const COMMAND_CHARS = 200;

// The command is redacted whole before it is cut: a secret that crosses the cut would no longer match as a whole
// value once cut, and its first characters would reach the ledger.
export function summarize(tool, input = {}) {
  if (tool === 'Bash') return redactText(String(input.command ?? '')).slice(0, COMMAND_CHARS);
  if (tool === 'NotebookEdit') return String(input.notebook_path ?? '');
  if (['Edit', 'Write', 'MultiEdit'].includes(tool)) return String(input.file_path ?? '');
  return '';
}

export function postToolHook(input, root) {
  if (!root) return;
  const task = process.env.JH_TASK;
  if (!task && !fs.existsSync(projectPaths(root).dir)) return;
  const tool = String(input.tool_name ?? 'unknown');
  const step = Number(process.env.JH_STEP);
  appendEvent(root, {
    kind: 'session.event',
    task: task || undefined,
    step: task && Number.isInteger(step) && step > 0 ? step : undefined,
    session: input.session_id || process.env.JH_SESSION,
    data: { tool, summary: summarize(tool, input.tool_input) },
  });
}

if (isMain(import.meta.url)) runHook('post-tool', postToolHook);
