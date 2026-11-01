// H2 Ledger: 10 concurrent processes append 50 lines each and verify passes; status on scripted sequences yields
// the states of section 4 for every rule; wait returns within 600 ms of a report line. Runs on a clone of the
// sandbox with the skills installed, so the sandbox's own ledger does not fill with test tasks.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Journey, NODE, OUT_DIR, REPO, SANDBOX, ledgerCli, ledgerLib, sh, skillDir } from './lib.mjs';

const j = new Journey('H2', 'Ledger');
const scratch = fs.mkdtempSync(path.join(OUT_DIR, 'h2-'));
const clone = path.join(scratch, 'jevellan-harness-sandbox');
sh('git', ['clone', '--quiet', '--local', SANDBOX, clone]);
const install = sh(NODE, [path.join(REPO, 'install.mjs'), clone, '--json']);
j.check('skills installed on the clone', install.status === 0, install.stderr.trim());
const ledgerScript = path.join(skillDir(clone, 'jevellan-ledger'), 'scripts', 'ledger.mjs');

// 10 processes x 50 appends through the command line.
const t0 = Date.now();
const writers = Array.from({ length: 10 }, (_, w) => new Promise((resolve) => {
  const child = spawn('sh', ['-c', `i=0; while [ $i -lt 50 ]; do "${NODE}" "${ledgerScript}" append note --data '{"text":"writer ${w} line '$i'"}' >/dev/null || exit 1; i=$((i+1)); done`], { cwd: clone, stdio: 'ignore' });
  child.on('exit', (code) => resolve(code));
}));
const codes = await Promise.all(writers);
j.time('10 x 50 appends through ledger.mjs', Date.now() - t0);
j.check('every writer exited 0', codes.every((c) => c === 0), codes.join(','));
const verify = ledgerCli(clone, ['verify', '--json']);
j.check('verify passes on 500 lines', verify.status === 0 && verify.json?.ok === true && verify.json?.lines === 500, verify.stdout.trim());
const lines = fs.readFileSync(path.join(clone, '.jevellan', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
j.check('seq runs 1 to 500 without a gap', lines.every((e, i) => e.seq === i + 1));
for (let w = 0; w < 10; w += 1) {
  const mine = lines.filter((e) => e.data.text.startsWith(`writer ${w} `)).map((e) => Number(e.data.text.split(' ').pop()));
  if (!mine.every((n, i) => n === i)) j.check(`writer ${w}'s lines are in order`, false, mine.join(','));
}
j.check('each writer\'s lines are in its own order', true);

// Scripted sequences, one task per rule, written the way the scripts and hooks write them.
const L = await ledgerLib(clone);
const add = (kind, task, step, data = {}) => L.appendEvent(clone, { kind, task, step, session: 'h2', data });
let n = 0;
const task = (kind = 'feature', extra = {}) => {
  n += 1;
  const id = `TH2${String(n).padStart(4, '0')}`.replace(/[ILOU]/g, 'X').slice(0, 7);
  add('task.created', id, undefined, { kind, title: `H2 rule ${n}`, text: 'scripted', parent: null, after: null, origin: 'owner', ...extra });
  return id;
};
const workflow = (id) => add('task.workflow', id, undefined, { steps: [{ ordinal: 1, duty: 'implement', instructions: 'x' }, { ordinal: 2, duty: 'verify', instructions: 'y', onFail: { goto: 1, maxLoops: 2 } }], skipped: [], questions: {} });
const started = (id, step, pid = 999999) => add('step.started', id, step, { ordinal: step, duty: step === 1 ? 'implement' : 'verify', runtime: 'claude', provider: 'claude-main', model: 'claude-opus-5-5', effort: 'high', cwd: '/x', nativeSessionId: 'n', pid });
const report = (id, step, data) => add('step.report', id, step, { summary: 'scripted', ...data });
const expected = {};
// stopped
let id = task(); workflow(id); started(id, 1, process.pid); add('step.stopped', id, 1, { ordinal: 1, reason: 'owner' }); expected[id] = 'stopped';
// done by landing
id = task(); workflow(id); started(id, 1, process.pid); report(id, 1, { status: 'done' }); add('step.done', id, 1, { ordinal: 1 }); started(id, 2, process.pid); report(id, 2, { status: 'done' }); add('step.done', id, 2, { ordinal: 2 }); add('landing.decided', id, undefined, { route: 'land' }); add('task.landed', id, undefined, { commit: 'abc' }); expected[id] = 'done';
// done: single read-only
id = task('single', { duty: 'investigate' }); started(id, 1, process.pid); report(id, 1, { status: 'done' }); expected[id] = 'done';
// single write duty with changes: still open
id = task('single', { duty: 'document' }); started(id, 1, process.pid); report(id, 1, { status: 'done', changedFiles: ['README.md'] }); expected[id] = 'queued';
// waiting-owner: needs-decision, blocked, landing ask
id = task(); workflow(id); started(id, 1, process.pid); report(id, 1, { status: 'needs-decision', question: 'Blue or Green?', options: [{ label: 'Blue' }, { label: 'Green' }] }); expected[id] = 'waiting-owner';
id = task(); workflow(id); started(id, 1, process.pid); report(id, 1, { status: 'blocked' }); expected[id] = 'waiting-owner';
id = task(); workflow(id); started(id, 1, process.pid); report(id, 1, { status: 'done' }); add('step.done', id, 1, {}); started(id, 2, process.pid); report(id, 2, { status: 'done' }); add('step.done', id, 2, {}); add('landing.decided', id, undefined, { route: 'ask-owner' }); add('task.asked', id, undefined, { question: 'Land?', options: ['Land now', 'Leave it'] }); expected[id] = 'waiting-owner';
// landing
id = task(); workflow(id); started(id, 1, process.pid); report(id, 1, { status: 'done' }); add('step.done', id, 1, {}); started(id, 2, process.pid); report(id, 2, { status: 'done' }); add('step.done', id, 2, {}); add('landing.decided', id, undefined, { route: 'land' }); expected[id] = 'landing';
// failed: step.failed, step.lost
id = task(); workflow(id); started(id, 1, process.pid); add('step.failed', id, 1, { ordinal: 1, reason: 'crashed' }); expected[id] = 'failed';
id = task(); workflow(id); started(id, 1, process.pid); add('step.lost', id, 1, { ordinal: 1, pid: 1 }); expected[id] = 'failed';
// running (pid alive), lost when the pid is gone (status marks it, then failed)
id = task(); workflow(id); started(id, 1, process.pid); expected[id] = 'running';
const dead = sh('sh', ['-c', 'echo $$']).stdout.trim();
id = task(); workflow(id); started(id, 1, Number(dead)); expected[id] = 'failed';
const lostTask = id;
// queued
id = task(); expected[id] = 'queued';
// retry resets
id = task(); workflow(id); started(id, 1, process.pid); report(id, 1, { status: 'done' }); add('step.done', id, 1, {}); started(id, 2, process.pid); report(id, 2, { status: 'done', testsRun: { command: 'npm test', passed: false, summary: 'one failed' } }); add('step.retrying', id, 2, { ordinal: 2, attempt: 1, gotoOrdinal: 1, reason: 'tests failed' }); expected[id] = 'queued';

const status = ledgerCli(clone, ['status', '--json']);
const all = [...(status.json?.tasks ?? []), ...(status.json?.recent ?? [])];
for (const [task, state] of Object.entries(expected)) {
  const got = all.find((t) => t.task === task)?.state ?? (state === 'done' || state === 'stopped' ? 'absent' : 'missing');
  j.check(`status: ${task} is ${state}`, got === state, `got ${got}`);
}
j.check('status marked the dead pid\'s step lost', (status.json?.lost ?? []).some((l) => l.task === lostTask));
const brief = ledgerCli(clone, ['status', '--brief']);
j.check('status --brief prints at most five lines', brief.stdout.trim().split('\n').length <= 5, `${brief.stdout.trim().split('\n').length} lines`);
const wf = ledgerCli(clone, ['status']);
j.check('waiting-owner tasks come first', wf.stdout.trim().split('\n')[0] === 'Waiting on the owner:', wf.stdout.split('\n')[0]);

// wait returns within 600 ms of the report line.
id = task('single', { duty: 'investigate' }); started(id, 1, process.pid);
const waiter = spawn(NODE, [ledgerScript, 'wait', '--task', id, '--step', '1', '--json'], { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
waiter.stdout.on('data', (d) => { out += d; });
const exited = new Promise((resolve) => waiter.on('exit', (code) => resolve({ code, at: Date.now() })));
await new Promise((r) => setTimeout(r, 1300));
const appendedAt = Date.now();
report(id, 1, { status: 'done', summary: 'H2 wait check' });
const { code, at } = await exited;
j.time('wait after the report line', at - appendedAt);
j.check('wait returns within 600 ms of the report line with exit 0', code === 0 && at - appendedAt < 600, `${at - appendedAt} ms, exit ${code}`);
j.check('wait prints the report', JSON.parse(out).summary === 'H2 wait check');
j.finish();
