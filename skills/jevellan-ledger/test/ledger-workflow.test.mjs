// append task.workflow built by the script: --from-workflow with placement's answers, --add-step for the extra
// verify step of verify-then-land, and --data-file. The workflow files are written here, the same shape as the
// feature and bug workflows' workflow.json (this skill's suites run with only this skill present).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LEDGER_CLI, NODE, childEnv, makeRepo, tempDir } from './helpers.mjs';
import { readEvents } from '../scripts/lib/ledger.mjs';

const FEATURE = {
  name: 'feature',
  steps: [
    { duty: 'plan', when: 'jev:needs_plan', instructions: 'Write plan.md at the worktree root: the change in one paragraph, the files to touch, the tests to add or change, open questions as needs-decision only if a choice is the owner\'s.' },
    { duty: 'implement', instructions: 'Follow plan.md when it exists. Commit on the task branch. Add or change the tests that cover what you changed, and run only those.' },
    { duty: 'verify', instructions: 'Run the project\'s test command, then the browser journeys for every screen the change touches, at desktop and phone widths, saving screenshots to .jevellan/evidence/. Report testsRun with passed true only when everything you ran passed.', onFail: { goto: 2, maxLoops: 2 } },
    { duty: 'document', when: 'jev:needs_docs', instructions: 'Update the docs the project keeps (README, docs/, changelog if the project uses one) for what changed. Nothing else.' },
  ],
};

const BUG = {
  name: 'bug',
  steps: [
    { duty: 'implement', instructions: 'Reproduce first with a failing test when the bug is testable, then fix. Commit on the task branch.' },
    { duty: 'verify', instructions: 'Run the project\'s test command and the browser journey for the affected screen if there is one. Save evidence to .jevellan/evidence/.', onFail: { goto: 1, maxLoops: 2 } },
  ],
};

function workflowFile(workflow) {
  const file = path.join(tempDir('jh-wf-'), 'workflow.json');
  fs.writeFileSync(file, `${JSON.stringify(workflow, null, 2)}\n`);
  return file;
}

const cli = (root, args) => spawnSync(NODE, [LEDGER_CLI, ...args, '--json'], { cwd: root, encoding: 'utf8', env: childEnv() });
const create = (root, kind, extra = []) => JSON.parse(cli(root, ['task', 'create', '--kind', kind, ...extra, '--title', `t ${kind} ${Math.random()}`, '--text', 'brief']).stdout).task;
const workflowLine = (root, task) => readEvents(root).events.filter((e) => e.task === task && e.kind === 'task.workflow').pop();

test('the feature workflow file and the answers give ordinals, gotos and skipped steps', () => {
  const root = makeRepo();
  const task = create(root, 'feature');
  const file = workflowFile(FEATURE);
  const answers = path.join(tempDir('jh-answers-'), 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ needs_plan: false, needs_docs: true, probabilities: { needs_plan: 0.1 }, policyHash: 'x' }));
  const r = cli(root, ['append', 'task.workflow', '--task', task, '--from-workflow', file, '--answers', answers]);
  assert.equal(r.status, 0, r.stderr);
  const d = workflowLine(root, task).data;
  assert.deepEqual(d.steps.map((s) => [s.ordinal, s.duty]), [[1, 'plan'], [2, 'implement'], [3, 'verify'], [4, 'document']]);
  assert.deepEqual(d.steps[2].onFail, { goto: 2, maxLoops: 2 });
  assert.deepEqual(d.skipped, [1]);
  assert.deepEqual(d.questions, { needs_plan: false, needs_docs: true });
  assert.match(d.steps[1].instructions, /Commit on the task branch/);
});

test('a goto that names a duty goes to the nearest earlier step with it; a missing answer is refused', () => {
  const root = makeRepo();
  const task = create(root, 'bug');
  const dir = tempDir('jh-wf-');
  const file = path.join(dir, 'bug.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'bug', steps: [{ duty: 'implement', instructions: "the owner's fix" }, { duty: 'verify', instructions: 'v', onFail: { goto: 'implement', maxLoops: 2 } }] }));
  let r = cli(root, ['append', 'task.workflow', '--task', task, '--from-workflow', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(workflowLine(root, task).data.steps[1].onFail, { goto: 1, maxLoops: 2 });
  const other = create(root, 'feature');
  r = cli(root, ['append', 'task.workflow', '--task', other, '--from-workflow', workflowFile(FEATURE)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /depends on needs_plan/);
});

test('--add-step adds the extra verify step to a feature workflow (with --force) and to a single task', () => {
  const root = makeRepo();
  const task = create(root, 'bug');
  cli(root, ['append', 'task.workflow', '--task', task, '--from-workflow', workflowFile(BUG)]);
  const extra = JSON.stringify({ duty: 'verify', instructions: 'Full verification before landing.' });
  let r = cli(root, ['append', 'task.workflow', '--task', task, '--add-step', extra]);
  assert.equal(r.status, 2, 'a second workflow needs --force');
  r = cli(root, ['append', 'task.workflow', '--task', task, '--force', '--add-step', extra]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(workflowLine(root, task).data.steps.map((s) => [s.ordinal, s.duty]), [[1, 'implement'], [2, 'verify'], [3, 'verify']]);
  const single = create(root, 'single', ['--duty', 'document']);
  r = cli(root, ['append', 'task.workflow', '--task', single, '--add-step', extra]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(workflowLine(root, single).data.steps.map((s) => [s.ordinal, s.duty]), [[1, 'document'], [2, 'verify']]);
});

test('--data-file reads JSON with apostrophes from a file or stdin', () => {
  const root = makeRepo();
  const file = path.join(tempDir('jh-note-'), 'note.json');
  fs.writeFileSync(file, JSON.stringify({ text: "the owner's rule" }));
  let r = cli(root, ['append', 'note', '--data-file', file]);
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(NODE, [LEDGER_CLI, 'append', 'note', '--data-file', '-', '--json'], { cwd: root, encoding: 'utf8', env: childEnv(), input: JSON.stringify({ text: "it's from stdin" }) });
  assert.equal(r.status, 0, r.stderr);
  const notes = readEvents(root).events.filter((e) => e.kind === 'note').map((e) => e.data.text);
  assert.deepEqual(notes, ["the owner's rule", "it's from stdin"]);
  r = cli(root, ['append', 'note', '--data', '{}', '--data-file', file]);
  assert.equal(r.status, 2);
});
