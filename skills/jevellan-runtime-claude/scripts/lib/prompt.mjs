// What a worker receives (brief section 6), ported from the skills repo's prompt.ts and templates/worker-rules.md:
// (1) the shared worker rules, adapted to the duty (its D-037: write duties commit, plan writes only plan.md, the
// other read-only duties change nothing, answer and converse have no tools); (2) "Your step is duty <duty>. Use the
// duty skill for <duty> now and follow it."; (3) AGENTS.md at the project root, first 32 KiB; (4) the task block.
// The same text goes into Claude's system prompt (an append file) and first in a Codex session's message.

import fs from 'node:fs';
import path from 'node:path';

export const AGENTS_MAX_BYTES = 32 * 1024;
export const AGENTS_CUT_NOTE = '[AGENTS.md is longer than 32 KiB; the rest was cut. Read the file for the full text.]';
export const PREVIOUS_SUMMARY_MAX = 1500;
export const START_PROMPT = 'Start the step now. End by writing .jevellan/report.json.';
export const NO_TOOL_DUTIES = ['answer', 'converse'];
export const READ_ONLY_DUTIES = ['investigate', 'plan'];
const PROJECT_SETTING_KEYS = ['testCommand', 'devCommand', 'automationDir'];

export function dutyMode(duty) {
  if (NO_TOOL_DUTIES.includes(duty)) return 'no-tools';
  if (duty === 'plan') return 'plan';
  if (READ_ONLY_DUTIES.includes(duty)) return 'read-only';
  return 'write';
}

const NO_REMOTE = 'Never push, never open a pull request, never touch main.';
const REPORT_FILE =
  'End every turn by writing .jevellan/report.json in your working folder, exactly once per turn, as your duty skill describes: status progress while you are still working, done when the step is complete, blocked when something outside your control stops you, and needs-decision with two to four options when a choice belongs to the owner.';
const REPORT_BLOCK =
  'You have no tools in this step: end your reply with exactly one fenced json report block of the shape your duty skill describes, and nothing after it.';
const WORK_BULLETS = [
  '- For visual work, capture the affected screens at desktop and phone widths with the available browser tools. Save screenshots under .jevellan/evidence/ in your worktree and list them in the report with a caption each. Say clearly when a screen could not be checked.',
  "- Run only surgical tests: the ones that cover what you changed, unless your step instructions say to run the project's test command.",
].join('\n');

export function workerRules({ project, cwd, branch, base, duty }) {
  const mode = dutyMode(duty);
  const worktree = `Isolation: your own git worktree on branch ${branch}, based on ${base}. Other steps of this task ran here before you; other tasks work elsewhere.`;
  let isolation;
  let report = REPORT_FILE;
  let work = '';
  if (mode === 'write') {
    isolation = `${worktree} Commit your work on this branch with the machine's git identity and no attribution of any kind. ${NO_REMOTE}`;
    work = WORK_BULLETS;
  } else if (mode === 'plan') {
    isolation = `${worktree} This step writes only plan.md at the worktree root and the report file, and changes nothing else: no other file, no notes, no evidence, and no commit. ${NO_REMOTE}`;
  } else if (mode === 'read-only') {
    isolation = `${worktree} This step changes nothing in this worktree: it creates, edits and deletes no file except the report file, saves no evidence and does not commit. ${NO_REMOTE}`;
  } else {
    isolation = 'Isolation: this step has no tools and no access to the repository; it reads, runs and changes nothing.';
    report = REPORT_BLOCK;
  }
  const lines = [
    `You are working on one step of one task for this project's coordinator. Work the way you normally would, in the project "${project}" at ${cwd}.`,
    '',
    isolation,
    '',
    `- Keep the coordinator informed. ${report}`,
    "- Write reports for the owner, in the owner's language. Explain what changed and what they can now see or do, how to try it, and any remaining limitation. A done report describes the outcome, not just commits or commands. The summary allows up to 4,000 characters.",
  ];
  if (work) lines.push(work);
  lines.push(
    "- Don't review your own work beyond normal care. The verify step and the owner's tests run after you.",
    '- If the owner must run something (a sign-in, sudo, anything you are not allowed to do), put the exact command in ownerCommands of your report with why, and report blocked or needs-decision. Never ask the owner to run something you can run yourself.',
    '- Never edit, commit or mention CLAUDE.md or .claude; project instructions live in AGENTS.md.',
    "- Never deploy, never touch production, never delete the owner's data or processes.",
  );
  return lines.join('\n');
}

export function dutyLine(duty) {
  return `Your step is duty ${duty}. Use the duty skill for ${duty} now and follow it.`;
}

function utf8Prefix(buffer, max) {
  let end = Math.min(max, buffer.length);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

export function projectInstructions(projectRoot, maxBytes = AGENTS_MAX_BYTES) {
  let buffer;
  try {
    buffer = fs.readFileSync(path.join(projectRoot, 'AGENTS.md'));
  } catch {
    return null;
  }
  if (buffer.length <= maxBytes) return buffer.toString('utf8').trim();
  return `${utf8Prefix(buffer, maxBytes).trimEnd()}\n\n${AGENTS_CUT_NOTE}`;
}

function cut(text, max) {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? String(text ?? '') : `${chars.slice(0, max).join('').trimEnd()}...`;
}

// The task block of the skills brief 7.4. A part with nothing to say is left out.
export function taskBlock({ task, title, kind, position, total, duty, text, instructions, settings = {}, earlier = [], plan = false, failure = null }) {
  const parts = [`Task ${task}: ${title}\nKind: ${kind}. Step ${position} of ${total}: ${duty}.`, String(text ?? '').trim()];
  if (String(instructions ?? '').trim()) parts.push(`Step instructions:\n${instructions.trim()}`);
  if (failure) parts.push(`This step runs again after a failure. What failed:\n${cut(failure.replace(/\s+/g, ' ').trim(), PREVIOUS_SUMMARY_MAX)}`);
  const lines = PROJECT_SETTING_KEYS.filter((k) => typeof settings[k] === 'string' && settings[k]).map((k) => `- ${k}: ${settings[k]}`);
  if (lines.length) parts.push(`Project settings (.jevellan/project.json):\n${lines.join('\n')}`);
  const before = [];
  if (earlier.length) {
    before.push('Earlier steps of this task:');
    for (const e of earlier) before.push(`- ${e.duty} (${e.status}): ${cut(String(e.summary ?? '').replace(/\s+/g, ' ').trim(), PREVIOUS_SUMMARY_MAX)}`);
  }
  if (plan) before.push('Plan: plan.md in the worktree root.');
  if (before.length) parts.push(before.join('\n'));
  return parts.filter(Boolean).join('\n\n');
}

export function systemAppend({ rules, duty, agents, block }) {
  const parts = [rules, dutyLine(duty)];
  if (agents) parts.push(`# This project's AGENTS.md\n\n${agents}`);
  parts.push(`# Your step\n\n${block}`);
  return `${parts.join('\n\n')}\n`;
}

export function resumeMessage(from, text) {
  return `${from === 'owner' ? 'From the owner: ' : 'From the coordinator: '}${text}`;
}
