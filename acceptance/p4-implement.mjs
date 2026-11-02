// Phase 4 check: a real implement step on a clone of the sandbox (README how to run), through placement, the runtime
// and the Stop hook, then landed with land.mjs. A clone, so the sandbox itself keeps its README for H6.

import fs from 'node:fs';
import path from 'node:path';
import { Journey, NODE, OUT_DIR, REPO, SANDBOX, SANDBOX_TEST_COMMAND, git, ledgerCli, readLedger, sh } from './lib.mjs';
import { driveTask } from './chain.mjs';

const j = new Journey('P4', 'Implement step landed (phase 4 check)');
const clone = path.join(fs.mkdtempSync(path.join(OUT_DIR, 'p4-')), 'jevellan-harness-sandbox');
sh('git', ['clone', '--quiet', '--local', SANDBOX, clone]);
sh('git', ['-C', clone, 'remote', 'remove', 'origin']);
const inst = sh(NODE, [path.join(REPO, 'install.mjs'), clone, '--json']);
j.check('installed on the clone', inst.status === 0, inst.stderr);
const pj = path.join(clone, '.jevellan', 'project.json');
const project = JSON.parse(fs.readFileSync(pj, 'utf8'));
project.testCommand = SANDBOX_TEST_COMMAND;
fs.writeFileSync(pj, `${JSON.stringify(project, null, 2)}\n`);
const before = git(clone, ['rev-parse', 'main']);

const created = ledgerCli(clone, ['task', 'create', '--kind', 'single', '--duty', 'implement', '--title', 'README: how to run', '--text', 'Add a "How to run" section to README.md that lists the commands in package.json (start, test, test:browser, lint, check:changelog, automate:customers) with one line each on what it does and the environment it needs (TZ=UTC and SANDBOX_DATA_DIR for the tests). Commit on the task branch. Done when README.md has the section and the unit tests still pass.', '--json']);
const task = created.json.task;
const t0 = Date.now();
const result = await driveTask(clone, task, { log: (l) => j.note(l) });
j.time('task to landing', Date.now() - t0);
j.check('the task landed', result.landed, result.why ?? '');
const events = readLedger(clone).filter((e) => e.task === task);
const kinds = events.map((e) => e.kind);
for (const k of ['task.created', 'task.worktree', 'task.placed', 'step.started', 'step.report', 'step.done', 'landing.decided', 'task.landed']) {
  j.check(`the ledger has ${k}`, kinds.includes(k));
}
const landed = events.find((e) => e.kind === 'task.landed');
const after = git(clone, ['rev-parse', 'main']);
j.check('main moved to the landed commit', after !== before && landed?.data?.commit === after, `${before.slice(0, 7)} -> ${after.slice(0, 7)}`);
const readme = fs.readFileSync(path.join(clone, 'README.md'), 'utf8');
j.check('README.md on main has a How to run section', /how to run/i.test(readme));
const log = git(clone, ['log', '--format=%B', `${before}..main`]);
j.check('the landed commits carry no attribution', !/co-authored-by|generated with|claude/i.test(log), log.slice(0, 300));
const checked = events.filter((e) => e.kind === 'landing.checked');
j.check('the landing ran the test command and it passed', checked.some((e) => e.data.command === SANDBOX_TEST_COMMAND && e.data.passed), JSON.stringify(checked.map((e) => [e.data.command, e.data.passed])));
j.check('the clone checkout is clean', git(clone, ['status', '--porcelain']) === '');
j.note(`placements: ${JSON.stringify(result.placements)}`);
j.note(`landing: ${JSON.stringify(events.find((e) => e.kind === 'landing.decided')?.data?.route)} ${JSON.stringify(events.find((e) => e.kind === 'landing.decided')?.data?.probabilities)}`);
j.finish();
