// H6 The chain: in the coordinator session (tmux jh-coord, `claude --permission-mode bypassPermissions` in the
// project folder under the owner's login) the owner says one sentence. The ledger must then show task.created,
// task.worktree, task.workflow (for a task with a workflow), task.placed for every step, step.started with model and
// effort, step.report, step.done, landing.decided and task.landed (or task.asked with a stated reason), with no human
// input beyond the request and zero slips. Passed three times in a row: each run is recorded in
// acceptance/results/H6-runs.json, and H6 passes when the last three runs passed.
//
//   node acceptance/h06-chain.mjs [--clone]     --clone runs on a fresh clone of the sandbox's baseline; without it,
//                                                on the sandbox itself (whose main then keeps the landing)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journey, NODE, REPO, RESULTS_DIR, SANDBOX, SANDBOX_TEST_COMMAND, git, readLedger, sh, sleep } from './lib.mjs';
import * as coord from './coord.mjs';

const REQUEST = 'Add a How to run section to the README listing the commands in package.json.';
const useClone = process.argv.includes('--clone');
const runsFile = path.join(RESULTS_DIR, 'H6-runs.json');
const runs = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, 'utf8')) : [];
const runNo = runs.length + 1;
const j = new Journey('H6', 'The chain');
j.note(`run ${runNo} on ${useClone ? 'a fresh clone of the sandbox baseline' : 'the sandbox'}`);

function prepare() {
  if (!useClone) return SANDBOX;
  const base = path.join(os.userInfo().homedir, 'jevellan-projects', 'jevellan-harness-runs', `h6-r${runNo}-${Date.now()}`);
  const dir = path.join(base, 'jevellan-harness-sandbox');
  fs.mkdirSync(base, { recursive: true });
  sh('git', ['clone', '--quiet', '--local', '--branch', 'main', SANDBOX, dir]);
  sh('git', ['-C', dir, 'remote', 'remove', 'origin']);
  const baseline = git(SANDBOX, ['rev-parse', 'main']);
  sh('git', ['-C', dir, 'reset', '--quiet', '--hard', baseline]);
  const inst = sh(NODE, [path.join(REPO, 'install.mjs'), dir, '--json']);
  if (inst.status !== 0) throw new Error(inst.stderr);
  const pj = path.join(dir, '.jevellan', 'project.json');
  const project = JSON.parse(fs.readFileSync(pj, 'utf8'));
  Object.assign(project, { testCommand: SANDBOX_TEST_COMMAND, setupCommand: 'npm ci' });
  fs.writeFileSync(pj, `${JSON.stringify(project, null, 2)}\n`);
  return dir;
}

const dir = prepare();
const install = sh(NODE, [path.join(REPO, 'install.mjs'), dir, '--json']);
j.check('the skills are installed in the project', install.status === 0, install.stderr.trim());
const mainBefore = git(dir, ['rev-parse', 'main']);
const startSeq = readLedger(dir).length;
if (coord.exists()) await coord.stop();
const t0 = Date.now();
const { session, transcript } = await coord.start(dir);
j.note(`coordinator session ${session}`);
await coord.send(REQUEST);

// Follow the ledger until the task lands or the owner is asked.
let task = null;
let outcome = null;
let lastProgress = Date.now();
let lastLen = readLedger(dir).length;
const deadline = Date.now() + 50 * 60 * 1000;
while (Date.now() < deadline) {
  await sleep(10_000);
  const events = readLedger(dir).slice(startSeq);
  if (events.length !== lastLen) {
    lastLen = events.length;
    lastProgress = Date.now();
  }
  task = task ?? events.find((e) => e.kind === 'task.created')?.task ?? null;
  if (task) {
    const mine = events.filter((e) => e.task === task);
    const end = mine.find((e) => e.kind === 'task.landed' || e.kind === 'task.asked');
    if (end) {
      outcome = end.kind;
      break;
    }
  }
  // Stuck: nothing new in the ledger for 12 minutes while the coordinator sits idle.
  if (Date.now() - lastProgress > 12 * 60 * 1000 && coord.analyse(transcript, dir).idle) break;
}
j.time('request to landing', Date.now() - t0);
await coord.waitIdle(transcript, dir, { timeoutMs: 300_000, quietMs: 15_000 });
const report = coord.analyse(transcript, dir);
fs.writeFileSync(path.join(RESULTS_DIR, `H6-r${runNo}-screen.txt`), coord.capture(400));
await coord.stop();

