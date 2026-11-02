#!/usr/bin/env node
// Stop hook: makes a worker end its step with a report, and records the report in the ledger.
//
// Only for worker sessions (JH_TASK set by the runtime); every other session is left alone. When the worker stops:
// - no .jevellan/report.json: block (the session continues with the reason) at most twice per turn, then record a
//   blocked report marked synthesized;
// - an invalid report: block once with the first problem, then record a blocked report with the problem in
//   limitations;
// - a valid report: append step.report (summary at most 4000 characters, fitted to one ledger line, reportFile naming
//   <project>/.jevellan/reports/<task>-s<step>-<time>.json), then move the file there, and let the session end.
// The file moves only after the ledger took the line. When the ledger refuses it (a lock that stays busy, a full
// disk), report.json stays where the worker wrote it and the turn is blocked with the reason, at most twice per turn,
// so the worker ends again and the hook tries again.
// The report is looked for in the hook's cwd and every folder above it up to the step's worktree (JH_CWD, set by the
// runtime), at the top of the checkout holding cwd, and in the worktree itself, nearest first.
// Ported from the skills repo's report-guard.mts (which asked for jv_report instead of a file).

import fs from 'node:fs';
import path from 'node:path';
import { isMain, runHook, logLine } from '../scripts/lib/hook.mjs';
import { appendEvent } from '../scripts/lib/ledger.mjs';
import { gitLocate, projectPaths } from '../scripts/lib/project.mjs';
import { LIMITS, cutText, fitReportLine, validateReport } from '../scripts/lib/report-schema.mjs';
import { redactText } from '../scripts/lib/redact.mjs';
import { compactTime } from '../scripts/lib/ids.mjs';

export const MISSING_REASON =
  'End the step by writing .jevellan/report.json with status progress, done, blocked or needs-decision (see your duty skill).';
const MAX_MISSING_BLOCKS = 2;
const MAX_INVALID_BLOCKS = 1;
const MAX_UNRECORDED_BLOCKS = 2;
const NO_TOOL_DUTIES = ['answer', 'converse'];

// The last fenced ```json block of a text as {start, end, parsed, value}: where the block starts and ends in the
// text, and its JSON when it parses (parsed false and value undefined when it does not). null when there is none.
export function lastJsonBlock(text) {
  const blocks = [...String(text).matchAll(/```json\s*\n([\s\S]*?)\n?```/g)];
  const last = blocks.at(-1);
  if (!last) return null;
  const found = { start: last.index, end: last.index + last[0].length, parsed: false, value: undefined };
  try {
    found.value = JSON.parse(last[1]);
    found.parsed = true;
  } catch {}
  return found;
}

function counterFile(root, session) {
  return path.join(projectPaths(root).locks, `stop-${String(session).replace(/[^A-Za-z0-9_-]/g, '_')}.count`);
}

// {promptId, missing, invalid, unrecorded}; a new prompt (a resumed turn) starts the counts again.
function readCounts(file, promptId) {
  try {
    const counts = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (counts.promptId === (promptId ?? null)) return { missing: 0, invalid: 0, unrecorded: 0, ...counts };
  } catch {}
  return { promptId: promptId ?? null, missing: 0, invalid: 0, unrecorded: 0 };
}

function writeCounts(file, counts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(counts));
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

