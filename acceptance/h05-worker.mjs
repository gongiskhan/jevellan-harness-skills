// H5 Worker: start.mjs for a single investigate step. The worker's transcript shows the Skill tool invoking the
// investigate duty; the report arrives through the hook; wait returns it; resume continues the same session id after a
// "Continue." message; stop.mjs marks step.stopped. Elapsed times are recorded. A probe then checks that the
// read-only tool set can write the report file and nothing else.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { HARNESS, Journey, OUT_DIR, SANDBOX, ledgerCli, parseStream, readLedger, sh, skillDir, skillScript } from './lib.mjs';

const j = new Journey('H5', 'Worker');
const runtime = (script, args, opts = {}) => skillScript(SANDBOX, 'jevellan-runtime-claude', `scripts/${script}`, [...args, '--json'], opts);
const events = (task) => readLedger(SANDBOX).filter((e) => e.task === task);

const created = ledgerCli(SANDBOX, ['task', 'create', '--kind', 'single', '--duty', 'investigate', '--title', 'H5: where does the customers page produce the empty field error', '--text', 'Find where the customers page produces the error shown when a field of the new customer form is empty: the file and line that decide it, and the exact message text. Acceptance H5.', '--json']);
const task = created.json?.task;
j.check('task created', Boolean(task), created.stderr);
const wt = skillScript(SANDBOX, 'jevellan-git', 'scripts/worktree.mjs', ['create', '--task', task, '--json']).json;
j.check('worktree created', Boolean(wt?.path));

let t0 = Date.now();
const placement = skillScript(SANDBOX, 'jevellan-placement', 'scripts/route.mjs', ['--task', task, '--step', '1', '--duty', 'investigate'], { timeoutMs: 120_000 });
j.time('placement', Date.now() - t0);
let p = placement.json;
j.check('placed by Jev', placement.status === 0 && Boolean(p?.model), placement.stdout.slice(0, 300) || placement.stderr);
j.note(`placement: ${p?.model} ${p?.effort} via ${p?.provider} (${p?.kind})`);
// This journey is the Claude runtime's: when Jev places the step on another kind (H4 covers Jev's choice), the owner
// places it on Claude instead, as the coordinator would on the owner's word.
if (p && !/^claude-/.test(p.kind ?? '')) {
  const owner = skillScript(SANDBOX, 'jevellan-placement', 'scripts/route.mjs', ['--task', task, '--step', '1', '--duty', 'investigate', '--owner', 'claude-second/claude-sonnet-5-5/low'], { timeoutMs: 120_000 });
  j.note(`Jev chose ${p.kind}; the owner placed the step on claude-second claude-sonnet-5-5 low for this Claude runtime journey (exit ${owner.status})`);
  p = owner.json ?? p;
}

t0 = Date.now();
const started = runtime('start.mjs', ['--task', task, '--step', '1', '--duty', 'investigate', '--cwd', wt.path, '--provider', p.provider, '--model', p.model, '--effort', p.effort]);
const s = started.json;
j.check('start.mjs returns at once with a session and a pid', started.status === 0 && Boolean(s?.session) && Number.isInteger(s?.pid) && Date.now() - t0 < 5000, `${Date.now() - t0} ms ${started.stderr}`);
const startedLine = events(task).find((e) => e.kind === 'step.started');
j.check('step.started has the model, effort, pid and native session id', startedLine?.data?.model === p.model && startedLine?.data?.effort === p.effort && startedLine?.data?.pid === s.pid && startedLine?.data?.nativeSessionId === s.session);

const waited = ledgerCli(SANDBOX, ['wait', '--task', task, '--step', '1', '--timeout', '900', '--json'], { timeoutMs: 960_000 });
j.time('start to report', Date.now() - t0);
j.check('wait returns the report with exit 0', waited.status === 0 && waited.json?.kind === 'step.report', `${waited.status} ${waited.stdout.slice(0, 300)}`);
j.check('the report says done and answers the question', waited.json?.status === 'done' && /customers/i.test(waited.json?.summary ?? ''), (waited.json?.summary ?? '').slice(0, 300));
j.check('the report came from the file, archived by the hook', Boolean(waited.json?.reportFile) && fs.existsSync(waited.json.reportFile) && !waited.json.synthesized);

const log = fs.readFileSync(s.logFile, 'utf8');
fs.copyFileSync(s.logFile, path.join(OUT_DIR, `H5-${task}.stream.jsonl`));
const stream = parseStream(log);
const skillCalls = stream.tools.filter((t) => t.name === 'Skill').map((t) => t.input?.skill);
j.check('the transcript shows the Skill tool invoking the investigate duty', skillCalls.includes('jevellan-duty-investigate'), JSON.stringify(skillCalls));
const transcript = path.join(HARNESS, 'claude-config', 'projects', wt.path.replace(/[^A-Za-z0-9]/g, '-'), `${s.session}.jsonl`);
j.check('the native transcript is named by the session id', fs.existsSync(transcript), transcript);
const wrote = stream.tools.filter((t) => ['Write', 'Edit'].includes(t.name)).map((t) => t.input?.file_path);
j.check('the read-only worker wrote only its report file', wrote.every((f) => String(f).endsWith('.jevellan/report.json')), JSON.stringify(wrote));
j.check('the worktree has no change', sh('git', ['-C', wt.path, 'status', '--porcelain']).stdout.trim() === '');
const append = fs.readFileSync(s.appendFile, 'utf8');
j.check('the system prompt append was accepted (the worker followed the duty line)', /Use the duty skill for investigate now/.test(append) && skillCalls.length > 0);

