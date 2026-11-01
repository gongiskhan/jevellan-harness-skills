// H3 Hooks: real `claude -p` workers in a sandbox worktree, with JH_TASK set the way the runtime sets it.
// - a worker that ends without a report is blocked twice and then recorded blocked, synthesized;
// - a worker that writes a valid report gets step.report in the ledger and the file archived;
// - an invalid report is blocked with the first problem;
// - SessionStart prints the task ledger for a worker and the open work for a coordinator;
// - PostToolUse lines carry tool names and no contents.
// The journey's tasks are closed with step.stopped at the end, so they never show as open work.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { HARNESS, Journey, OUT_DIR, SANDBOX, git, ledgerCli, ledgerLib, parseStream, readLedger, runtimeEnvLib, sh } from './lib.mjs';

const j = new Journey('H3', 'Hooks');
const L = await ledgerLib(SANDBOX);
const E = await runtimeEnvLib();
const provider = E.findProvider('claude-second');
const scratch = fs.mkdtempSync(path.join(OUT_DIR, 'h3-'));
const opened = [];

function newTask(title) {
  const r = ledgerCli(SANDBOX, ['task', 'create', '--kind', 'single', '--duty', 'investigate', '--title', title, '--text', `Acceptance H3: ${title}.`, '--json']);
  if (r.status !== 0) throw new Error(r.stderr);
  opened.push(r.json.task);
  return r.json.task;
}

function makeWorktree(task) {
  const dir = path.join(HARNESS, 'worktrees', path.basename(SANDBOX), `h3-${task}`);
  const branch = `jh/h3-${task}`;
  const r = sh('git', ['-C', SANDBOX, 'worktree', 'add', '-q', '-b', branch, dir, 'main']);
  if (r.status !== 0) throw new Error(r.stderr);
  fs.symlinkSync(path.join(SANDBOX, '.claude'), path.join(dir, '.claude'));
  fs.mkdirSync(path.join(dir, '.jevellan', 'evidence'), { recursive: true });
  L.appendEvent(SANDBOX, { kind: 'task.worktree', task, data: { branch, path: dir, base: 'main' } });
  return dir;
}