const events = readLedger(dir).slice(startSeq).filter((e) => e.task === task);
const kinds = new Set(events.map((e) => e.kind));
const created = events.find((e) => e.kind === 'task.created');
j.check('the coordinator created one task for the request', Boolean(task) && readLedger(dir).slice(startSeq).filter((e) => e.kind === 'task.created').length === 1, task ? `${task} (${created.data.kind}${created.data.duty ? ` ${created.data.duty}` : ''}): ${created.data.title}` : 'none');
j.check('task.worktree', kinds.has('task.worktree'));
if (created?.data?.kind !== 'single') j.check('task.workflow', kinds.has('task.workflow'));
else j.note('the coordinator chose a single task, which has no workflow line');
const startedSteps = [...new Set(events.filter((e) => e.kind === 'step.started').map((e) => e.step))];
j.check('every started step was placed first', startedSteps.length > 0 && startedSteps.every((s) => {
  const firstStart = events.find((e) => e.kind === 'step.started' && e.step === s);
  return events.some((e) => e.kind === 'task.placed' && e.data.step === s && e.seq < firstStart.seq);
}), `steps ${startedSteps.join(', ')}`);
j.check('step.started carries model and effort', events.filter((e) => e.kind === 'step.started').every((e) => e.data.model && e.data.effort));
j.check('every started step has a report and a step.done', startedSteps.every((s) => events.some((e) => e.kind === 'step.report' && e.step === s) && events.some((e) => e.kind === 'step.done' && e.step === s)));
j.check('landing.decided', kinds.has('landing.decided'));
const asked = events.find((e) => e.kind === 'task.asked');
j.check('task.landed, or task.asked with a stated reason', outcome === 'task.landed' || (outcome === 'task.asked' && Boolean(asked?.data?.reason)), outcome ?? 'neither');
j.check('no human input beyond the request', true, 'one message was sent');
j.check('zero slips', report.slips.length === 0, report.slips.join(' | '));
j.note(`Skill invocations: ${report.skills.join(', ')}`);
j.note(`placements: ${events.filter((e) => e.kind === 'task.placed').map((e) => `s${e.data.step} ${e.data.duty} ${e.data.model} ${e.data.effort} via ${e.data.provider}`).join('; ')}`);
const decided = events.find((e) => e.kind === 'landing.decided');
if (decided) j.note(`landing: ${decided.data.route} ${JSON.stringify(decided.data.probabilities)}`);
if (outcome === 'task.landed') {
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  j.check('main has the How to run section', git(dir, ['rev-parse', 'main']) !== mainBefore && /^#+\s*how to run/im.test(readme));
}
j.check('the project checkout is clean', git(dir, ['status', '--porcelain']) === '', git(dir, ['status', '--porcelain']));
j.note(`coordinator's last reply: ${report.lastText.replace(/\s+/g, ' ').slice(0, 400)}`);

const runPassed = j.checks.every((c) => c.ok);
const otherChecksPassed = j.checks.filter((c) => c.name !== 'zero slips').every((c) => c.ok);
runs.push({ run: runNo, passed: runPassed, otherChecksPassed, at: new Date().toISOString(), dir, task, session, slips: report.slips, skills: report.skills, elapsedMs: Date.now() - t0 });
fs.writeFileSync(runsFile, `${JSON.stringify(runs, null, 2)}\n`);
const lastThree = runs.slice(-3);
j.note(`runs so far: ${runs.map((r) => `${r.run}:${r.passed ? 'pass' : 'fail'}`).join(' ')}`);
j.check('passed three times in a row', lastThree.length === 3 && lastThree.every((r) => r.passed), lastThree.map((r) => r.passed).join(','));
j.finish();
