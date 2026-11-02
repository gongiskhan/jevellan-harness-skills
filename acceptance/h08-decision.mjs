// H8 Needs-decision: a task whose text tells the duty to ask "Blue or Green?" with two options; the coordinator
// surfaces the question with numbered options; "1" is typed into tmux; the coordinator resumes the step with the
// answer through the runtime; the step reports done.

import fs from 'node:fs';
import path from 'node:path';
import { Journey, NODE, REPO, RESULTS_DIR, SANDBOX, readLedger, sh, sleep, until } from './lib.mjs';
import * as coord from './coord.mjs';

const REQUEST = 'New task, a test of the needs-decision path: add one line to the README naming the colour of this sandbox. The colour is my choice and the worker must ask it: the step reports needs-decision with the question exactly "Blue or Green?" and the two options Blue and Green, and after the answer it adds the line with that colour and commits. Create the task with that brief and run it; do not ask me the colour before the worker asks.';
const dir = process.env.JH_H8_DIR || SANDBOX;
const j = new Journey('H8', 'Needs-decision');
j.check('the skills are installed', sh(NODE, [path.join(REPO, 'install.mjs'), dir, '--json']).status === 0);
const startSeq = readLedger(dir).length;
if (coord.exists()) await coord.stop();
const t0 = Date.now();
const { session, transcript } = await coord.start(dir);
await coord.send(REQUEST);

const mine = () => readLedger(dir).slice(startSeq);
const asked = await until(() => mine().find((e) => e.kind === 'step.report' && e.data.status === 'needs-decision'), { timeoutMs: 30 * 60 * 1000, everyMs: 5000 });
j.check('the step reported needs-decision', Boolean(asked), asked ? `${asked.task}: ${asked.data.question} [${(asked.data.options ?? []).map((o) => o.label).join(', ')}]` : 'no report');
j.check('the question is "Blue or Green?" with two options', asked?.data?.question?.includes('Blue or Green?') && asked.data.options?.length === 2);
const task = asked?.task;
await coord.waitIdle(transcript, dir, { timeoutMs: 300_000, quietMs: 10_000 });
const screen = coord.capture(120);
fs.writeFileSync(path.join(RESULTS_DIR, 'H8-screen-question.txt'), screen);
const reply = coord.analyse(transcript, dir).lastText;
j.check('the coordinator surfaced the question with numbered options', /Blue or Green\?/.test(reply) && /1[.)]\s*\S*\s*Blue|1[.)].*Blue/.test(reply) && /2[.)].*Green/.test(reply), reply.replace(/\s+/g, ' ').slice(0, 300));
const beforeAnswer = mine().length;
await coord.send('1');
const resumed = await until(() => mine().slice(beforeAnswer - 0).find((e) => e.kind === 'step.started' && e.task === task && e.data.resumed), { timeoutMs: 600_000, everyMs: 3000 });
const message = mine().find((e) => e.kind === 'step.message' && e.task === task);
j.check('the coordinator resumed the step through the runtime with the answer', Boolean(resumed) && /blue/i.test(message?.data?.text ?? ''), `${message?.data?.direction}: ${message?.data?.text}`);
const done = await until(() => mine().find((e) => e.kind === 'step.report' && e.task === task && e.seq > (resumed?.seq ?? Infinity)), { timeoutMs: 30 * 60 * 1000, everyMs: 5000 });
j.check('the step then reports done', done?.data?.status === 'done', done ? `${done.data.status}: ${done.data.summary.slice(0, 200)}` : 'no report');
const landed = await until(() => mine().find((e) => e.task === task && (e.kind === 'task.landed' || e.kind === 'task.asked')), { timeoutMs: 20 * 60 * 1000, everyMs: 5000 });
j.note(`after the decision: ${landed ? landed.kind : 'no landing yet'}`);
j.time('request to done report', (done ? Date.parse(done.t) : Date.now()) - t0);
await coord.waitIdle(transcript, dir, { timeoutMs: 300_000, quietMs: 15_000 });
const report = coord.analyse(transcript, dir);
j.check('zero slips', report.slips.length === 0, report.slips.join(' | '));
j.note(`Skill invocations: ${report.skills.join(', ')}`);
await coord.stop();
if (landed?.kind === 'task.landed') j.check('the README on main names Blue', /blue/i.test(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')));
j.finish();