// Resume with "Continue." in the same session.
t0 = Date.now();
const resumed = runtime('resume.mjs', ['--task', task, '--step', '1', '--message', 'Continue.']);
j.check('resume.mjs continues the same session id', resumed.status === 0 && resumed.json?.session === s.session, resumed.stderr || resumed.stdout.slice(0, 200));
const second = ledgerCli(SANDBOX, ['wait', '--task', task, '--step', '1', '--timeout', '900', '--json'], { timeoutMs: 960_000 });
j.time('resume to report', Date.now() - t0);
j.check('the resumed turn reported through the hook', second.status === 0 && second.json?.kind === 'step.report' && second.json?.seq > waited.json?.seq, `${second.status} ${(second.json?.summary ?? '').slice(0, 200)}`);
const starts = events(task).filter((e) => e.kind === 'step.started');
j.check('two step.started lines share the native session id', starts.length === 2 && starts.every((e) => e.data.nativeSessionId === s.session));
j.check('the message was recorded as step.message from the coordinator', events(task).some((e) => e.kind === 'step.message' && e.data.text === 'Continue.' && e.data.direction === 'coordinator'));
const resumedStream = parseStream(fs.readFileSync(s.logFile, 'utf8').slice(log.length));
j.check('the resumed turn ran in the same conversation', resumedStream.sessionId === s.session, resumedStream.sessionId);

// A third turn, stopped while it runs.
const third = runtime('resume.mjs', ['--task', task, '--step', '1', '--message', 'Before you answer again, read every file under src one by one and list each with one sentence.']);
await new Promise((r) => setTimeout(r, 4000));
const statusAlive = runtime('status.mjs', ['--task', task, '--step', '1']);
j.check('status.mjs says alive while the turn runs', statusAlive.json?.state === 'alive', JSON.stringify(statusAlive.json));
t0 = Date.now();
const stopped = runtime('stop.mjs', ['--task', task, '--step', '1', '--reason', 'acceptance H5 stops the third turn']);
j.time('stop', Date.now() - t0);
j.check('stop.mjs ends the turn and marks step.stopped', stopped.status === 0 && events(task).some((e) => e.kind === 'step.stopped'), stopped.stdout.slice(0, 200));
let gone = false;
try {
  process.kill(third.json.pid, 0);
} catch {
  gone = true;
}
j.check('the worker process is gone', gone);
const after = runtime('status.mjs', ['--task', task, '--step', '1']);
j.check('status.mjs says exited after the stop', after.json?.state === 'exited');
j.check('the task is stopped in the projection', !(ledgerCli(SANDBOX, ['status', '--json']).json?.tasks ?? []).some((t) => t.task === task));

// The read-only tool set writes the report file and nothing else (a scratch repository, no JH_TASK).
const { claudeArgs } = await import(pathToFileURL(path.join(skillDir(SANDBOX, 'jevellan-runtime-claude'), 'scripts', 'lib', 'step.mjs')).href);
const E = await import(pathToFileURL(path.join(skillDir(SANDBOX, 'jevellan-runtime-claude'), 'scripts', 'lib', 'env.mjs')).href);
const probe = fs.mkdtempSync(path.join(OUT_DIR, 'h5-probe-'));
sh('git', ['init', '-q', probe]);
fs.mkdirSync(path.join(probe, '.jevellan'));
const appendFile = path.join(probe, 'append.md');
fs.writeFileSync(appendFile, 'This is a permission probe.\n');
const args = claudeArgs({ duty: 'investigate', session: crypto.randomUUID(), model: 'claude-sonnet-5-5', effort: 'low', appendFile, cwd: probe, prompt: 'Do two things with the Write tool: first create notes.txt containing "hi"; then create .jevellan/report.json containing {"status":"done","summary":"probe"}. Then say which of the two worked.' });
const env = E.workerEnv({ provider: E.findProvider('claude-second'), task: 'TPROBE1', step: 1, duty: 'investigate', project: probe, session: 'probe' });
for (const k of ['JH_TASK', 'JH_STEP', 'JH_DUTY', 'JH_PROJECT', 'JH_SESSION']) delete env[k];
const r = sh('claude', args, { cwd: probe, env, timeoutMs: 240_000 });
j.check('read-only tools: notes.txt was refused', !fs.existsSync(path.join(probe, 'notes.txt')));
j.check('read-only tools: .jevellan/report.json was allowed', fs.existsSync(path.join(probe, '.jevellan', 'report.json')), parseStream(r.stdout).result?.slice(0, 200));

const archived = skillScript(SANDBOX, 'jevellan-git', 'scripts/worktree.mjs', ['archive', '--task', task, '--reason', 'acceptance H5 finished', '--json']);
j.check('worktree archived', archived.status === 0);
j.finish();