function realDir(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

// Where a worker's report may be, nearest first: cwd and each folder above it up to the step's worktree (`worktree`,
// JH_CWD) when cwd is inside it, the top of the checkout holding cwd, and the worktree. A stop inside a nested
// repository of the worktree finds the report at the worktree's root. Paths are compared real, so a worktree named
// through a symlink still matches.
export function reportCandidates(cwd, worktree = process.env.JH_CWD) {
  const dirs = [];
  const add = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  const here = realDir(cwd);
  const top = worktree && path.isAbsolute(worktree) ? realDir(worktree) : null;
  add(here);
  if (top) {
    const chain = [];
    for (let dir = here; ; dir = path.dirname(dir)) {
      chain.push(dir);
      if (dir === top) {
        chain.forEach(add);
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  add(gitLocate(here)?.top);
  add(top);
  return dirs.map((dir) => path.join(dir, '.jevellan', 'report.json'));
}

function findReport(cwd) {
  return reportCandidates(cwd).find((file) => fs.existsSync(file)) ?? null;
}

function archivePath(root, task, step, suffix = '') {
  const dir = projectPaths(root).reports;
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${task}-s${step}-${compactTime()}${suffix}.json`);
}

function moveFile(file, target) {
  try {
    fs.renameSync(file, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(file, target);
    fs.unlinkSync(file);
  }
}

function endSession(root, { task, step, session }, status) {
  try {
    appendEvent(root, { kind: 'session.ended', task, step, session, data: { nativeSessionId: session, reason: `turn ended with a ${status} report` } });
  } catch (error) {
    logLine(root, 'stop', `${task} s${step}: session.ended not recorded: ${error?.message ?? error}`);
  }
}

// Records a report: step.report first (fitted to one line, reportFile naming the archive when there is a file), then
// the file moved to that archive, then session.ended. Returns false when the ledger refused the line; then nothing
// moved, and the turn is blocked with the reason while this turn's blocks last.
function recordReport(root, ctx, turn, data, { file = null, suffix = '' } = {}) {
  const { task, step, session } = ctx;
  let target = null;
  try {
    if (file) target = archivePath(root, task, step, suffix);
    appendEvent(root, { kind: 'step.report', task, step, session, data: fitReportLine(file ? { ...data, reportFile: target } : data) });
  } catch (error) {
    const why = redactText(String(error?.message ?? error)).replace(/\s+/g, ' ');
    const { counts, countsFile } = turn;
    if (counts.unrecorded < MAX_UNRECORDED_BLOCKS) {
      counts.unrecorded += 1;
      writeCounts(countsFile, counts);
      block(file
        ? `The ledger could not record the report (${why}). Leave .jevellan/report.json as it is and end your turn again.`
        : `The ledger could not record the end of the step (${why}). End your turn again.`);
      logLine(root, 'stop', `${task} s${step}: ${data.status} report not recorded, blocked (${counts.unrecorded}/${MAX_UNRECORDED_BLOCKS}): ${why}`);
    } else {
      logLine(root, 'stop', `${task} s${step}: ${data.status} report not recorded after ${MAX_UNRECORDED_BLOCKS} blocks${file ? `, ${file} left in place` : ''}: ${why}`);
    }
    return false;
  }
  if (file) {
    try {
      moveFile(file, target);
    } catch (error) {
      logLine(root, 'stop', `${task} s${step}: report recorded, but ${file} could not be moved to ${target}: ${error?.message ?? error}`);
    }
  }
  endSession(root, ctx, data.status);
  return true;
}

// answer and converse run with no tools in one turn (brief 5.6): their report is the fenced json block that ends the
// answer, or, without a valid block, the answer itself as a done report (the skills brief section 5's rule). They are
// never blocked.
function recordAnswer(root, ctx, answer) {
  const { task, step, session } = ctx;
  const found = lastJsonBlock(answer);
  const result = found?.parsed ? validateReport(found.value) : null;
  let data;
  if (result?.ok) {
    data = { ...result.report, reportFile: null, fromAnswer: true };
  } else {
    // Only a block that parsed and ends the answer was meant as the report and is left out; any other text stays.
    const ends = Boolean(found) && answer.slice(found.end).trim() === '';
    const kept = (found?.parsed && ends ? answer.slice(0, found.start) : answer).trim() || answer.trim() || 'The answer was empty.';
    const limitations = result ? result.problem : found && ends ? 'the json block at the end of the answer is not valid JSON' : 'no json report block at the end of the answer';
    data = { status: 'done', summary: cutText(kept, LIMITS.summary), synthesized: true, limitations };
  }
  appendEvent(root, { kind: 'step.report', task, step, session, data: fitReportLine(data) });
  endSession(root, ctx, data.status);
  logLine(root, 'stop', result?.ok
    ? `${task} s${step}: report ${data.status} taken from the answer's json block`
    : `${task} s${step}: no valid report block, recorded the answer as done`);
}

export function stopHook(input, root) {
  const task = process.env.JH_TASK;
  if (!task || !root) return;
  const session = input.session_id || process.env.JH_SESSION || 'unknown';
  // A nested session started from inside a worker inherits JH_TASK; only the worker's own session reports.
  if (process.env.JH_SESSION && input.session_id && input.session_id !== process.env.JH_SESSION) return;
  const step = Number(process.env.JH_STEP);
  if (!Number.isInteger(step) || step < 1) {
    logLine(root, 'stop', `JH_STEP is not a step number: ${process.env.JH_STEP}`);
    return;
  }
  const ctx = { task, step, session };
  const cwd = input.cwd || process.cwd();
  const countsFile = counterFile(root, session);
  const counts = readCounts(countsFile, input.prompt_id);
  const turn = { counts, countsFile };
  const reset = () => writeCounts(countsFile, { promptId: counts.promptId, missing: 0, invalid: 0, unrecorded: 0 });

  const file = findReport(cwd);
  if (!file && NO_TOOL_DUTIES.includes(process.env.JH_DUTY)) {
    recordAnswer(root, ctx, String(input.last_assistant_message ?? ''));
    reset();
    return;
  }
  if (!file) {
    if (counts.missing < MAX_MISSING_BLOCKS) {
      counts.missing += 1;
      writeCounts(countsFile, counts);
      block(MISSING_REASON);
      logLine(root, 'stop', `${task} s${step}: no report, blocked (${counts.missing}/${MAX_MISSING_BLOCKS})`);
      return;
    }
    if (!recordReport(root, ctx, turn, { status: 'blocked', summary: 'No report was written.', synthesized: true })) return;
    reset();
    logLine(root, 'stop', `${task} s${step}: no report after ${MAX_MISSING_BLOCKS} blocks, recorded blocked`);
    return;
  }

  let parsed;
  let problem = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    problem = `report.json: is not valid JSON (${error.message})`;
  }
  let report = null;
  if (!problem) {
    const result = validateReport(parsed);
    if (result.ok) report = result.report;
    else problem = result.problem;
  }
  if (problem) {
    if (counts.invalid < MAX_INVALID_BLOCKS) {
      counts.invalid += 1;
      writeCounts(countsFile, counts);
      block(`${problem}. Fix .jevellan/report.json and end your turn again.`);
      logLine(root, 'stop', `${task} s${step}: invalid report, blocked: ${problem}`);
      return;
    }
    const invalid = { status: 'blocked', summary: 'The report was not valid.', limitations: problem, synthesized: true };
    if (!recordReport(root, ctx, turn, invalid, { file, suffix: '-invalid' })) return;
    reset();
    logLine(root, 'stop', `${task} s${step}: invalid report again, recorded blocked: ${problem}`);
    return;
  }
  if (!recordReport(root, ctx, turn, report, { file })) return;
  reset();
  logLine(root, 'stop', `${task} s${step}: report ${report.status} recorded`);
}

if (isMain(import.meta.url)) runHook('stop', stopHook);
