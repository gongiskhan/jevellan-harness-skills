#!/usr/bin/env node
// The small parent a Codex step runs under, internal to this skill: start.mjs and resume.mjs spawn it detached (it
// leads the step's process group), nothing else runs it. Codex runs no Stop hook, so this process stays alive for the
// turn: it feeds the message to `codex exec` on stdin, copies the JSON event stream to the step's log line by line
// with secrets masked, records the thread id as the session's native id (session.started) when Codex announces it,
// and when Codex exits hands the turn to the ledger skill's take-report, which does what the Stop hook does for a
// Claude worker: a valid .jevellan/report.json becomes step.report and is archived, an invalid one a blocked report
// with the problem, none a blocked report marked synthesized, then session.ended.
//
// Both lines follow the turn's step.started: the runner records nothing before the start that spawned it (the line
// with its own pid) is in the ledger, so the ledger never reads a report or a session ahead of the start it ends.
//
//   node lib/runner.mjs --spec <file>     (written by start.mjs or resume.mjs; never run by hand)

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { appendLine, callLedger } from './ledger-client.mjs';
import { redactText } from './redact.mjs';

// How long the runner waits for its start to reach the ledger, and how often it looks. A start that never arrives
// means start.mjs died between spawning and appending; the turn is recorded anyway after the wait.
export const START_WAIT_MS = 30_000;
const START_POLL_MS = 150;

// What ended the turn, as take-report puts it in the report's limitations and the session.ended reason.
export function endedText({ exitCode, signal, error }) {
  if (error) return `codex exec did not run (${error.code ?? error.message})`;
  if (signal) return `codex exec ended with signal ${signal}`;
  return `codex exec ended with exit ${exitCode}`;
}

// Whether the ledger holds the step.started of this runner (its pid, its session).
export function startRecorded({ root, task, step, session, pid = process.pid }) {
  try {
    const { events } = callLedger(['events', '--task', task, '--kind', 'step.started'], { cwd: root });
    return events.some((e) => e.step === step && e.session === session && e.data?.pid === pid);
  } catch {
    return false;
  }
}

// Resolves true once `recorded()` (by default: the start is in the ledger) holds, false after `ms`.
export async function waitForStart(spec, { ms = START_WAIT_MS, pollMs = START_POLL_MS, recorded = () => startRecorded(spec) } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (recorded()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// The ledger's take-report command line for a turn that ended.
export function takeReportArgs({ task, step, session, cwd, threadId, exitCode, signal, error }) {
  const args = ['take-report', '--task', task, '--step', String(step), '--session', session, '--cwd', cwd];
  if (threadId) args.push('--native-session', threadId);
  args.push('--ended', endedText({ exitCode, signal, error }));
  return args;
}

// The turn's report, through the ledger skill's take-report: called once the turn's process has ended. Returns what
// take-report printed ({task, step, seq, status, synthesized, reportFile, sessionEndedSeq}); throws LedgerCallError
// when the ledger refused the line, and .jevellan/report.json then stays where the worker wrote it.
export function recordTurn(turn) {
  return callLedger(takeReportArgs(turn), { cwd: turn.root });
}

export function recordSession({ root, task, step, session, model }, threadId) {
  return appendLine(root, 'session.started', { task, step, session, data: { role: 'worker', nativeSessionId: threadId, model, runtime: 'codex' } });
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

function note(spec, text) {
  process.stderr.write(`${spec.task} s${spec.step}: ${redactText(text)}\n`);
}

async function main() {
  const index = process.argv.indexOf('--spec');
  const spec = JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8'));
  const { root, task, step, session, cwd, args, env, message, logFile } = spec;
  const log = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.env.JH_CODEX_BIN || 'codex', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Codex dying before it read its message must not crash the runner: the turn's report is still recorded below.
  child.stdin.on('error', () => {});
  child.stdin.end(message);
  let threadId = spec.threadId ?? null;
  const announce = (id) => {
    try {
      recordSession(spec, id);
    } catch (error) {
      note(spec, `session.started not recorded: ${error?.message ?? error}`);
    }
  };
  // A thread Codex announces before the start is in the ledger waits for it.
  let started = false;
  let pendingThread = null;
  const startWait = waitForStart(spec).then((found) => {
    started = true;
    if (!found) note(spec, `the step.started of pid ${process.pid} did not reach the ledger in ${START_WAIT_MS / 1000} s; recording the turn anyway`);
    if (pendingThread) announce(pendingThread);
    pendingThread = null;
  });
  // Codex's output can carry what a command printed or was given, secrets included: every line is masked before it
  // reaches the log, whole, so a value is never split across two writes.
  let open = true;
  const write = (line) => {
    if (open) fs.writeSync(log, `${redactText(line)}\n`);
  };
  const flushOut = eachLine(child.stdout, (line) => {
    write(line);
    if (!line.includes('thread.started')) return;
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started' && event.thread_id && !spec.threadId && !threadId) {
        threadId = event.thread_id;
        if (started) announce(threadId);
        else pendingThread = threadId;
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
  await startWait;
  const out = recordTurn({ root, task, step, session, cwd, threadId, ...end });
  note(spec, `${out.status} report recorded (#${out.seq})${out.synthesized ? ', synthesized' : ''}`);
  for (const warning of out.warnings ?? []) note(spec, warning);
}

if (process.argv.includes('--spec')) {
  main().catch((error) => {
    process.stderr.write(`${redactText(String(error?.stack ?? error))}\n`);
    process.exitCode = 1;
  });
}
