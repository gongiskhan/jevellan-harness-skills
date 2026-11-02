// This workflow skill's own test, run with only its folder present (scripts/test-skills.mjs): workflow.json is what a
// session hands to the ledger skill as task.workflow, so it must parse and keep the shape the ledger resolves. Every
// workflow skill keeps its own copy of this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The eight duties a step may name (the duty skills' jh-duty values).
const DUTIES = ['answer', 'converse', 'investigate', 'plan', 'implement', 'document', 'verify', 'automate'];
const STEP_KEYS = ['duty', 'when', 'instructions', 'onFail'];

const read = (name) => fs.readFileSync(path.join(SKILL, name), 'utf8');
const kindOf = (text) => /^jh-kind:\s*(\S+)\s*$/m.exec(text)?.[1] ?? null;

test('workflow.json parses, is named after the jh-kind and has steps', () => {
  const workflow = JSON.parse(read('workflow.json'));
  assert.equal(typeof workflow, 'object');
  assert.deepEqual(Object.keys(workflow).sort(), ['name', 'steps']);
  assert.equal(workflow.name, kindOf(read('SKILL.md')), 'name is the task kind in the frontmatter');
  assert.ok(Array.isArray(workflow.steps) && workflow.steps.length > 0, 'at least one step');
});

test('every step names one of the eight duties and has instructions', () => {
  const { steps } = JSON.parse(read('workflow.json'));
  steps.forEach((step, index) => {
    const where = `step ${index + 1}`;
    for (const key of Object.keys(step)) assert.ok(STEP_KEYS.includes(key), `${where}: unknown key ${key}`);
    assert.ok(DUTIES.includes(step.duty), `${where}: duty "${step.duty}" is not one of ${DUTIES.join(', ')}`);
    assert.equal(typeof step.instructions, 'string', `${where}: instructions`);
    assert.ok(step.instructions.trim().length > 0, `${where}: instructions are empty`);
    assert.ok(!step.instructions.includes(String.fromCharCode(0x2014)), `${where}: an em dash in the instructions`);
  });
});

test('when is absent, null or jev:<question id>', () => {
  const { steps } = JSON.parse(read('workflow.json'));
  steps.forEach((step, index) => {
    if (step.when === undefined || step.when === null) return;
    assert.match(step.when, /^jev:[A-Za-z0-9_.:-]+$/, `step ${index + 1}: when "${step.when}"`);
  });
});

test('onFail goes back to an earlier step, at most maxLoops times', () => {
  const { steps } = JSON.parse(read('workflow.json'));
  steps.forEach((step, index) => {
    const ordinal = index + 1;
    if (step.onFail === undefined || step.onFail === null) return;
    assert.deepEqual(Object.keys(step.onFail).sort(), ['goto', 'maxLoops'], `step ${ordinal}: onFail keys`);
    const { goto, maxLoops } = step.onFail;
    if (typeof goto === 'number') {
      assert.ok(Number.isInteger(goto) && goto >= 1 && goto < ordinal, `step ${ordinal}: onFail.goto ${goto} is not an earlier step`);
    } else {
      // A duty name goes back to the nearest earlier step with that duty.
      assert.ok(steps.slice(0, index).some((s) => s.duty === goto), `step ${ordinal}: onFail.goto "${goto}" names no earlier step`);
    }
    assert.ok(Number.isInteger(maxLoops) && maxLoops >= 1, `step ${ordinal}: maxLoops ${maxLoops}`);
  });
});

test('the skill has no scripts, and its Interface section, the last one, says so and names workflow.json', () => {
  assert.equal(fs.existsSync(path.join(SKILL, 'scripts')), false);
  const body = read('SKILL.md');
  const at = body.indexOf('\n## Interface\n');
  assert.ok(at >= 0, 'an "## Interface" section');
  const section = body.slice(at + 1);
  assert.doesNotMatch(section.slice('## Interface'.length), /^#{1,6} /m, 'no section after it');
  assert.match(section, /No scripts\./);
  assert.match(section, /`workflow\.json`/);
});
