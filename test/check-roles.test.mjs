// scripts/check-roles.mjs: the role lint, the event kind lint and the generated docs/roles.md, against fixture
// repositories built in temporary folders, then against this repository read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kindsUsed, lintSharedLibs, parseSkillFile, tokenize } from '../scripts/check-roles.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'check-roles.mjs');
const ledgerLib = path.join(repo, 'skills', 'jevellan-ledger', 'scripts', 'lib');
// Temporary folders go under JH_TEST_TMPDIR when set, else under the system temporary folder. They are left behind
// on purpose.
const scratch = process.env.JH_TEST_TMPDIR || os.tmpdir();
fs.mkdirSync(scratch, { recursive: true });
const base = fs.mkdtempSync(path.join(scratch, 'check-roles-'));
const harnessHome = fs.mkdtempSync(path.join(base, 'harness-'));

const SENTENCE = "If no skill in your list has that role (a skill's role is the first word of its description), call no skill at all: stop, tell the owner which role is missing, and do not improvise it.";

const skill = (front, body) => `---\n${front.trim()}\n---\n\n${body.trim()}\n`;

const coordinatorBody = `
# Coordinator

Use the ledger skill to create the task. Use the git skill to make the worktree. Use the workflow skill for <kind>
and follow its steps in order. For every step, use the placement skill now and continue with its answer, then use
the runtime skill for provider kind <kind> to start the step. A worker uses the duty skill for <duty> now.
${SENTENCE}
`;

// The clean roster: one skill per role, names chosen for the fixture only.
function baseFiles() {
  return {
    'skills/jevellan-coordinator/SKILL.md': skill(
      `name: jevellan-coordinator
description: "Coordinator. Use when the owner asks this session to run work: it turns requests into tasks."
jh-role: coordinator`,
      coordinatorBody,
    ),
    'skills/jevellan-router/SKILL.md': skill(
      `name: jevellan-router
description: 'Placement. Use when a step needs a model, effort and provider.'
jh-role: placement`,
      '# Placement\n\nRun the script next to this file. Never choose yourself.',
    ),
    'skills/jevellan-ledger/SKILL.md': skill(
      `name: jevellan-ledger
description: Ledger. Use when a session must create a task or read what happened to one.
jh-role: ledger`,
      '# Ledger\n\nThe ledger is .jevellan/ledger.jsonl.',
    ),
    'skills/jevellan-git/SKILL.md': skill(
      `name: jevellan-git
description: >
  Git. Use when a task needs its worktree
  created or removed, or when it must be landed.
jh-role: git`,
      '# Git\n\nThis skill (jevellan-git) owns the worktree scripts.',
    ),
    'skills/jevellan-git/scripts/land.mjs': [
      "import { appendEvent } from './ledger-link.mjs';",
      "export const land = (root) => appendEvent(root, { kind: 'task.landed', data: { commit: 'abc', kind: 'feature' } });",
      "export const file = 'task.json';",
      '',
    ].join('\n'),
    'skills/jevellan-runtime-alpha/SKILL.md': skill(
      `name: jevellan-runtime-alpha
description: Runtime for alpha providers (kinds alpha-subscription and alpha-endpoint). Use to start or resume a step.
jh-role: runtime
jh-kinds: [alpha-subscription, "alpha-endpoint"]`,
      '# Runtime\n\nStart a step with the script next to this file.',
    ),
    'skills/jevellan-duty-implement/SKILL.md': skill(
      `name: jevellan-duty-implement
description: Duty implement. Use when this session is running a task step whose duty is implement.
jh-role: duty
jh-duty: implement
jh-needs: [repo-write, shell]`,
      '# Implement\n\nMake the change. End by writing the report file.',
    ),
    'skills/jevellan-duty-answer/SKILL.md': skill(
      `name: jevellan-duty-answer
description: Duty answer. Use when this session is running a task step whose duty is answer.
jh-role: duty
jh-duty: answer
jh-needs: []`,
      '# Answer\n\nAnswer the question.',
    ),
    'skills/jevellan-workflow-bug/SKILL.md': skill(
      `name: jevellan-workflow-bug
description: Workflow bug. Use when the coordinator is about to run a task of kind bug.
jh-role: workflow
jh-kind: bug`,
      '# Bug\n\nSteps are in workflow.json next to this file.',
    ),
    'skills/jevellan-workflow-bug/workflow.json': `${JSON.stringify({ kind: 'bug', steps: [{ ordinal: 1, duty: 'implement' }] }, null, 2)}\n`,
  };
}

