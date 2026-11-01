#!/usr/bin/env node
// Stop hook: makes a worker end its step with a report, and records the report in the ledger.
//
// Only for worker sessions (JH_TASK set by the runtime); every other session is left alone. When the worker stops:
// - no .jevellan/report.json: block (the session continues with the reason) at most twice per turn, then record a
//   blocked report marked synthesized;
// - an invalid report: block once with the first problem, then record a blocked report with the problem in
//   limitations;
// - a valid report: append step.report (summary at most 4000 characters, reportFile set), move the file to
//   <project>/.jevellan/reports/<task>-s<step>-<time>.json, and let the session end.
// Ported from the skills repo's report-guard.mts (which asked for jv_report instead of a file).

import fs from 'node:fs';
import path from 'node:path';
import { isMain, runHook, logLine } from '../scripts/lib/hook.mjs';
import { appendEvent } from '../scripts/lib/ledger.mjs';
import { gitLocate, projectPaths } from '../scripts/lib/project.mjs';
import { validateReport } from '../scripts/lib/report-schema.mjs';
import { compactTime } from '../scripts/lib/ids.mjs';

export const MISSING_REASON =
  'End the step by writing .jevellan/report.json with status progress, done, blocked or needs-decision (see your duty skill).';
const MAX_MISSING_BLOCKS = 2;
const MAX_INVALID_BLOCKS = 1;

function counterFile(root, session) {
  return path.join(projectPaths(root).locks, `stop-${String(session).replace(/[^A-Za-z0-9_-]/g, '_')}.count`);
}

// {promptId, missing, invalid}; a new prompt (a resumed turn) starts the counts again.
function readCounts(file, promptId) {
  try {
    const counts = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (counts.promptId === (promptId ?? null)) return counts;
  } catch {}
  return { promptId: promptId ?? null, missing: 0, invalid: 0 };
}

function writeCounts(file, counts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(counts));
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

function findReport(cwd) {
  const candidates = [path.join(cwd, '.jevellan', 'report.json')];
  const top = gitLocate(cwd)?.top;
  if (top && top !== cwd) candidates.push(path.join(top, '.jevellan', 'report.json'));
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function archive(root, file, task, step, suffix = '') {
  const dir = projectPaths(root).reports;
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${task}-s${step}-${compactTime()}${suffix}.json`);
  try {
    fs.renameSync(file, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(file, target);
    fs.unlinkSync(file);
  }
  return target;
}

function record(root, { task, step, session }, data) {
  appendEvent(root, { kind: 'step.report', task, step, session, data });
  appendEvent(root, { kind: 'session.ended', task, step, session, data: { nativeSessionId: session, reason: `turn ended with a ${data.status} report` } });
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
  const reset = () => writeCounts(countsFile, { promptId: counts.promptId, missing: 0, invalid: 0 });

  const file = findReport(cwd);
  if (!file) {
    if (counts.missing < MAX_MISSING_BLOCKS) {
      counts.missing += 1;
      writeCounts(countsFile, counts);
      block(MISSING_REASON);
      logLine(root, 'stop', `${task} s${step}: no report, blocked (${counts.missing}/${MAX_MISSING_BLOCKS})`);
      return;
    }
    record(root, ctx, { status: 'blocked', summary: 'No report was written.', synthesized: true });
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
    const kept = archive(root, file, task, step, '-invalid');
    record(root, ctx, { status: 'blocked', summary: 'The report was not valid.', limitations: problem, synthesized: true, reportFile: kept });
    reset();
    logLine(root, 'stop', `${task} s${step}: invalid report again, recorded blocked: ${problem}`);
    return;
  }
  const reportFile = archive(root, file, task, step);
  record(root, ctx, { ...report, reportFile });
  reset();
  logLine(root, 'stop', `${task} s${step}: report ${report.status} recorded`);
}

if (isMain(import.meta.url)) runHook('stop', stopHook);