function runWorker(task, cwd, prompt, { readOnly }) {
  const session = crypto.randomUUID();
  const env = E.workerEnv({ provider, task, step: 1, duty: 'investigate', project: SANDBOX, session });
  const args = ['-p', '--session-id', session, '--model', 'claude-sonnet-5-5', '--effort', 'low', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--settings', E.workerSettings()];
  if (readOnly) args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep');
  else args.push('--permission-mode', 'bypassPermissions');
  args.push('--', prompt);
  const t0 = Date.now();
  const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  L.appendEvent(SANDBOX, { kind: 'step.started', task, step: 1, session, data: { ordinal: 1, duty: 'investigate', runtime: 'claude', provider: provider.name, model: 'claude-sonnet-5-5', effort: 'low', cwd, nativeSessionId: session, pid: child.pid } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  return new Promise((resolve) => child.on('exit', (code) => {
    fs.writeFileSync(path.join(scratch, `${task}.stream.jsonl`), out);
    resolve({ code, ms: Date.now() - t0, stream: parseStream(out), session });
  }));
}

const taskEvents = (task) => readLedger(SANDBOX).filter((e) => e.task === task);
const hookLog = () => fs.readFileSync(path.join(SANDBOX, '.jevellan', 'hooks.log'), 'utf8');

// (a) no report
const ta = newTask('end without a report');
const wa = makeWorktree(ta);
const ra = await runWorker(ta, wa, 'This is a test of a hook. Reply with the single word READY and end your turn. You have no tool that writes files; if anything asks you for a report file, reply READY again and end your turn.', { readOnly: true });
j.time('worker without a report', ra.ms);
const stopsA = ra.stream.hooks.filter((h) => h.subtype === 'hook_response' && h.hook_event === 'Stop');
const blocksA = hookLog().split('\n').filter((l) => l.includes(`${ta} s1: no report, blocked`));
j.check('the worker without a report was blocked twice', blocksA.length === 2 && stopsA.length >= 3, `${blocksA.length} blocks logged, ${stopsA.length} Stop calls`);
const reportA = taskEvents(ta).find((e) => e.kind === 'step.report');
j.check('then recorded blocked, synthesized', reportA?.data?.status === 'blocked' && reportA?.data?.synthesized === true, JSON.stringify(reportA?.data));
const ssA = ra.stream.hooks.find((h) => h.subtype === 'hook_response' && h.hook_event === 'SessionStart');
j.check('SessionStart printed the task ledger to the worker', Boolean(ssA?.stdout?.startsWith(`Ledger for task ${ta}, step 1:`)), (ssA?.stdout ?? '').split('\n').slice(0, 2).join(' | '));

// (b) valid report
const tb = newTask('write a valid report');
const wb = makeWorktree(tb);
const reportText = '{"status":"done","summary":"H3 valid report test: nothing changed.","changedFiles":[]}';
const rb = await runWorker(tb, wb, `Create the file .jevellan/report.json in the current folder with exactly this content and nothing else, then end your turn:\n${reportText}`, { readOnly: false });
j.time('worker with a valid report', rb.ms);
const reportB = taskEvents(tb).find((e) => e.kind === 'step.report');
j.check('the valid report is in the ledger as step.report', reportB?.data?.status === 'done' && !reportB?.data?.synthesized, JSON.stringify(reportB?.data));
j.check('the report file was archived under the project reports folder', Boolean(reportB?.data?.reportFile?.startsWith(path.join(SANDBOX, '.jevellan', 'reports'))) && fs.existsSync(reportB?.data?.reportFile ?? '/nonexistent'), reportB?.data?.reportFile);
j.check('the worktree no longer has report.json', !fs.existsSync(path.join(wb, '.jevellan', 'report.json')));
const writeEvents = taskEvents(tb).filter((e) => e.kind === 'session.event');
j.check('PostToolUse recorded the Write with the file path', writeEvents.some((e) => e.data.tool === 'Write' && e.data.summary.endsWith('.jevellan/report.json')), JSON.stringify(writeEvents.map((e) => e.data)));
j.check('PostToolUse lines carry no file contents', !readLedger(SANDBOX).some((e) => e.kind === 'session.event' && JSON.stringify(e.data).includes('nothing changed')));

// (c) invalid report
const tc = newTask('write an invalid report');
const wc = makeWorktree(tc);
const rc = await runWorker(tc, wc, 'Create the file .jevellan/report.json with exactly this content, then end your turn:\n{"status":"needs-decision","summary":"H3 invalid report test.","question":"Blue or Green?","options":[{"label":"Blue"}]}\nIf you are told the report is not valid, add the option {"label":"Green"} to it and end your turn again.', { readOnly: false });
j.time('worker with an invalid report', rc.ms);
const invalidLog = hookLog().split('\n').find((l) => l.includes(`${tc} s1: invalid report, blocked`));
j.check('the invalid report was blocked with the first problem', Boolean(invalidLog?.includes('report.json: options must have 2 to 4 items')), invalidLog);
const reportC = taskEvents(tc).find((e) => e.kind === 'step.report');
j.check('the corrected report was then recorded', reportC?.data?.status === 'needs-decision' && reportC?.data?.options?.length === 2, JSON.stringify(reportC?.data));

// (d) coordinator session: the open work
const env = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: 'C.UTF-8', TERM: 'dumb', SHELL: process.env.SHELL, TMPDIR: '/tmp', ...E.providerLogin(provider), CLAUDE_CONFIG_DIR: E.claudeConfigDir(), ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
const coord = sh('claude', ['-p', '--model', 'claude-haiku-5-5', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--settings', E.workerSettings(), '--tools', '', '--', 'Reply with the word OK.'], { cwd: SANDBOX, env, timeoutMs: 180_000 });
const ssCoord = parseStream(coord.stdout).hooks.find((h) => h.subtype === 'hook_response' && h.hook_event === 'SessionStart');
j.check('SessionStart printed the open work to a coordinator session', Boolean(ssCoord?.stdout?.includes("Open work in this project's ledger:") && ssCoord.stdout.includes(tc)), (ssCoord?.stdout ?? '').replace(/\n/g, ' | ').slice(0, 300));

// Close the journey's tasks and check the ledger.
for (const task of opened) L.appendEvent(SANDBOX, { kind: 'step.stopped', task, step: 1, data: { ordinal: 1, reason: 'acceptance H3 finished' } });
const verify = ledgerCli(SANDBOX, ['verify', '--json']);
j.check('the sandbox ledger verifies', verify.json?.ok === true, verify.stdout.trim().slice(0, 200));
const open = ledgerCli(SANDBOX, ['status', '--json']).json?.tasks ?? [];
j.check('no H3 task is left open', !open.some((t) => opened.includes(t.task)));
j.check('the sandbox checkout stays clean', git(SANDBOX, ['status', '--porcelain']) === '');
j.note(`H3 worktrees: ${opened.map((t) => `h3-${t}`).join(', ')} under ${path.join(HARNESS, 'worktrees', path.basename(SANDBOX))}`);
j.finish();