let counter = 0;
// A fixture repository: the base roster with `change(files)` applied (it may edit or delete entries), the real
// ledger library copied in so KINDS imports, and a git repository around it.
function fixture(change = () => {}, { write = true } = {}) {
  counter += 1;
  const root = fs.mkdtempSync(path.join(base, `repo-${counter}-`));
  fs.cpSync(ledgerLib, path.join(root, 'skills', 'jevellan-ledger', 'scripts', 'lib'), { recursive: true });
  const files = baseFiles();
  change(files);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  execFileSync('git', ['init', '-q', root]);
  if (write) {
    const result = run(root, '--write');
    assert.equal(result.status, 0, `the clean fixture should write cleanly:\n${result.stderr}`);
  }
  return root;
}

function run(root, ...flags) {
  const args = [script, ...(root ? ['--root', root] : []), ...flags];
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, JH_HARNESS_HOME: harnessHome },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Runs the lint and expects exit 1 with `expected` (a string or a RegExp) among the problem lines.
function expectProblem(root, expected, ...flags) {
  const result = run(root, ...flags);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const lines = result.stderr.split('\n').filter(Boolean);
  const hit = lines.some((line) => (expected instanceof RegExp ? expected.test(line) : line.includes(expected)));
  assert.ok(hit, `no problem line matches ${expected}:\n${result.stderr}`);
  return lines;
}

const edit = (files, rel, from, to) => {
  assert.ok(files[rel].includes(from), `${rel} does not contain ${from}`);
  files[rel] = files[rel].replace(from, to);
};

test('a clean fixture passes the lint, --write and --check', () => {
  const root = fixture();
  const lint = run(root);
  assert.equal(lint.status, 0, lint.stderr);
  assert.match(lint.stdout, /8 skills, 20 event kinds, clean/);
  const check = run(root, '--check');
  assert.equal(check.status, 0, check.stderr);
  const doc = fs.readFileSync(path.join(root, 'docs', 'roles.md'), 'utf8');
  assert.match(doc, /Generated by `node scripts\/check-roles\.mjs --write`/);
  assert.match(doc, /\| jevellan-runtime-alpha \| runtime \| provider kinds: alpha-subscription, alpha-endpoint \| Runtime for alpha/);
  assert.match(doc, /\| jevellan-duty-implement \| duty \| duty: implement; needs: repo-write, shell \| Duty implement\./);
  assert.match(doc, /\| jevellan-duty-answer \| duty \| duty: answer; needs: none \|/);
  assert.match(doc, /\| jevellan-workflow-bug \| workflow \| task kind: bug \|/);
  assert.match(doc, /\| jevellan-git \| git \| - \| Git\. Use when a task needs its worktree created or removed, or when it must be landed\. \|/);
  assert.match(doc, /\| jevellan-coordinator \| coordinator \| - \| Coordinator\. Use when the owner asks this session to run work: it turns requests into tasks\. \|/);
  assert.match(doc, /- `jevellan-coordinator`: "the placement skill", "the ledger skill", "the git skill", "the runtime skill for", "the duty skill for", "the workflow skill for"/);
  assert.match(doc, /- `jevellan-ledger`: none/);
  // Rows in folder order.
  const rows = doc.split('\n').filter((l) => l.startsWith('| jevellan-')).map((l) => l.split('|')[1].trim());
  assert.deepEqual(rows, [...rows].sort());
  // --write is stable: writing again changes nothing.
  assert.equal(run(root, '--write').status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'roles.md'), 'utf8'), doc);
});

