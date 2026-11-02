// Phase 6 smoke: one single investigate step on the real codex exec through the Codex runtime, placed by an owner
// placement (so Jev's policy is not involved), on a clone of the sandbox. H10 is the journey proper.

import fs from 'node:fs';
import path from 'node:path';
import { Journey, NODE, OUT_DIR, REPO, SANDBOX, ledgerCli, readLedger, sh, skillScript } from './lib.mjs';

const j = new Journey('P6', 'Codex runtime smoke (phase 6 check)');
const clone = path.join(fs.mkdtempSync(path.join(OUT_DIR, 'p6-')), 'jevellan-harness-sandbox');
sh('git', ['clone', '--quiet', '--local', SANDBOX, clone]);
sh('git', ['-C', clone, 'remote', 'remove', 'origin']);
j.check('installed', sh(NODE, [path.join(REPO, 'install.mjs'), clone, '--json']).status === 0);
const pj = path.join(clone, '.jevellan', 'project.json');
fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, 'utf8')), setupCommand: null }, null, 2));
const task = ledgerCli(clone, ['task', 'create', '--kind', 'single', '--duty', 'investigate', '--title', 'Codex smoke: which port', '--text', 'Which port does the web server in src/web/server.ts listen on, and where is it set? Answer with the file and line.', '--json']).json.task;
const wt = skillScript(clone, 'jevellan-git', 'scripts/worktree.mjs', ['create', '--task', task, '--json']).json;
const placed = skillScript(clone, 'jevellan-router', 'scripts/route.mjs', ['--task', task, '--step', '1', '--duty', 'investigate', '--owner', 'codex/gpt-6-astra/low']);
j.check('owner placement on codex', placed.status === 0, placed.stdout.slice(0, 200) || placed.stderr);
const t0 = Date.now();
const started = skillScript(clone, 'jevellan-runtime-codex', 'scripts/start.mjs', ['--task', task, '--step', '1', '--duty', 'investigate', '--cwd', wt.path, '--provider', 'codex', '--model', 'gpt-6-astra', '--effort', 'low', '--json']);
j.check('codex start returns at once', started.status === 0, started.stderr);
const waited = ledgerCli(clone, ['wait', '--task', task, '--step', '1', '--timeout', '600', '--json'], { timeoutMs: 660_000 });
j.time('start to report', Date.now() - t0);
j.check('the runner recorded a report from the file', waited.json?.kind === 'step.report' && waited.json?.status === 'done' && !waited.json?.synthesized, JSON.stringify(waited.json).slice(0, 400));
const events = readLedger(clone).filter((e) => e.task === task);
const thread = events.find((e) => e.kind === 'session.started' && e.data?.runtime === 'codex')?.data?.nativeSessionId;
j.check('the thread id is the native session id', Boolean(thread), thread);
const t1 = Date.now();
const resumed = skillScript(clone, 'jevellan-runtime-codex', 'scripts/resume.mjs', ['--task', task, '--step', '1', '--message', 'Continue.', '--json']);
const second = ledgerCli(clone, ['wait', '--task', task, '--step', '1', '--timeout', '600', '--json'], { timeoutMs: 660_000 });
j.time('resume to report', Date.now() - t1);
j.check('codex exec resume continued the thread and reported', resumed.json?.threadId === thread && second.json?.kind === 'step.report' && second.json.seq > waited.json.seq, `${resumed.stderr} ${JSON.stringify(second.json).slice(0, 200)}`);
j.check('the worktree is unchanged', sh('git', ['-C', wt.path, 'status', '--porcelain']).stdout.trim() === '');
j.finish();
