#!/usr/bin/env node
// The small parent a Codex step runs under. Codex runs no Stop hook, so this process stays alive for the turn: it
// feeds the message to `codex exec` on stdin, copies the JSON event stream to the step's log, records the thread id as
// the session's native id (session.started) when Codex announces it, and when Codex exits does what the ledger's Stop
// hook does for Claude workers: a valid .jevellan/report.json becomes step.report and is archived; an invalid one
// becomes a blocked report with the problem; none becomes a blocked report marked synthesized.
//
//   node runner.mjs --spec <file>     (written by start.mjs or resume.mjs; never run by hand)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { importFromRole } from './lib/roles.mjs';
import { ledger, projectLib } from './lib/task.mjs';

const { validateReport } = await importFromRole('ledger', 'scripts/lib/report-schema.mjs');
const { compactTime } = await importFromRole('ledger', 'scripts/lib/ids.mjs');

function archive(root, file, task, step, suffix = '') {
  const dir = projectLib.projectPaths(root).reports;
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

// The report logic of the Stop hook, run once when the turn's process has ended.
export function recordTurn({ root, task, step, session, cwd, threadId, exitCode, signal }) {
  const ctx = { kind: 'step.report', task, step, session };
  const file = path.join(cwd, '.jevellan', 'report.json');
  let data;
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
    if (result?.ok) data = { ...result.report, reportFile: archive(root, file, task, step) };
    else {
      problem = problem ?? result.problem;
      data = { status: 'blocked', summary: 'The report was not valid.', limitations: problem, synthesized: true, reportFile: archive(root, file, task, step, '-invalid') };
    }
  }
  ledger.appendEvent(root, { ...ctx, data });
  ledger.appendEvent(root, { kind: 'session.ended', task, step, session, data: { nativeSessionId: threadId ?? null, reason: `codex exec ended (${signal ?? `exit ${exitCode}`}) with a ${data.status} report` } });
  return data;
}

async function main() {
  const index = process.argv.indexOf('--spec');
  const spec = JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8'));
  const { root, task, step, session, cwd, model, args, env, message, logFile } = spec;
  const log = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.env.JH_CODEX_BIN || 'codex', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(message);
  let threadId = spec.threadId ?? null;
  let carry = '';
  child.stdout.on('data', (chunk) => {
    fs.writeSync(log, chunk);
    const text = carry + chunk.toString('utf8');
    const lines = text.split('\n');
    carry = lines.pop();
    for (const line of lines) {
      if (!line.includes('thread.started')) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started' && event.thread_id && !spec.threadId) {
          threadId = event.thread_id;
          ledger.appendEvent(root, { kind: 'session.started', task, step, session, data: { role: 'worker', nativeSessionId: threadId, model, runtime: 'codex' } });
        }
      } catch {}
    }
  });
  child.stderr.on('data', (chunk) => fs.writeSync(log, chunk));
  const end = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ exitCode: null, signal: null, error }));
    child.on('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  fs.closeSync(log);
  recordTurn({ root, task, step, session, cwd, threadId, exitCode: end.exitCode, signal: end.signal });
}

if (process.argv.includes('--spec')) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