test('a missing jh-role fails', () => {
  const root = fixture((f) => edit(f, 'skills/jevellan-router/SKILL.md', 'jh-role: placement', ''), { write: false });
  expectProblem(root, 'skills/jevellan-router/SKILL.md: jh-role is missing');
});

test('an unknown jh-role fails', () => {
  const root = fixture((f) => edit(f, 'skills/jevellan-router/SKILL.md', 'jh-role: placement', 'jh-role: router'), { write: false });
  expectProblem(root, 'skills/jevellan-router/SKILL.md: jh-role "router" is not one of coordinator, placement');
});

test('a description that does not start with the role word fails', () => {
  const root = fixture((f) => edit(f, 'skills/jevellan-ledger/SKILL.md', 'description: Ledger. Use', 'description: Use'), { write: false });
  expectProblem(root, 'skills/jevellan-ledger/SKILL.md: the description must start with "Ledger."');
});

test('a duty or workflow description must name its duty or kind', () => {
  const duty = fixture((f) => edit(f, 'skills/jevellan-duty-implement/SKILL.md', 'Duty implement.', 'Duty verify.'), { write: false });
  expectProblem(duty, 'the description must start with "Duty implement."');
  const workflow = fixture((f) => edit(f, 'skills/jevellan-workflow-bug/SKILL.md', 'Workflow bug.', 'Workflow for bugs.'), { write: false });
  expectProblem(workflow, 'the description must start with "Workflow bug."');
  const runtime = fixture((f) => edit(f, 'skills/jevellan-runtime-alpha/SKILL.md', 'Runtime for alpha', 'Runs alpha'), { write: false });
  expectProblem(runtime, 'the description must start with "Runtime for"');
});

test('a name that does not match its folder fails', () => {
  const root = fixture((f) => edit(f, 'skills/jevellan-git/SKILL.md', 'name: jevellan-git', 'name: jevellan-gitx'), { write: false });
  expectProblem(root, 'skills/jevellan-git/SKILL.md: name "jevellan-gitx" does not match the folder name "jevellan-git"');
});

test('a body that names another skill fails, and its own name is allowed', () => {
  const root = fixture((f) => edit(f, 'skills/jevellan-coordinator/SKILL.md', 'Use the ledger skill', 'Use jevellan-router/scripts/route.mjs, then the ledger skill'), { write: false });
  const lines = expectProblem(root, 'skills/jevellan-coordinator/SKILL.md: the body names another skill, "jevellan-router"');
  assert.ok(lines.some((l) => l.includes('"the placement skill"')), 'the problem suggests the role phrase');
  assert.ok(!lines.some((l) => l.startsWith('skills/jevellan-git/SKILL.md')), 'the git body names only itself');
  // A longer name that merely starts with another skill's name does not count.
  const longer = fixture((f) => edit(f, 'skills/jevellan-ledger/SKILL.md', 'The ledger is', 'Unlike jevellan-gitops, the ledger is'), { write: false });
  assert.equal(run(longer).status, 0);
});

test('a role phrase whose role no skill has fails', () => {
  const root = fixture((f) => {
    delete f['skills/jevellan-workflow-bug/SKILL.md'];
    delete f['skills/jevellan-workflow-bug/workflow.json'];
  }, { write: false });
  expectProblem(root, 'skills/jevellan-coordinator/SKILL.md: the body uses "the workflow skill for" but no skill has jh-role workflow');
});

