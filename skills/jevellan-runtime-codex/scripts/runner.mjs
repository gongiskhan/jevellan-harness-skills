#!/usr/bin/env node
// The small parent a Codex step runs under. Codex runs no Stop hook, so this process stays alive for the turn: it
// feeds the message to `codex exec` on stdin, copies the JSON event stream to the step's log line by line with secrets
// masked, records the thread id as the session's native id (session.started) when Codex announces it, and when Codex
// exits does what the ledger's Stop hook does for Claude workers: a valid .jevellan/report.json becomes step.report
// and is archived; an invalid one becomes a blocked report with the problem; none becomes a blocked report marked
// synthesized.
//
//   node runner.mjs --spec <file>     (written by start.mjs or resume.mjs; never run by hand)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { importFromRole } from './lib/roles.mjs';
import { ledger, projectLib } from './lib/task.mjs';

const { fitReportLine, validateReport } = await importFromRole('ledger', 'scripts/lib/report-schema.mjs');
const { compactTime } = await importFromRole('ledger', 'scripts/lib/ids.mjs');
const { redactText } = await importFromRole('ledger', 'scripts/lib/redact.mjs');

function archivePath(root, task, step, suffix = '') {
  const dir = projectLib.projectPaths(root).reports;
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

// The report logic of the Stop hook, run once when the turn's process has ended. The step.report line (fitted to one
// ledger line, reportFile naming the archive) is appended first and the file moves to that archive only after: when
// the ledger refuses the line this throws and .jevellan/report.json stays where the worker wrote it, so the step
// shows as lost with its report still on disk instead of archived with no line pointing at it.
export function recordTurn({ root, task, step, session, cwd, threadId, exitCode, signal }) {
  const file = path.join(cwd, '.jevellan', 'report.json');
  let data;
  let suffix = null;
  if (!fs.existsSync(file)) {
    data = { status: 'blocked', summary: 'No report was written.', synthesized: true, limitations: `codex exec ended with ${signal ? `signal ${signal}` : `exit ${exitCode}`} and no .jevellan/report.json` };
  } else {
    let parsed;
    let problem = null;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      problem = `report.json: is not valid JSON (${error.message})`;
    }
    const result = problem ? null : validateReport(parsed);
    if (result?.ok) {
      data = { ...result.report };
      suffix = '';
    } else {
      problem = problem ?? result.problem;
      data = { status: 'blocked', summary: 'The report was not valid.', limitations: problem, synthesized: true };
      suffix = '-invalid';
    }
  }
  if (suffix !== null) data.reportFile = archivePath(root, task, step, suffix);
  const event = ledger.appendEvent(root, { kind: 'step.report', task, step, session, data: fitReportLine(data) });
  if (suffix !== null) {
    try {
      moveFile(file, data.reportFile);
    } catch (error) {
      process.stderr.write(`${task} s${step}: report recorded, but ${file} could not be moved to ${data.reportFile}: ${error?.message ?? error}\n`);
    }
  }
  try {
    ledger.appendEvent(root, { kind: 'session.ended', task, step, session, data: { nativeSessionId: threadId ?? null, reason: `codex exec ended (${signal ?? `exit ${exitCode}`}) with a ${data.status} report` } });
  } catch (error) {
    process.stderr.write(`${task} s${step}: session.ended not recorded: ${error?.message ?? error}\n`);
  }
  return event.data;
}

// Hands each complete line of a child's output stream to `onLine` as it arrives (decoded as UTF-8 across chunks);
// the returned function hands over a last line that had no newline.
function eachLine(stream, onLine) {
  let carry = '';
  stream.setEncoding('utf8');
  stream.on('data', (text) => {
    const lines = (carry + text).split('\n');
    carry = lines.pop();
    for (const line of lines) onLine(line);
  });
  return () => {
    if (carry) onLine(carry);
    carry = '';
  };
}

const DRAIN_MS = 2000;

// Resolves once every stream has ended, or after `ms`.
function drained(streams, ms) {
  const ended = (stream) => new Promise((resolve) => {
    if (stream.readableEnded || stream.destroyed) return resolve();
    stream.once('end', resolve);
    stream.once('close', resolve);
    stream.once('error', resolve);
  });
  let timer;
  return Promise.race([
    Promise.all(streams.map(ended)),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  const index = process.argv.indexOf('--spec');
  const spec = JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8'));
  const { root, task, step, session, cwd, model, args, env, message, logFile } = spec;
  const log = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.env.JH_CODEX_BIN || 'codex', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Codex dying before it read its message must not crash the runner: the turn's report is still recorded below.
  child.stdin.on('error', () => {});
  child.stdin.end(message);
  let threadId = spec.threadId ?? null;
  // Codex's output can carry what a command printed or was given, secrets included: every line goes through the
  // ledger's redactor before it reaches the log, whole, so a value is never split across two writes.
  let open = true;
  const write = (line) => {
    if (open) fs.writeSync(log, `${redactText(line)}\n`);
  };
  const flushOut = eachLine(child.stdout, (line) => {
    write(line);
    if (!line.includes('thread.started')) return;
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started' && event.thread_id && !spec.threadId) {
        threadId = event.thread_id;
        ledger.appendEvent(root, { kind: 'session.started', task, step, session, data: { role: 'worker', nativeSessionId: threadId, model, runtime: 'codex' } });
      }
    } catch {}
  });
  const flushErr = eachLine(child.stderr, write);
  const end = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ exitCode: null, signal: null, error }));
    child.on('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  // What was still in the pipes when Codex exited is written too; a process Codex left behind holding a pipe open
  // does not keep the report waiting for more than DRAIN_MS.
  await drained([child.stdout, child.stderr], DRAIN_MS);
  flushOut();
  flushErr();
  open = false;
  child.stdout.destroy();
  child.stderr.destroy();
  fs.closeSync(log);
  recordTurn({ root, task, step, session, cwd, threadId, exitCode: end.exitCode, signal: end.signal });
}

if (process.argv.includes('--spec')) {
  main().catch((error) => {
    process.stderr.write(`${redactText(String(error?.stack ?? error))}\n`);
    process.exitCode = 1;
  });
}
