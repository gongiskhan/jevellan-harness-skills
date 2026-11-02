// The placement policy (lib/policy.mjs and the SKILL.md it reads): level-2 sections read by name, the policy hash,
// and the "## Interface" section, which documents the scripts for other skills and is neither a policy section nor
// part of the hash. Runs with only this skill present.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './helpers/fixture.mjs';
import { INTERFACE_SECTION, PolicyError, loadPolicy, parseIdLines, parsePolicy, parseQuestionLines, parseSections, policyText, requireSection, sha256, splitFrontmatter } from '../scripts/lib/policy.mjs';
import { ROUTER_SECTIONS, loadRouterPolicy, routerPolicy } from '../scripts/route.mjs';

const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
const FRONT = '---\nname: x\ndescription: Placement. Fixture.\njh-role: placement\n---\n';

describe('sections', () => {
  test('a level-2 heading opens a section up to the next one; fenced headings and level-1 headings do not', () => {
    const body = [
      'Intro for people.',
      '## Model',
      'Pick a model.',
      '```',
      '## not a heading',
      '```',
      '# Appendix',
      'not in any section',
      '##   Effort   Guide  ',
      'low: little',
      '',
    ].join('\n');
    const { sections, duplicates } = parseSections(body);
    assert.deepEqual([...sections.keys()], ['model', 'effort guide']);
    assert.equal(sections.get('model'), 'Pick a model.\n```\n## not a heading\n```');
    assert.equal(sections.get('effort guide'), 'low: little');
    assert.deepEqual(duplicates, []);
    assert.throws(() => parsePolicy(`${FRONT}## rules\na\n## Rules\nb\n`, 'p.md'), (e) => e instanceof PolicyError && e.exitCode === 2 && e.message === 'p.md: section "rules" appears twice');
    assert.throws(() => requireSection(parsePolicy(`${FRONT}## rules\n\n`, 'p.md'), 'rules'), { message: 'p.md: the section "## rules" is missing or empty' });
  });

  test('id lines and question lines', () => {
    assert.deepEqual([...parseIdLines('a-1: first\n\nb.2:  second ')], [['a-1', 'first'], ['b.2', 'second']]);
    assert.throws(() => parseIdLines('no colon here', 'where'), { message: 'where: "no colon here" is not an "<id>: <text>" line' });
    assert.throws(() => parseIdLines('a: x\na: y', 'where'), { message: 'where: a appears twice' });
    const q = parseQuestionLines('needs_plan: Plan first? true: Big work. false: Small work.');
    assert.deepEqual(q.get('needs_plan'), { id: 'needs_plan', question: 'Plan first?', true: 'Big work.', false: 'Small work.' });
    assert.throws(() => parseQuestionLines('q: no criteria'), { message: 'questions: q needs "<question> true: <criterion> false: <criterion>"' });
  });
});

describe('the Interface section', () => {
  const policyBody = '\n# Placement\n\nFor people.\n\n## rules\nPrefer Opus.\n';
  const withInterface = `${policyBody}\n## Interface\n\n- \`route.mjs\` -> {provider}\n`;

  test('is neither a section of the policy nor part of its hash', () => {
    const before = parsePolicy(`${FRONT}${policyBody}`, 'p.md');
    const after = parsePolicy(`${FRONT}${withInterface}`, 'p.md');
    assert.equal(before.hash, sha256(policyBody), 'without an Interface section the hash is the body hash');
    assert.equal(after.hash, before.hash, 'an Interface section placed last leaves the hash as it was');
    assert.deepEqual([...after.sections.keys()], ['rules']);
    assert.equal(after.sections.get('rules'), 'Prefer Opus.');
    assert.equal(after.sections.has(INTERFACE_SECTION), false);
    assert.equal(after.body, withInterface, 'the body itself is kept whole');
    // Changing only the Interface text keeps the hash; changing the policy changes it.
    assert.equal(parsePolicy(`${FRONT}${withInterface.replace('{provider}', '{provider, model}')}`, 'p.md').hash, before.hash);
    assert.notEqual(parsePolicy(`${FRONT}${withInterface.replace('Prefer Opus.', 'Prefer Sonnet.')}`, 'p.md').hash, before.hash);
  });

  test('placed between policy sections, only its own lines leave the hashed text', () => {
    const middle = '## model\nPick.\n## Interface\n- `jev.mjs`\n## rules\nPrefer Opus.\n';
    assert.equal(policyText(middle), '## model\nPick.\n## rules\nPrefer Opus.\n');
    const p = parsePolicy(`${FRONT}${middle}`, 'p.md');
    assert.deepEqual([...p.sections.keys()], ['model', 'rules']);
    assert.equal(p.hash, sha256('## model\nPick.\n## rules\nPrefer Opus.\n'));
  });
});

describe('the shipped policy', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const { body } = splitFrontmatter(text);

  test('has the six sections placement reads, and the rules sent to Jev hold no Interface text', () => {
    const policy = loadRouterPolicy();
    assert.equal(policy.file, SKILL_MD);
    for (const name of ROUTER_SECTIONS) assert.ok(loadPolicy(SKILL_MD).sections.get(name), name);
    assert.ok(policy.modelDescriptions.size >= 2);
    assert.deepEqual([...policy.effortGuide.keys()], ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual([...policy.questions.keys()], ['needs_plan', 'needs_docs']);
    assert.ok(!/Interface|route\.mjs|jev\.mjs/.test(policy.rules));
    assert.equal(policy.hash, sha256(policyText(body)));
    assert.equal(routerPolicy(loadPolicy(SKILL_MD)).hash, policy.hash);
  });

  test('ends with "## Interface", which names every script at the top of scripts/ and only those', () => {
    const headings = body.split('\n').filter((l) => /^## /.test(l));
    assert.equal(headings.at(-1), '## Interface', 'the Interface section is the last one');
    const section = body.slice(body.lastIndexOf('\n## Interface\n'));
    const bullets = section.split('\n').filter((l) => l.startsWith('- '));
    const named = new Set(bullets.map((l) => /^- `([A-Za-z0-9._-]+\.mjs)\b/.exec(l)?.[1]).filter(Boolean));
    const scripts = fs.readdirSync(path.join(SKILL_DIR, 'scripts')).filter((f) => f.endsWith('.mjs')).sort();
    assert.deepEqual([...named].sort(), scripts);
    assert.ok(bullets.some((l) => l.startsWith('- `jev.mjs decide')), 'decide is listed');
    assert.ok(!section.includes('```'), 'no fence that could hide a heading');
  });
});
