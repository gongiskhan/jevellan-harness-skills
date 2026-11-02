// H7 Three in parallel: one message to the coordinator asks for three tasks. Three worktrees, placements with
// probabilities for every step, three landings or asks, screenshots for the customers task under its evidence folder,
// wall time and per-task time, zero slips, and Jev's choices next to Jevellan's choices of 31 October for the same
// three (Opus medium; GPT medium; GPT high).

import fs from 'node:fs';
import path from 'node:path';
import { Journey, NODE, REPO, SANDBOX, git, readLedger, sh, sleep } from './lib.mjs';
import * as coord from './coord.mjs';

const REQUEST = 'Three tasks in parallel: (1) README how to run; (2) a unit test for one untested pure function in src; (3) an empty-state message on the customers page when there are no customers, with a test.';
const JEVELLAN = ['Opus medium', 'GPT medium', 'GPT high'];
const dir = process.env.JH_H7_DIR || SANDBOX;
const j = new Journey('H7', 'Three in parallel');
const install = sh(NODE, [path.join(REPO, 'install.mjs'), dir, '--json']);
j.check('the skills are installed', install.status === 0, install.stderr.trim());
const startSeq = readLedger(dir).length;
const mainBefore = git(dir, ['rev-parse', 'main']);
if (coord.exists()) await coord.stop();
const t0 = Date.now();
const { session, transcript } = await coord.start(dir);
j.note(`coordinator session ${session} in ${dir}`);
await coord.send(REQUEST);

const ended = new Map();
const deadline = Date.now() + 90 * 60 * 1000;
let lastLen = 0;
let lastProgress = Date.now();
while (Date.now() < deadline) {
  await sleep(15_000);
  const events = readLedger(dir).slice(startSeq);
  if (events.length !== lastLen) {
    lastLen = events.length;
    lastProgress = Date.now();
  }
  const tasks = [...new Set(events.filter((e) => e.kind === 'task.created').map((e) => e.task))];
  for (const task of tasks) {
    if (ended.has(task)) continue;
    const end = events.find((e) => e.task === task && (e.kind === 'task.landed' || e.kind === 'task.asked'));
    if (end) ended.set(task, { kind: end.kind, at: Date.parse(end.t) });
  }
  if (tasks.length >= 3 && tasks.every((t) => ended.has(t))) break;
  if (Date.now() - lastProgress > 15 * 60 * 1000 && coord.analyse(transcript, dir).idle) break;
}
const wall = Date.now() - t0;
j.time('wall time, request to the last landing', wall);
await coord.waitIdle(transcript, dir, { timeoutMs: 300_000, quietMs: 15_000 });
const report = coord.analyse(transcript, dir);
fs.writeFileSync(path.join(REPO, 'acceptance', 'results', 'H7-screen.txt'), coord.capture(400));
await coord.stop();

const events = readLedger(dir).slice(startSeq);
const created = events.filter((e) => e.kind === 'task.created');
j.check('three tasks created', created.length === 3, created.map((e) => `${e.task} ${e.data.kind}${e.data.duty ? ` ${e.data.duty}` : ''}: ${e.data.title}`).join(' | '));
const worktrees = created.map((c) => events.find((e) => e.task === c.task && e.kind === 'task.worktree')).filter(Boolean);
j.check('three worktrees', new Set(worktrees.map((w) => w.data.path)).size === 3);
const started = events.filter((e) => e.kind === 'step.started');
const firstStarts = new Map();
for (const s of started) if (!firstStarts.has(`${s.task}:${s.step}`)) firstStarts.set(`${s.task}:${s.step}`, s);
j.check('every started step was placed by Jev with probabilities first', [...firstStarts.values()].every((s) => events.some((p) => p.kind === 'task.placed' && p.task === s.task && p.data.step === s.step && p.seq < s.seq && p.data.source === 'jev' && Object.keys(p.data.probabilities?.model ?? {}).length > 0)), `${firstStarts.size} steps`);
const overlap = (() => {
  const spans = created.map((c) => {
    const mine = events.filter((e) => e.task === c.task && e.kind === 'step.started');
    return mine.length ? [Date.parse(mine[0].t), ended.get(c.task)?.at ?? Date.now()] : null;
  }).filter(Boolean);
  return spans.some((a, i) => spans.some((b, k) => k !== i && a[0] < b[1] && b[0] < a[1]));
})();
j.check('the tasks ran in parallel (their steps overlapped in time)', overlap);
j.check('three landings or asks', created.every((c) => ended.has(c.task)), created.map((c) => `${c.task}: ${ended.get(c.task)?.kind ?? 'open'}`).join(', '));
for (const c of created) {
  const end = ended.get(c.task);
  if (end) j.time(`task ${c.task} (${c.data.title.slice(0, 40)})`, end.at - Date.parse(c.t));
}
const customers = created.find((c) => /customer|empty/i.test(`${c.data.title} ${c.data.text}`));
const customersWt = customers && worktrees.find((w) => w.task === customers.task)?.data.path;
const reportsShots = customers ? events.filter((e) => e.task === customers.task && e.kind === 'step.report').flatMap((e) => e.data.screenshots ?? []) : [];
const evidence = customersWt && fs.existsSync(path.join(customersWt, '.jevellan', 'evidence')) ? fs.readdirSync(path.join(customersWt, '.jevellan', 'evidence')).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : [];
j.check('screenshots for the customers task under its evidence folder', evidence.length > 0 && reportsShots.length > 0, `${evidence.length} image files, ${reportsShots.length} in reports: ${reportsShots.map((s) => s.path).join(', ')}`);
j.check('zero slips', report.slips.length === 0, report.slips.join(' | '));
const lines = [];
created.forEach((c, i) => {
  const placements = events.filter((e) => e.kind === 'task.placed' && e.task === c.task).map((e) => `${e.data.duty} ${e.data.model} ${e.data.effort} via ${e.data.provider} (p ${(e.data.probabilities?.model?.[e.data.model] ?? 0).toFixed(2)})`);
  lines.push(`(${i + 1}) ${c.data.title}: Jev ${placements.join('; ')}; Jevellan on 31 October: ${JEVELLAN[i]}`);
});
for (const l of lines) j.note(l);
j.note(`Skill invocations: ${report.skills.join(', ')}`);
for (const c of created) {
  const d = events.find((e) => e.task === c.task && e.kind === 'landing.decided');
  if (d) j.note(`landing of ${c.task}: ${d.data.route} ${JSON.stringify(d.data.probabilities)}`);
}
j.check('main moved by the landings', git(dir, ['rev-parse', 'main']) !== mainBefore || created.every((c) => ended.get(c.task)?.kind === 'task.asked'));
j.check('the project checkout is clean', git(dir, ['status', '--porcelain']) === '', git(dir, ['status', '--porcelain']));
j.note(`coordinator's last reply: ${report.lastText.replace(/\s+/g, ' ').slice(0, 500)}`);
j.finish();