test('a body with role phrases and no role-missing sentence fails', () => {
  const root = fixture((f) => edit(f, 'skills/jevellan-coordinator/SKILL.md', 'call no skill at all', 'stop at once'), { write: false });
  expectProblem(root, `skills/jevellan-coordinator/SKILL.md: the body uses role phrases but lacks the sentence "${SENTENCE}"`);
  // A body without role phrases does not need it, and role phrases match whatever their case.
  const phrased = fixture((f) => edit(f, 'skills/jevellan-router/SKILL.md', 'Run the script', 'Ask The Ledger Skill first. Run the script'), { write: false });
  expectProblem(phrased, 'skills/jevellan-router/SKILL.md: the body uses role phrases but lacks the sentence');
});

test('a runtime without jh-kinds fails, and so does an empty list', () => {
  const missing = fixture((f) => edit(f, 'skills/jevellan-runtime-alpha/SKILL.md', 'jh-kinds: [alpha-subscription, "alpha-endpoint"]', ''), { write: false });
  expectProblem(missing, 'skills/jevellan-runtime-alpha/SKILL.md: a runtime needs jh-kinds, a non-empty list of provider kinds');
  const empty = fixture((f) => edit(f, 'skills/jevellan-runtime-alpha/SKILL.md', 'jh-kinds: [alpha-subscription, "alpha-endpoint"]', 'jh-kinds: []'), { write: false });
  expectProblem(empty, 'a runtime needs jh-kinds');
  const scalar = fixture((f) => edit(f, 'skills/jevellan-runtime-alpha/SKILL.md', 'jh-kinds: [alpha-subscription, "alpha-endpoint"]', 'jh-kinds: alpha-subscription'), { write: false });
  expectProblem(scalar, 'a runtime needs jh-kinds');
});

test('a duty without jh-duty or jh-needs fails', () => {
  const needs = fixture((f) => edit(f, 'skills/jevellan-duty-answer/SKILL.md', 'jh-needs: []', ''), { write: false });
  expectProblem(needs, 'skills/jevellan-duty-answer/SKILL.md: a duty needs jh-needs, a list (use [] for none)');
  const duty = fixture((f) => edit(f, 'skills/jevellan-duty-answer/SKILL.md', 'jh-duty: answer', ''), { write: false });
  expectProblem(duty, 'skills/jevellan-duty-answer/SKILL.md: a duty needs jh-duty');
  const twice = fixture((f) => edit(f, 'skills/jevellan-duty-answer/SKILL.md', 'jh-duty: answer', 'jh-duty: implement'), { write: false });
  expectProblem(twice, 'skills/jevellan-duty-implement/SKILL.md: duty "implement" is also claimed by jevellan-duty-answer');
});

test('a workflow without a workflow.json that parses fails', () => {
  const missing = fixture((f) => delete f['skills/jevellan-workflow-bug/workflow.json'], { write: false });
  expectProblem(missing, 'skills/jevellan-workflow-bug/workflow.json: missing; a workflow needs a workflow.json next to its SKILL.md');
  const broken = fixture((f) => { f['skills/jevellan-workflow-bug/workflow.json'] = '{"steps": [\n'; }, { write: false });
  expectProblem(broken, /^skills\/jevellan-workflow-bug\/workflow\.json: does not parse/);
});

test('a script that uses a twenty-first event kind fails with its file and line', () => {
  const dotted = fixture((f) => {
    f['skills/jevellan-git/scripts/land.mjs'] += "\n// 'step.ignored' in a comment does not count\nexport const k = 'step.paused';\n";
  }, { write: false });
  const lines = expectProblem(dotted, 'skills/jevellan-git/scripts/land.mjs:6: event kind "step.paused" is not one of the 20 in KINDS');
  assert.ok(!lines.some((l) => l.includes('step.ignored')));
  assert.ok(!lines.some((l) => l.includes('task.json')), 'a file name is not a kind');
  assert.ok(!lines.some((l) => l.includes('"feature"')), 'a kind inside data is not an event kind');
  const plain = fixture((f) => {
    f['skills/jevellan-git/hooks/notify.mjs'] = "import { appendEvent } from 'x';\nappendEvent(root, {\n  kind: 'warning',\n  data: {},\n});\n";
  }, { write: false });
  expectProblem(plain, 'skills/jevellan-git/hooks/notify.mjs:3: event kind "warning" is not one of the 20 in KINDS');
  const cli = fixture((f) => {
    f['skills/jevellan-git/scripts/cli.mjs'] = "run(['append', 'notes', '--data', '{}']);\nrun(['append', 'note', '--data', '{}']);\n";
  }, { write: false });
  const cliLines = expectProblem(cli, 'skills/jevellan-git/scripts/cli.mjs:1: event kind "notes"');
  assert.ok(!cliLines.some((l) => l.includes('"note"')));
});

