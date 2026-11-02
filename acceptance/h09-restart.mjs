// H9 Restart: the coordinator session is killed while a task waits for a report; a new session starts in the same
// folder; its first reply, prompted by the SessionStart context, names the open task and continues waiting; the task
// lands.

import fs from 'node:fs';
import path from 'node:path';
import { Journey, NODE, REPO, RESULTS_DIR, SANDBOX, readLedger, sh, sleep, until } from './lib.mjs';
import * as coord from './coord.mjs';

const REQUEST = 'Add a one-line comment at the top of src/customers/index.ts saying what the module stores, and a matching line in CHANGELOG.md.';
const dir = process.env.JH_H9_DIR || SANDBOX;
const j = new Journey('H9', 'Restart');
j.check('the skills are installed', sh(NODE, [path.join(REPO, 'install.mjs'), dir, '--json']).status === 0);
const startSeq = readLedger(dir).length;
if (coord.exists()) await coord.stop();
const t0 = Date.now();
const first = await coord.start(dir);
await coord.send(REQUEST);
const mine = () => readLedger(dir).slice(startSeq);
const started = await until(() => mine().find((e) => e.kind === 'step.started'), { timeoutMs: 20 * 60 * 1000, everyMs: 2000 });
j.check('a step started', Boolean(started), started ? `${started.task} step ${started.step} ${started.data.duty} on ${started.data.model}` : 'none');
const task = started?.task;
// Kill while the step runs and the coordinator waits in the background.
await until(() => coord.analyse(first.transcript, dir).tools.some((t) => t.name === 'Bash' && /ledger\.mjs wait/.test(t.input.command ?? '')), { timeoutMs: 180_000, everyMs: 2000 });
const runningAtKill = !mine().some((e) => e.task === task && e.kind === 'step.report' && e.seq > started.seq);
coord.kill();
j.check('the coordinator was killed while its task waited for a report', runningAtKill && !coord.exists());
await sleep(3000);
const second = await coord.start(dir);
const ss = mine().filter((e) => e.kind === 'session.started' && e.data?.role === 'coordinator').pop();
j.check('the new session started (session.started in the ledger)', ss?.session === second.session, ss?.session);
await coord.send('Continue.');
await until(() => coord.analyse(second.transcript, dir).lastText, { timeoutMs: 300_000, everyMs: 3000 });
await coord.waitIdle(second.transcript, dir, { timeoutMs: 300_000, quietMs: 10_000 });
const r2 = coord.analyse(second.transcript, dir);
const firstReply = r2.lastText;
const title = mine().find((e) => e.kind === 'task.created' && e.task === task)?.data?.title ?? '';
j.check('its first reply names the open task', firstReply.includes(task) || (title && firstReply.toLowerCase().includes(title.toLowerCase().slice(0, 20))), firstReply.replace(/\s+/g, ' ').slice(0, 300));
j.check('and continues waiting for it (a ledger wait for the task)', r2.tools.some((t) => t.name === 'Bash' && new RegExp(`ledger\\.mjs\\s+wait.*${task}`).test(t.input.command ?? '')) || mine().some((e) => e.task === task && (e.kind === 'task.landed' || e.kind === 'landing.decided')));
const landed = await until(() => mine().find((e) => e.task === task && (e.kind === 'task.landed' || e.kind === 'task.asked')), { timeoutMs: 40 * 60 * 1000, everyMs: 5000 });
j.check('the task lands', landed?.kind === 'task.landed', landed ? landed.kind : 'neither');
j.time('request to landing, across the restart', Date.now() - t0);
await coord.waitIdle(second.transcript, dir, { timeoutMs: 300_000, quietMs: 15_000 });
const slips = [...coord.analyse(first.transcript, dir).slips, ...coord.analyse(second.transcript, dir).slips];
j.check('zero slips in both sessions', slips.length === 0, slips.join(' | '));
fs.writeFileSync(path.join(RESULTS_DIR, 'H9-screen.txt'), coord.capture(300));
await coord.stop();
j.finish();