test('KINDS must have exactly twenty entries', () => {
  const root = fixture(() => {}, { write: false });
  const lib = path.join(root, 'skills', 'jevellan-ledger', 'scripts', 'lib', 'ledger.mjs');
  const text = fs.readFileSync(lib, 'utf8');
  assert.ok(text.includes("  'note',\n]);"));
  fs.writeFileSync(lib, text.replace("  'note',\n]);", "  'note',\n  'step.paused',\n]);"));
  expectProblem(root, 'skills/jevellan-ledger/scripts/lib/ledger.mjs: KINDS has 21 entries; there are exactly 20 event kinds');
});

test('a missing ledger library is reported', () => {
  const root = fixture(() => {}, { write: false });
  fs.renameSync(path.join(root, 'skills', 'jevellan-ledger', 'scripts', 'lib', 'ledger.mjs'), path.join(root, 'ledger.mjs.moved'));
  expectProblem(root, /^skills\/jevellan-ledger\/scripts\/lib\/ledger\.mjs: cannot import KINDS/);
});

test('a stale or missing docs/roles.md fails --check and not the plain lint', () => {
  const root = fixture();
  const file = path.join(root, 'skills', 'jevellan-ledger', 'SKILL.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('read what happened to one', 'read what happened'));
  expectProblem(root, 'docs/roles.md: stale, it differs from the skills\' frontmatter; run node scripts/check-roles.mjs --write', '--check');
  assert.equal(run(root).status, 0);
  assert.equal(run(root, '--write').status, 0);
  assert.equal(run(root, '--check').status, 0);
  const missing = fixture(() => {}, { write: false });
  expectProblem(missing, 'docs/roles.md: missing; run node scripts/check-roles.mjs --write', '--check');
});

test('every problem is listed, one per line', () => {
  const root = fixture((f) => {
    edit(f, 'skills/jevellan-router/SKILL.md', 'jh-role: placement', '');
    edit(f, 'skills/jevellan-git/SKILL.md', 'name: jevellan-git', 'name: git');
    delete f['skills/jevellan-workflow-bug/workflow.json'];
  }, { write: false });
  const lines = expectProblem(root, 'jh-role is missing');
  assert.ok(lines.some((l) => l.includes('name "git" does not match')));
  assert.ok(lines.some((l) => l.includes('workflow.json: missing')));
  assert.ok(lines.some((l) => l.includes('"the placement skill" but no skill has jh-role placement')));
  assert.equal(lines[lines.length - 1], `check-roles: ${lines.length - 1} problems`);
});

test('an unquoted value with ": " and a missing frontmatter are refused', () => {
  const colon = fixture((f) => edit(f, 'skills/jevellan-router/SKILL.md', "description: 'Placement. Use when a step needs a model, effort and provider.'", 'description: Placement. Use when a step needs: a model'), { write: false });
  expectProblem(colon, 'skills/jevellan-router/SKILL.md: description: an unquoted value may not contain ": "; put the value in double quotes');
  const none = fixture((f) => { f['skills/jevellan-router/SKILL.md'] = '# Placement\n'; }, { write: false });
  expectProblem(none, 'skills/jevellan-router/SKILL.md: no frontmatter');
  const folder = fixture((f) => { f['skills/jevellan-empty/README.md'] = 'nothing\n'; }, { write: false });
  expectProblem(folder, 'skills/jevellan-empty/SKILL.md: missing');
});

test('a usage error exits 2', () => {
  assert.equal(run(null, '--bogus').status, 2);
  assert.equal(run(null, '--write', '--check').status, 2);
});

test('the frontmatter parser reads the YAML subset skills use', () => {
  const { data, body, problems } = parseSkillFile([
    '---',
    'name: jevellan-x',
    'description: >-',
    '  Duty plan. Use when',
    '  planning.',
    'jh-needs: [repo-read, "a, b", \'c\']',
    'jh-list:',
    '  - one',
    '  - "two"',
    'plain: words that',
    '  carry on',
    'quoted: "with \\"escapes\\": fine"',
    '---',
    'Body text.',
  ].join('\r\n'));
  assert.deepEqual(problems, []);
  assert.equal(data.name, 'jevellan-x');
  assert.equal(data.description, 'Duty plan. Use when planning.');
  assert.deepEqual(data['jh-needs'], ['repo-read', 'a, b', 'c']);
  assert.deepEqual(data['jh-list'], ['one', 'two']);
  assert.equal(data.plain, 'words that carry on');
  assert.equal(data.quoted, 'with "escapes": fine');
  assert.equal(body.trim(), 'Body text.');
  assert.match(parseSkillFile('---\nname: x\n').problems[0], /no closing "---"/);
  assert.match(parseSkillFile('---\nname: x\nname: y\n---\n').problems[0], /name appears twice/);
});

test('kindsUsed finds literals in strings, templates and substitutions, not in comments or regexes', () => {
  const source = [
    "const a = `x${ { b: 'step.inside' }.b }y`;",
    "const r = /'task.regex'/g; // 'task.comment'",
    '/* \'step.block\' */ const s = "step.double";',
    'const t = `landing.template`;',
    "const u = `step.${'x'}`;",
  ].join('\n');
  const kinds = kindsUsed(source).map((k) => `${k.kind}@${k.line}`);
  assert.deepEqual(kinds, ['step.inside@1', 'step.double@3', 'landing.template@4']);
});

test('helper copies that differ are listed as notices on stdout and never fail the lint', () => {
  const helper = (text) => `// A helper each skill keeps its own copy of.\nexport const value = ${JSON.stringify(text)};\n`;
  const root = fixture((f) => {
    f['skills/jevellan-git/scripts/lib/helper.mjs'] = helper('a');
    f['skills/jevellan-router/scripts/lib/helper.mjs'] = helper('b');
    f['skills/jevellan-runtime-alpha/scripts/lib/helper.mjs'] = helper('a');
    f['skills/jevellan-git/scripts/lib/same.mjs'] = helper('same');
    f['skills/jevellan-router/scripts/lib/same.mjs'] = helper('same');
    f['skills/jevellan-router/scripts/lib/nested/deep.mjs'] = helper('x');
    f['skills/jevellan-runtime-alpha/scripts/lib/nested/deep.mjs'] = helper('y');
    f['skills/jevellan-runtime-alpha/scripts/lib/alone.mjs'] = helper('alone');
  });
  const result = run(root, '--check');
  assert.equal(result.status, 0, result.stderr);
  const notices = result.stdout.split('\n').filter((l) => l.startsWith('notice: '));
  assert.ok(notices.includes('notice: scripts/lib/helper.mjs differs between the 3 skills that keep a copy: version 1 in jevellan-git, jevellan-runtime-alpha; version 2 in jevellan-router'), notices.join('\n'));
  assert.ok(notices.includes('notice: scripts/lib/nested/deep.mjs differs between the 2 skills that keep a copy: version 1 in jevellan-router; version 2 in jevellan-runtime-alpha'), notices.join('\n'));
  assert.ok(!notices.some((l) => l.includes('same.mjs') || l.includes('alone.mjs')), 'identical copies and single files are not listed');
  assert.match(result.stdout, /check-roles: 8 skills, 20 event kinds, clean/);
  assert.equal(result.stderr, '');
  // The function returns the lines; a repository without differing copies has none.
  assert.ok(lintSharedLibs(root).every((l) => l.startsWith('notice: ')));
  assert.deepEqual(lintSharedLibs(fixture(() => {}, { write: false })), []);
});

test('kindsUsed also reads the ledger.mjs record argument, appendLine and the objects appendChecked decides', () => {
  const source = [
    "callLedger(['record', 'step.paused', '--task', T]);",
    "callLedger(['record', '--task', T]);",
    "const isWrite = (c) => ['record', 'append'].includes(c) || ['append', 'show'].includes(c);",
    "appendLine(root, 'warning', { task: T });",
    "appendLine(root, kindVariable, { task: T });",
    'appendChecked(root, T, (task) => {',
    "  if (task.state === 'done') return null;",
    "  return { kind: 'stepped', step: 1, data: { kind: 'feature' } };",
    '});',
    "appendChecked(root, T, () => ({ kind: 'arrowed', data: {} }));",
    "const other = { kind: 'feature' };",
  ].join('\n');
  const kinds = kindsUsed(source).map((k) => `${k.kind}@${k.line}`);
  assert.deepEqual(kinds.sort(), ['arrowed@10', 'step.paused@1', 'stepped@8', 'warning@4'].sort());
});

test('a template literal with substitutions carries its text pieces', () => {
  const tokens = tokenize('const a = `${here}/../${x}/b`;');
  const template = tokens.find((t) => t.type === 'template');
  assert.deepEqual(template.parts, ['', '/../', '/b']);
  assert.equal(template.value, null);
});

test('the kind after append or record is any literal but a flag or a command word, in .mjs, .cjs and .js files', () => {
  const root = fixture((f) => {
    f['skills/jevellan-git/scripts/odd.mjs'] = [
      "run(['append', 'step-bogus', '--data', '{}']);",
      "run(['record', 'step_x', '--task', T]);",
      "run(['append', 'Task.X']);",
      "run(['record', '--task', T]);",
      "run(['record', 'note']);",
      "const isWrite = (c) => ['record', 'append'].includes(c);",
      '',
    ].join('\n');
    f['skills/jevellan-git/scripts/lib/old.cjs'] = "run(['append', 'notes']);\n";
    f['skills/jevellan-git/hooks/old.js'] = "export const k = 'step.paused';\n";
  }, { write: false });
  const lines = expectProblem(root, 'skills/jevellan-git/scripts/odd.mjs:1: event kind "step-bogus" is not one of the 20 in KINDS');
  assert.ok(lines.some((l) => l.startsWith('skills/jevellan-git/scripts/odd.mjs:2: event kind "step_x"')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('skills/jevellan-git/scripts/odd.mjs:3: event kind "Task.X"')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('skills/jevellan-git/scripts/lib/old.cjs:1: event kind "notes"')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('skills/jevellan-git/hooks/old.js:1: event kind "step.paused"')), lines.join('\n'));
  assert.ok(!lines.some((l) => /"(--task|note|append)"/.test(l)), lines.join('\n'));
  const kinds = kindsUsed("run(['append', 'step-bogus']); run(['record', 'Task.X']); run(['record', '-v']); run(['append', 'show']); run(['record', '']);").map((k) => k.kind);
  assert.deepEqual(kinds, ['step-bogus', 'Task.X', '']);
});

test('a template token knows where its substitutions begin', () => {
  const tokens = tokenize("const a = 'x' + `${here}/../${y}/b`;");
  const at = tokens.findIndex((t) => t.type === 'template');
  assert.equal(tokens[tokens[at].from].value, 'here');
  assert.equal(tokens[tokens[at].from - 1].value, '+');
});

test('this repository is clean and docs/roles.md is current', () => {
  const result = run(null, '--check');
  assert.equal(result.status, 0, `${result.stderr}\nrun node scripts/check-roles.mjs --write`);
});
