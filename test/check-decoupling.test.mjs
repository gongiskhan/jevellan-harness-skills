// scripts/check-decoupling.mjs: one fixture repository per rule, built in a temporary folder. A violation fails with
// its rule named on a "<file>:<line>: <rule>: <detail>" line; the allowed forms (node: imports, relative imports inside
// the skill, roles.mjs's private SKILLS_ROOT with its pluginRoot() and runsFromProject(), .jevellan paths,
// harnessHome(), prose mentioning .claude) pass. The last tests read this repository: scripts/test-skills.mjs refuses a
// --concurrency that is not a positive integer, and the skills without scripts must be clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_KINDS, climbOf, interfaceScripts, interfaceSection } from '../scripts/check-decoupling.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'check-decoupling.mjs');
const scratch = process.env.JH_TEST_TMPDIR || os.tmpdir();
fs.mkdirSync(scratch, { recursive: true });
const base = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'check-decoupling-')));

const skillMd = (name, role, body, extra = '') => `---\nname: ${name}\ndescription: "${role[0].toUpperCase()}${role.slice(1)}. Use for the fixture."\njh-role: ${role}\n${extra}---\n\n${body.trim()}\n`;

const LEDGER_LIB = `// The fixture ledger library: only KINDS.\nexport const KINDS = Object.freeze(${JSON.stringify(EVENT_KINDS)});\n`;

// roles.mjs's two readers of the folder holding the skills folder: allowed there, failing anywhere else (they name
// SKILLS_ROOT).
const PLUGIN_FUNCTIONS = `export function pluginRoot(root = SKILLS_ROOT) {
  const holder = path.dirname(path.resolve(root));
  return fs.existsSync(path.join(holder, '.claude-plugin', 'plugin.json')) ? holder : null;
}

export function runsFromProject(project, root = SKILLS_ROOT) {
  return fs.realpathSync(root) === fs.realpathSync(path.join(project, '.claude', 'skills'));
}
`;

// The fixture roles.mjs: the skills folder is private to it, and the scan's results carry no folder.
const ROLES_LIB = `// The fixture roles.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function skillWithRole(role, root = SKILLS_ROOT) {
  const name = fs.readdirSync(root).find((n) => fs.readFileSync(path.join(root, n, 'SKILL.md'), 'utf8').includes(\`jh-role: \${role}\`));
  const text = fs.readFileSync(path.join(root, name, 'SKILL.md'), 'utf8');
  return { name, meta: { 'jh-role': role }, body: text, text };
}

export function runRole(role, script, args = [], root = SKILLS_ROOT) {
  const skill = skillWithRole(role, root);
  const r = spawnSync(process.execPath, [path.join(root, skill.name, 'scripts', script), ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: null };
}

${PLUGIN_FUNCTIONS}`;

const WORKTREE = `// The fixture worktree script: every allowed form at once. The worktree gets a .claude link to the project's .claude
// folder; nothing here touches the owner's settings.
import fs from 'node:fs';
import os from 'os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRole } from './lib/roles.mjs';
export { runRole } from './lib/roles.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(here, '..');
export const harnessHome = () => process.env.JH_HARNESS_HOME || path.join(os.homedir(), '.jevellan-harness');

export async function create(root, worktree, task) {
  const shown = runRole('ledger', 'ledger.mjs', ['show', task, '--json']);
  const ledger = path.join(root, '.jevellan', 'ledger.jsonl');
  const place = path.join(harnessHome(), 'worktrees', path.basename(root));
  fs.symlinkSync(path.join(root, '.claude'), path.join(worktree, '.claude'));
  const policy = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const lazy = await import('./lib/roles.mjs');
  runRole('ledger', 'ledger.mjs', ['record', 'task.worktree', '--task', task, '--data', JSON.stringify({ path: place })]);
  return { shown, ledger, policy, lazy, inside: path.relative(root, worktree).startsWith('..') };
}
`;

const OWN_TEST = `// The fixture skill's own test: a copy of the skill next to a fake ledger.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function layout(tmp) {
  fs.cpSync(SKILL, path.join(tmp, 'skills', path.basename(SKILL)), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'skills', 'fake-ledger', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'skills', 'fake-ledger', 'SKILL.md'), '---\\nname: fake-ledger\\njh-role: ledger\\n---\\n');
}
`;

function baseFiles() {
  return {
    'skills/jevellan-ledger/SKILL.md': skillMd('jevellan-ledger', 'ledger', `# Ledger

The ledger is .jevellan/ledger.jsonl.

## Interface

- \`ledger.mjs show T --json\` -> \`{task, state, steps, lastSeq}\`; exit 3 when the task is not found.
- \`ledger.mjs record <kind> --task T --data JSON --json\` -> the line as written; exit 2 refused.
`),
    'skills/jevellan-ledger/scripts/ledger.mjs': "import fs from 'node:fs';\nimport { KINDS } from './lib/ledger.mjs';\nexport const first = KINDS[0];\nexport const exists = () => fs.existsSync('.jevellan/ledger.jsonl');\n",
    'skills/jevellan-ledger/scripts/lib/ledger.mjs': LEDGER_LIB,
    'skills/jevellan-git/SKILL.md': skillMd('jevellan-git', 'git', `# Git

Make worktrees. The worktree's .claude is a link to the project's .claude; this skill never edits settings.

\`\`\`
# a shell comment inside a fence is not a heading
node <this skill>/scripts/worktree.mjs create --task T
\`\`\`

## Interface

- \`worktree.mjs create --task T --json\` -> \`{path, branch}\`; exit 2 refused, 3 not found.

\`\`\`
# not a heading either
\`\`\`
`),
    'skills/jevellan-git/scripts/worktree.mjs': WORKTREE,
    'skills/jevellan-git/scripts/lib/roles.mjs': ROLES_LIB,
    'skills/jevellan-git/test/worktree.test.mjs': OWN_TEST,
    'skills/jevellan-git/evals/trigger-cases.json': `${JSON.stringify([{ query: 'Set the default model through .claude/settings.json.', should_trigger: false, context_role: 'coordinator' }], null, 2)}\n`,
    'skills/jevellan-git/CHANGELOG.md': '# Changelog\n\n## 0.2.0 - Interface section added\n',
    'skills/jevellan-duty-plan/SKILL.md': skillMd('jevellan-duty-plan', 'duty', '# Plan\n\nWrite plan.md. Unlike jevellan-gitops, this is a duty.\n\n## Interface\n\nNo scripts.\n', 'jh-duty: plan\njh-needs: [repo-read]\n'),
    'scripts/shared.mjs': 'export const shared = 1;\n',
    'test/helpers/fixture.mjs': 'export const helper = 1;\n',
  };
}

let counter = 0;
function fixture(change = () => {}) {
  counter += 1;
  const root = path.join(base, `repo-${counter}`);
  const files = baseFiles();
  change(files, root);
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

function run(root, ...args) {
  const r = spawnSync(process.execPath, [script, ...(root ? ['--root', root] : []), ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines: r.stderr.split('\n').filter(Boolean) };
}

// Expects exit 1 and a problem line for `file` (a path relative to the fixture) with `rule`, optionally on `line`
// and matching `pattern`.
function expectProblem(root, { file, rule, line, pattern }) {
  const r = run(root);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
  const hit = r.lines.some((l) => {
    const m = /^(.+?):(\d+): ([a-z-]+): (.+)$/.exec(l);
    return m && m[1] === file && m[3] === rule && (line === undefined || Number(m[2]) === line) && (!pattern || pattern.test(m[4]));
  });
  assert.ok(hit, `no ${rule} problem for ${file}${line ? `:${line}` : ''}${pattern ? ` matching ${pattern}` : ''}:\n${r.stderr}`);
  return r.lines;
}

// The first line appended to the fixture worktree script, and whether a problem of `file` sits before line `first`.
const L = WORKTREE.split('\n').length;
const before = (lines, file, first) => lines.some((l) => {
  const m = /^(.+?):(\d+): /.exec(l);
  return m && m[1] === file && Number(m[2]) < first;
});
const rulesOf = (lines) => new Set(lines.map((l) => /^.+?:\d+: ([a-z-]+): /.exec(l)?.[1]).filter(Boolean));
const add = (files, rel, text) => {
  files[rel] = `${files[rel] ?? ''}${text}`;
};
const WT = 'skills/jevellan-git/scripts/worktree.mjs';

test('the clean fixture passes, with every allowed form', () => {
  const r = run(fixture());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'check-decoupling: 3 skills, clean\n');
});

test('a: imports of packages, computed specifiers and other skills\' files fail; built-ins and relative paths inside pass', () => {
  const root = fixture((f) => {
    add(f, WT, [
      "import _ from 'lodash';",
      "const dyn = await import(['./lib', 'roles.mjs'].join('/'));",
      "const pad = require('left-pad');",
      "const fsAgain = require('fs');",
      "import { KINDS } from '../../jevellan-ledger/scripts/lib/ledger.mjs';",
      "export { a } from 'node:not-a-builtin';",
      '',
    ].join('\n'));
  });
  const lines = expectProblem(root, { file: WT, rule: 'import', line: L, pattern: /"lodash" is neither a Node built-in nor a relative path inside the skill/ });
  expectProblem(root, { file: WT, rule: 'import', line: L + 1, pattern: /^import\(\): a computed specifier/ });
  expectProblem(root, { file: WT, rule: 'import', line: L + 2, pattern: /^require\(\): "left-pad"/ });
  expectProblem(root, { file: WT, rule: 'import', line: L + 4, pattern: /resolves to skills\/jevellan-ledger\/scripts\/lib\/ledger\.mjs, another skill's files; use that skill through runRole/ });
  expectProblem(root, { file: WT, rule: 'import', line: L + 5, pattern: /"node:not-a-builtin" is not a Node built-in/ });
  assert.ok(!lines.some((l) => l.startsWith(`${WT}:${L + 3}:`)), 'require of a bare built-in passes');
  assert.ok(!before(lines, WT, L), `the allowed imports pass:\n${lines.join('\n')}`);
});

test('a: an own test may import its own copied skill by a computed path; a literal path to a sibling still fails', () => {
  const root = fixture((f) => {
    add(f, 'skills/jevellan-git/test/worktree.test.mjs', "export const copied = (tmp) => import(path.join(tmp, 'skills', 'x', 'scripts', 'lib', 'roles.mjs'));\nexport const sibling = () => import('../../jevellan-ledger/scripts/ledger.mjs');\n");
  });
  const T = OWN_TEST.split('\n').length;
  const lines = expectProblem(root, { file: 'skills/jevellan-git/test/worktree.test.mjs', rule: 'import', line: T + 1, pattern: /another skill's files/ });
  assert.ok(!lines.some((l) => l.startsWith(`skills/jevellan-git/test/worktree.test.mjs:${T}:`)), lines.join('\n'));
});

test('a: an absolute specifier fails even inside the skill', () => {
  const root = fixture((f, rootDir) => {
    add(f, WT, `import { runRole as again } from '${rootDir}/skills/jevellan-git/scripts/lib/roles.mjs';\n`);
  });
  expectProblem(root, { file: WT, rule: 'import', line: L, pattern: /is an absolute specifier; use a relative path inside the skill/ });
});

test('a: every createRequire, getBuiltinModule of "module" and x.require(...) fail, under test/ too', () => {
  const root = fixture((f) => {
    add(f, WT, [
      "import { createRequire } from 'node:module';",
      'const req = createRequire(import.meta.url);',
      "export const own = req('./lib/roles.mjs');",
      "export const direct = module.createRequire(import.meta.url)('./lib/roles.mjs');",
      "export const pad = module.require('left-pad');",
      "export const mod = process.getBuiltinModule('node:module');",
      "export const fsAgain = process.getBuiltinModule('node:fs');",
      '',
    ].join('\n'));
    add(f, 'skills/jevellan-git/test/worktree.test.mjs', "export const req = (await import('node:module')).createRequire(import.meta.url);\n");
  });
  const lines = expectProblem(root, { file: WT, rule: 'import', line: L, pattern: /^createRequire builds a require the lint cannot follow; import Node built-ins statically$/ });
  expectProblem(root, { file: WT, rule: 'import', line: L + 1, pattern: /^createRequire builds a require/ });
  expectProblem(root, { file: WT, rule: 'import', line: L + 3, pattern: /^createRequire builds a require/ });
  expectProblem(root, { file: WT, rule: 'import', line: L + 4, pattern: /^require\(\): "left-pad" is neither a Node built-in/ });
  expectProblem(root, { file: WT, rule: 'import', line: L + 5, pattern: /^getBuiltinModule\(\) of "module" \(or of a computed name\) reaches createRequire/ });
  expectProblem(root, { file: 'skills/jevellan-git/test/worktree.test.mjs', rule: 'import', line: OWN_TEST.split('\n').length, pattern: /^createRequire builds a require/ });
  assert.ok(!lines.some((l) => l.startsWith(`${WT}:${L + 2}:`) || l.startsWith(`${WT}:${L + 6}:`)), `a call of the built require and a built-in through getBuiltinModule are not import sites:\n${lines.join('\n')}`);
});

test('import: a TypeScript file under a skill fails outright; .js and .cjs files are code', () => {
  const root = fixture((f) => {
    for (const ext of ['ts', 'mts', 'cts']) f[`skills/jevellan-git/scripts/lib/typed.${ext}`] = "import x from 'lodash';\nexport const n: number = 1;\n";
    f['skills/jevellan-git/scripts/lib/old.cjs'] = "module.exports = require('left-pad');\n";
    f['skills/jevellan-git/scripts/lib/old.js'] = "export { KINDS } from '../../../jevellan-ledger/scripts/lib/ledger.mjs';\n";
  });
  const lines = expectProblem(root, { file: 'skills/jevellan-git/scripts/lib/typed.ts', rule: 'import', line: 1, pattern: /^a TypeScript file; skills ship \.mjs only$/ });
  expectProblem(root, { file: 'skills/jevellan-git/scripts/lib/typed.mts', rule: 'import', line: 1, pattern: /skills ship \.mjs only/ });
  expectProblem(root, { file: 'skills/jevellan-git/scripts/lib/typed.cts', rule: 'import', line: 1, pattern: /skills ship \.mjs only/ });
  expectProblem(root, { file: 'skills/jevellan-git/scripts/lib/old.cjs', rule: 'import', line: 1, pattern: /"left-pad"/ });
  expectProblem(root, { file: 'skills/jevellan-git/scripts/lib/old.js', rule: 'import', line: 1, pattern: /another skill's files/ });
  assert.equal(lines.filter((l) => l.startsWith('skills/jevellan-git/scripts/lib/typed.')).length, 3, `one problem per TypeScript file:\n${lines.join('\n')}`);
});

test('path and import: symbolic links and node_modules folders under a skill fail, and neither is followed', () => {
  const root = fixture((f) => {
    f['skills/jevellan-git/node_modules/left-pad/index.js'] = "module.exports = require('right-pad');\n";
    f['skills/jevellan-git/test/fixtures/node_modules/x/package.json'] = '{}\n';
  });
  fs.symlinkSync('../../../jevellan-ledger/scripts/lib/ledger.mjs', path.join(root, 'skills', 'jevellan-git', 'scripts', 'lib', 'linked.mjs'));
  fs.symlinkSync('../jevellan-ledger/scripts', path.join(root, 'skills', 'jevellan-git', 'borrowed'));
  fs.symlinkSync('jevellan-git', path.join(root, 'skills', 'jevellan-alias'));
  const lines = expectProblem(root, { file: 'skills/jevellan-git/scripts/lib/linked.mjs', rule: 'path', line: 1, pattern: /^a symbolic link; a skill holds plain files only$/ });
  expectProblem(root, { file: 'skills/jevellan-git/borrowed', rule: 'path', line: 1, pattern: /^a symbolic link; a skill holds plain files only$/ });
  expectProblem(root, { file: 'skills/jevellan-alias', rule: 'path', line: 1, pattern: /^a symbolic link; a skill holds plain files only$/ });
  expectProblem(root, { file: 'skills/jevellan-git/node_modules', rule: 'import', line: 1, pattern: /^a node_modules folder; Node built-ins only$/ });
  expectProblem(root, { file: 'skills/jevellan-git/test/fixtures/node_modules', rule: 'import', line: 1, pattern: /^a node_modules folder; Node built-ins only$/ });
  assert.ok(!lines.some((l) => l.includes('right-pad') || l.startsWith('skills/jevellan-git/borrowed/')), `nothing behind a link or in node_modules is read:\n${lines.join('\n')}`);
});

test('b: paths that climb out of the skill fail; SKILLS_ROOT in roles.mjs, .jevellan and harnessHome() pass', () => {
  const root = fixture((f) => {
    add(f, WT, [
      "export const up2 = path.resolve(here, '..', '..');",
      "export const url = new URL('../../../skills.json', import.meta.url);",
      'export const dirs = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));',
      "export const loose = '../../../shared';",
      "export const mixed = path.join(here, 'x', '..', '..', '..');",
      "export const tpl = fs.readFileSync(`${here}/../../other/x.json`);",
      "export const scanned = path.join(skillWithRole('ledger').dir, 'scripts', 'ledger.mjs');",
      "export const libbed = path.join(found.dir, 'scripts', 'lib', 'ledger.mjs');",
      "export const fine = path.join(here, 'x', '..', '..');",
      "export const rooted = path.join(SKILLS_ROOT, sibling, 'scripts', 'ledger.mjs');",
      '',
    ].join('\n'));
    f['skills/jevellan-git/scripts/lib/skills-root.mjs'] = "import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nexport const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');\n";
  });
  expectProblem(root, { file: WT, rule: 'path', line: L, pattern: /resolve\(\.\.\.\) climbs 2 levels from scripts\/worktree\.mjs \(depth 1 in the skill\), into the folder holding the skills \(another skill's files\)/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 1, pattern: /URL\(\.\.\.\) climbs 3 levels from scripts\/worktree\.mjs \(depth 1 in the skill\), above the folder holding the skills;/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 1, pattern: /URL\(\.\.\.\) climbs 3 levels/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 2, pattern: /dirname\(\.\.\.\) climbs 2 levels/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 3, pattern: /"\.\.\/\.\.\/\.\.\/shared" climbs 3 levels/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 4, pattern: /join\(\.\.\.\) climbs 2 levels/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 5, pattern: /readFileSync\(\.\.\.\) climbs 2 levels/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 6, pattern: /builds a path into another skill's scripts\/ from the role scan/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 7, pattern: /builds a path into another skill's scripts\/lib\// });
  expectProblem(root, { file: WT, rule: 'path', line: L + 9, pattern: /builds a path into another skill's scripts\/ from the role scan/ });
  const lines = expectProblem(root, { file: 'skills/jevellan-git/scripts/lib/skills-root.mjs', rule: 'path', line: 3, pattern: /climbs 3 levels from scripts\/lib\/skills-root\.mjs \(depth 2/ });
  assert.ok(!lines.some((l) => l.startsWith(`${WT}:${L + 8}:`)), 'a climb that stays inside passes');
  assert.ok(!lines.some((l) => l.startsWith('skills/jevellan-git/scripts/lib/roles.mjs:')), `roles.mjs passes:\n${lines.join('\n')}`);
  assert.ok(!before(lines, WT, L), 'the allowed paths pass');
  assert.ok(!lines.some((l) => l.startsWith('skills/jevellan-git/test/')), 'the own test passes');
});

test('b: roles.mjs may climb exactly three levels, only for SKILLS_ROOT', () => {
  const four = fixture((f) => {
    f['skills/jevellan-git/scripts/lib/roles.mjs'] = ROLES_LIB.replace("'..', '..', '..')", "'..', '..', '..', '..')");
  });
  expectProblem(four, { file: 'skills/jevellan-git/scripts/lib/roles.mjs', rule: 'path', line: 7, pattern: /climbs 4 levels/ });
  const other = fixture((f) => {
    add(f, 'skills/jevellan-git/scripts/lib/roles.mjs', "export const ELSEWHERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');\n");
  });
  expectProblem(other, { file: 'skills/jevellan-git/scripts/lib/roles.mjs', rule: 'path', line: ROLES_LIB.split('\n').length, pattern: /climbs 3 levels/ });
});

test('b: a run of literals joined by "+" outside path calls is walked as one path, template pieces included', () => {
  const root = fixture((f) => {
    add(f, WT, [
      "export const up = here + '/../../..';",
      'export const tpl = `${here}/../../x.json`;',
      "export const pieces = '..' + '/' + '..';",
      "export const joined = `${here}/..` + '/..' + `/${here}`;",
      "export const near = '..' + '/x';",
      'export const fine = `${here}/../x`;',
      '',
    ].join('\n'));
  });
  const lines = expectProblem(root, { file: WT, rule: 'path', line: L, pattern: /^"\/\.\.\/\.\.\/\.\." climbs 3 levels from scripts\/worktree\.mjs \(depth 1 in the skill\), out of the skill folder$/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 1, pattern: /^"\$\{\.\.\.\}\/\.\.\/\.\.\/x\.json" climbs 2 levels/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 2, pattern: /^"\.\.\/\.\." climbs 2 levels/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 3, pattern: /^"\$\{\.\.\.\}\/\.\.\/\.\.\/\$\{\.\.\.\}" climbs 2 levels/ });
  assert.ok(!lines.some((l) => l.startsWith(`${WT}:${L + 4}:`) || l.startsWith(`${WT}:${L + 5}:`)), `a run that stays inside passes:\n${lines.join('\n')}`);
});

test('b: outside roles.mjs, SKILLS_ROOT and the folder of a role scan result fail; roles.mjs keeps its folder, pluginRoot and runsFromProject', () => {
  const root = fixture((f) => {
    add(f, WT, [
      "import { installedSkills, skillWithRole, skillsWithRole } from './lib/roles.mjs';",
      'export const where = SKILLS_ROOT;',
      "export const one = skillWithRole('ledger').dir;",
      "const found = skillsWithRole('ledger');",
      'export const first = found[0].dir;',
      'export const all = found.map((skill) => skill.dir);',
      "export const { dir } = skillWithRole('ledger');",
      'for (const { dir: each } of installedSkills()) console.log(each);',
      "export const named = found.find((s) => s.name === 'x')?.['dir'];",
      "export const fine = [found.length, { dir: 'x' }.dir, harness.dir, found[0].name];",
      PLUGIN_FUNCTIONS,
    ].join('\n'));
  });
  const P = L + 10;
  const lines = expectProblem(root, { file: WT, rule: 'path', line: L + 1, pattern: /^SKILLS_ROOT outside scripts\/lib\/roles\.mjs: the skills folder is the role scan's alone; use runRole or the scan's results$/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 2, pattern: /^\.dir of a role scan result: the skills folder is the role scan's alone/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 4, pattern: /^\.dir of a role scan result/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 5, pattern: /^\.dir of a role scan result/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 6, pattern: /^dir destructured from a role scan result/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 7, pattern: /^dir destructured from a role scan result/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 8, pattern: /^\.dir of a role scan result/ });
  expectProblem(root, { file: WT, rule: 'path', line: P, pattern: /^SKILLS_ROOT outside/ });
  expectProblem(root, { file: WT, rule: 'path', line: P + 5, pattern: /^SKILLS_ROOT outside/ });
  for (const line of [L, L + 3, L + 9]) assert.ok(!lines.some((l) => l.startsWith(`${WT}:${line}:`)), `line ${line} passes:\n${lines.join('\n')}`);
  assert.ok(!lines.some((l) => l.startsWith('skills/jevellan-git/scripts/lib/roles.mjs:')), `roles.mjs passes:\n${lines.join('\n')}`);
});

test('b: the repository\'s absolute path and ".." joined with another skill\'s name fail', () => {
  const root = fixture((f, rootDir) => {
    add(f, WT, `export const abs = '${rootDir}/skills/jevellan-git/SKILL.md';\nexport const sib = '../' + 'jevellan-ledger';\n`);
    add(f, 'skills/jevellan-git/SKILL.md', `\nSee ${rootDir}/README.md.\n`);
  });
  expectProblem(root, { file: WT, rule: 'path', line: L, pattern: /holds the repository's absolute path/ });
  expectProblem(root, { file: WT, rule: 'path', line: L + 1, pattern: /"\.\.\/" \+ "jevellan-ledger" reaches another skill's folder/ });
  expectProblem(root, { file: 'skills/jevellan-git/SKILL.md', rule: 'path', pattern: /holds the repository's absolute path/ });
});

test('c: another skill\'s folder name anywhere under the skill fails; its own name and longer words pass', () => {
  const root = fixture((f) => {
    add(f, 'skills/jevellan-git/SKILL.md', '\nAsk jevellan-ledger for the task.\n');
    add(f, 'skills/jevellan-git/CHANGELOG.md', '- Moved off jevellan-duty-plan.\n');
    add(f, 'skills/jevellan-git/test/worktree.test.mjs', "export const fake = 'jevellan-ledger';\n");
    f['skills/jevellan-git/evals/cases.json'] = '[{"skill": "JEVELLAN-LEDGER"}]\n';
    f['skills/jevellan-git/test/fixtures/jevellan-ledger/SKILL.md'] = 'a fake named after a real skill\n';
  });
  const lines = expectProblem(root, { file: 'skills/jevellan-git/SKILL.md', rule: 'skill-name', pattern: /names another skill, "jevellan-ledger"; refer to its role instead/ });
  expectProblem(root, { file: 'skills/jevellan-git/CHANGELOG.md', rule: 'skill-name', line: 4, pattern: /"jevellan-duty-plan"/ });
  expectProblem(root, { file: 'skills/jevellan-git/test/worktree.test.mjs', rule: 'skill-name', line: OWN_TEST.split('\n').length });
  expectProblem(root, { file: 'skills/jevellan-git/evals/cases.json', rule: 'skill-name', line: 1 });
  expectProblem(root, { file: 'skills/jevellan-git/test/fixtures/jevellan-ledger/SKILL.md', rule: 'skill-name', line: 1, pattern: /the file's path names another skill/ });
  assert.ok(!lines.some((l) => l.startsWith('skills/jevellan-duty-plan/')), 'jevellan-gitops is not jevellan-git');
});

test('d: a module at the repository root, imported or named, fails with its own message', () => {
  const root = fixture((f) => {
    add(f, WT, "import { shared } from '../../../scripts/shared.mjs';\nexport const helper = 'test/helpers/fixture.mjs';\nexport const joined = path.join(repoRoot, 'test', 'helpers', 'fixture.mjs');\n");
  });
  const lines = expectProblem(root, { file: WT, rule: 'repo-module', line: L, pattern: /resolves to scripts\/shared\.mjs, a module at the repository root outside skills\// });
  expectProblem(root, { file: WT, rule: 'repo-module', line: L + 1, pattern: /names test\/helpers\/fixture\.mjs, a module at the repository root/ });
  expectProblem(root, { file: WT, rule: 'repo-module', line: L + 2 });
  assert.ok(!lines.some((l) => l.startsWith(`${WT}:26: path:`)), 'the import is reported once, as repo-module');
});

test('e: ~/.claude, a home joined with .claude and .claude/settings fail; the .claude link and eval queries pass', () => {
  const root = fixture((f) => {
    add(f, WT, [
      '// Reads ~/.claude/CLAUDE.md for the owner rules.',
      "export const skillsHome = path.join(os.homedir(), '.claude', 'skills');",
      'export const excludes = (home) => [`${home}/.claude/**`];',
      "export const settings = path.join(root, '.claude', 'settings.local.json');",
      "export const literal = '.claude/settings.json';",
      "export const concat = os.homedir() + '/.claude';",
      "export const ownerHome = () => process.env.HOME;\nexport const fromOwner = path.resolve(ownerHome(), '.claude');",
      '',
    ].join('\n'));
    add(f, 'skills/jevellan-duty-plan/SKILL.md', '\nNever touch $HOME/.claude here.\n');
  });
  const lines = expectProblem(root, { file: WT, rule: 'claude-home', line: L, pattern: /refers to ~\/\.claude/ });
  expectProblem(root, { file: WT, rule: 'claude-home', line: L + 1, pattern: /joins a home folder with "\.claude"/ });
  expectProblem(root, { file: WT, rule: 'claude-home', line: L + 2, pattern: /\$\{home\}\/\.claude joins a home folder with \.claude/ });
  expectProblem(root, { file: WT, rule: 'claude-home', line: L + 3, pattern: /builds a \.claude\/settings path/ });
  expectProblem(root, { file: WT, rule: 'claude-home', line: L + 4, pattern: /refers to \.claude\/settings/ });
  expectProblem(root, { file: WT, rule: 'claude-home', line: L + 5, pattern: /a home folder \+ "\/\.claude"/ });
  expectProblem(root, { file: WT, rule: 'claude-home', line: L + 7 });
  expectProblem(root, { file: 'skills/jevellan-duty-plan/SKILL.md', rule: 'claude-home', pattern: /\$HOME\/\.claude/ });
  assert.ok(!lines.some((l) => l.includes('claude-home') && (l.includes('trigger-cases.json') || l.startsWith('skills/jevellan-git/SKILL.md'))) && !before(lines, WT, L),
    `prose about the .claude link, the link itself and eval queries pass:\n${lines.join('\n')}`);
});

test('e: a name bound to a home folder is a home, and every outermost path call is checked', () => {
  const root = fixture((f) => {
    add(f, WT, [
      'const h = os.homedir();',
      "export const aliased = path.join(h, '.claude', 'skills');",
      'const who = os.userInfo().homedir;',
      "export const written = () => fs.writeFileSync(path.join(who, '.claude', 'x.json'), '{}');",
      'const e = process.env.HOME;',
      "export const made = () => fs.mkdirSync(path.join(e, '.claude'), { recursive: true });",
      'const o = ownerHome();',
      "export const glued = o + '/.claude';",
      "export const appended = () => fs.appendFileSync(path.join(root, '.claude', 'settings.json'), 'x');",
      'const again = h;',
      'export const tpl = `${again}/.claude`;',
      "export const plugin = path.join(h, '.claude-plugin', 'plugin.json');",
      "export const harnessed = path.join(harnessHome(), '.claude');",
      '',
    ].join('\n'));
  });
  const lines = expectProblem(root, { file: WT, rule: 'claude-home', line: L + 1, pattern: /^join\(\.\.\.\) joins a home folder with "\.claude"/ });
  expectProblem(root, { file: WT, rule: 'claude-home', line: L + 3, pattern: /^writeFileSync\(\.\.\.\) joins a home folder with "\.claude"/ });
  expectProblem(root, { file: WT, rule: 'claude-home', line: L + 5, pattern: /^mkdirSync\(\.\.\.\) joins a home folder with "\.claude"/ });
  expectProblem(root, { file: WT, rule: 'claude-home', line: L + 7, pattern: /^a home folder \+ "\/\.claude"/ });
  expectProblem(root, { file: WT, rule: 'claude-home', line: L + 8, pattern: /^appendFileSync\(\.\.\.\) builds a \.claude\/settings path/ });
  expectProblem(root, { file: WT, rule: 'claude-home', line: L + 10, pattern: /^a template joins a home folder with \.claude/ });
  for (const line of [L, L + 2, L + 4, L + 6, L + 9, L + 11, L + 12]) {
    assert.ok(!lines.some((l) => l.startsWith(`${WT}:${line}:`)), `line ${line} passes:\n${lines.join('\n')}`);
  }
});

test('f: an event kind beyond the twenty fails, and so does a ledger KINDS that is not exactly the twenty', () => {
  const root = fixture((f) => {
    add(f, WT, "export const paused = 'step.paused';\nexport const warn = (root) => appendLine(root, 'warning', {});\nexport const ok = (root) => appendLine(root, 'note', {});\n");
    add(f, WT, "export const odd = () => [['append', 'step-bogus'], ['record', 'Task.X', '--task', 'T'], ['record', '--task', 'T'], ['append', 'show']];\n");
  });
  const lines = expectProblem(root, { file: WT, rule: 'event-kind', line: L, pattern: /"step\.paused" is not one of the twenty event kinds/ });
  expectProblem(root, { file: WT, rule: 'event-kind', line: L + 1, pattern: /"warning"/ });
  expectProblem(root, { file: WT, rule: 'event-kind', line: L + 3, pattern: /"step-bogus" is not one of the twenty event kinds/ });
  expectProblem(root, { file: WT, rule: 'event-kind', line: L + 3, pattern: /"Task\.X" is not one of the twenty event kinds/ });
  assert.ok(!lines.some((l) => l.includes('"note"') || l.includes('"--task"') || l.includes('"show"')), lines.join('\n'));
  const kinds = fixture((f) => {
    f['skills/jevellan-ledger/scripts/lib/ledger.mjs'] = `export const KINDS = Object.freeze(${JSON.stringify([...EVENT_KINDS.filter((k) => k !== 'task.asked'), 'step.paused'])});\n`;
  });
  expectProblem(kinds, { file: 'skills/jevellan-ledger/scripts/lib/ledger.mjs', rule: 'event-kind', pattern: /must be exactly the twenty event kinds \(beyond the twenty: step\.paused; missing: task\.asked\)/ });
  const more = fixture((f) => {
    f['skills/jevellan-ledger/scripts/lib/ledger.mjs'] = `export const KINDS = Object.freeze(${JSON.stringify([...EVENT_KINDS, 'note'])});\n`;
  });
  expectProblem(more, { file: 'skills/jevellan-ledger/scripts/lib/ledger.mjs', rule: 'event-kind', pattern: /21 entries/ });
  const broken = fixture((f) => {
    f['skills/jevellan-ledger/scripts/lib/ledger.mjs'] = 'export const KINDS = ;\n';
  });
  expectProblem(broken, { file: 'skills/jevellan-ledger/scripts/lib/ledger.mjs', rule: 'event-kind', pattern: /cannot import KINDS/ });
});

test('g: runRole needs literal arguments, a bare script name and a target listed in the role\'s Interface section', () => {
  const root = fixture((f) => {
    add(f, WT, [
      "export const a = (role) => runRole(role, 'ledger.mjs', []);",
      "export const b = (name) => runRole('ledger', name, []);",
      "export const c = () => runRole('ledger', 'lib/ledger.mjs', []);",
      "export const d = () => runRole('ledger', 'tail.mjs', []);",
      "export const e = () => runRole('nobody', 'x.mjs', []);",
      "export const g = () => runRole('ledger', `ledger.mjs`);",
      '',
    ].join('\n'));
  });
  const lines = expectProblem(root, { file: WT, rule: 'run-role', line: L, pattern: /role must be a string literal/ });
  expectProblem(root, { file: WT, rule: 'run-role', line: L + 1, pattern: /the script must be a string literal/ });
  expectProblem(root, { file: WT, rule: 'run-role', line: L + 2, pattern: /must be a bare "<name>\.mjs"/ });
  expectProblem(root, { file: WT, rule: 'run-role', line: L + 3, pattern: /no skill with jh-role ledger lists `tail\.mjs` in its "## Interface" section \(jevellan-ledger\)/ });
  expectProblem(root, { file: WT, rule: 'run-role', line: L + 4, pattern: /no skill has jh-role nobody/ });
  assert.ok(!lines.some((l) => l.startsWith(`${WT}:${L + 5}:`)), 'a template literal without substitutions is a literal');
  assert.ok(!lines.some((l) => l.startsWith('skills/jevellan-git/scripts/lib/roles.mjs:')), 'the definition is not a call');
});

test('g: every SKILL.md ends with an Interface section listing exactly its top scripts, or "No scripts."', () => {
  const missing = fixture((f) => {
    f['skills/jevellan-ledger/SKILL.md'] = f['skills/jevellan-ledger/SKILL.md'].replace(/## Interface[\s\S]*$/, '');
  });
  expectProblem(missing, { file: 'skills/jevellan-ledger/SKILL.md', rule: 'interface', line: 1, pattern: /no "## Interface" section/ });
  const unlisted = fixture((f) => {
    f['skills/jevellan-ledger/scripts/tail.mjs'] = "import fs from 'node:fs';\nexport const t = fs;\n";
    add(f, 'skills/jevellan-ledger/SKILL.md', '- `report.mjs T` -> text.\n');
  });
  expectProblem(unlisted, { file: 'skills/jevellan-ledger/SKILL.md', rule: 'interface', pattern: /scripts\/tail\.mjs is not listed; add a bullet starting with `tail\.mjs`/ });
  expectProblem(unlisted, { file: 'skills/jevellan-ledger/SKILL.md', rule: 'interface', pattern: /lists `report\.mjs`, which is not a script at the top of scripts\// });
  const notLast = fixture((f) => {
    add(f, 'skills/jevellan-duty-plan/SKILL.md', '\n## Notes\n\nMore.\n');
  });
  expectProblem(notLast, { file: 'skills/jevellan-duty-plan/SKILL.md', rule: 'interface', line: baseFiles()['skills/jevellan-duty-plan/SKILL.md'].split('\n').length + 1, pattern: /must be the last section of the body; "## Notes" follows it/ });
  const silent = fixture((f) => {
    f['skills/jevellan-duty-plan/SKILL.md'] = f['skills/jevellan-duty-plan/SKILL.md'].replace('No scripts.', 'Nothing to run.');
  });
  expectProblem(silent, { file: 'skills/jevellan-duty-plan/SKILL.md', rule: 'interface', pattern: /has no scripts, so its Interface section must say "No scripts\."/ });
  const contradicts = fixture((f) => {
    add(f, 'skills/jevellan-git/SKILL.md', '\nNo scripts.\n');
  });
  expectProblem(contradicts, { file: 'skills/jevellan-git/SKILL.md', rule: 'interface', pattern: /says "No scripts\." but scripts\/ holds worktree\.mjs/ });
});

test('h: importFromRole anywhere fails', () => {
  const root = fixture((f) => {
    add(f, WT, "export const old = () => importFromRole('ledger', 'scripts/lib/ledger.mjs');\n");
    add(f, 'skills/jevellan-git/CHANGELOG.md', '- importFromRole is gone.\n');
  });
  expectProblem(root, { file: WT, rule: 'import-from-role', line: L, pattern: /importFromRole no longer exists; run the other skill's public script with runRole/ });
  expectProblem(root, { file: 'skills/jevellan-git/CHANGELOG.md', rule: 'import-from-role', line: 4 });
});

test('every problem is on its own line, with a count; usage errors exit 2; --skill narrows the report', () => {
  const root = fixture((f) => {
    add(f, WT, "import _ from 'lodash';\n");
    add(f, 'skills/jevellan-duty-plan/SKILL.md', '\nAsk jevellan-ledger.\n');
  });
  const r = run(root);
  assert.equal(r.status, 1);
  for (const l of r.lines.slice(0, -1)) assert.match(l, /^skills\/[^:]+:\d+: [a-z-]+: \S/);
  assert.equal(r.lines.at(-1), `check-decoupling: ${r.lines.length - 1} problems`);
  assert.deepEqual([...rulesOf(r.lines)].sort(), ['import', 'skill-name']);
  const only = run(root, '--skill', 'jevellan-git');
  assert.equal(only.status, 1);
  assert.ok(only.lines.slice(0, -1).every((l) => l.startsWith('skills/jevellan-git/')), only.stderr);
  const clean = run(root, '--skill', 'jevellan-ledger');
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, 'check-decoupling: 1 skill, clean\n');
  assert.equal(run(root, '--bogus').status, 2);
  assert.equal(run(root, '--skill', 'jevellan-nothing').status, 2);
  assert.equal(run(root, '--skill').status, 2);
  assert.equal(run(path.join(base, 'no-such-repo')).status, 2);
  assert.equal(run(null, '--help').status, 0);
});

test('the helpers: climbs, Interface sections and their script bullets', () => {
  assert.equal(climbOf(['..', '..', '..']), 3);
  assert.equal(climbOf(['x', '..', '..']), 1);
  assert.equal(climbOf(['../a/../..']), 2);
  assert.equal(climbOf(['.jevellan', 'ledger.jsonl']), 0);
  const text = '---\nname: x\n---\n\n# X\n\n```\n## Interface\n```\n\n## Interface\n\nRuns:\n\n- `a.mjs go --json` -> `{}`\n* `scripts/b.mjs`\n- `workflow.json` -> shape\n- plain bullet\n';
  const section = interfaceSection(text);
  assert.equal(section.line, 11);
  assert.equal(section.last, true);
  assert.deepEqual(interfaceScripts(section), ['a.mjs', 'b.mjs']);
  assert.equal(interfaceSection('---\nname: x\n---\n\n# X\n'), null);
});

test('scripts/test-skills.mjs: --concurrency takes a positive integer only, so a run never ends with nothing run', () => {
  const alone = fs.readdirSync(path.join(repo, 'skills')).sort().find((name) => !fs.existsSync(path.join(repo, 'skills', name, 'test')));
  assert.ok(alone, 'a skill without its own tests');
  const testSkills = (...args) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'test-skills.mjs'), '--skill', alone, ...args], {
    encoding: 'utf8',
    env: { ...process.env, JH_TEST_TMPDIR: base },
  });
  for (const value of ['abc', '0', '1.5', '', '=-1']) {
    const r = value === '=-1' ? testSkills('--concurrency=-1') : testSkills('--concurrency', value);
    assert.equal(r.status, 2, `--concurrency ${JSON.stringify(value)}:\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^test-skills: --concurrency must be a positive integer, not ".*"\nusage: /);
  }
  const ok = testSkills('--concurrency', '2');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout, `- ${alone}: no own tests\n`);
});

const NO_SCRIPT_SKILLS = fs.readdirSync(path.join(repo, 'skills')).filter((name) => !fs.existsSync(path.join(repo, 'skills', name, 'scripts'))).sort();

test('this repository: the skills without scripts are clean', () => {
  assert.ok(NO_SCRIPT_SKILLS.length >= 12, NO_SCRIPT_SKILLS.join(', '));
  const r = run(null, ...NO_SCRIPT_SKILLS.flatMap((name) => ['--skill', name]));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `check-decoupling: ${NO_SCRIPT_SKILLS.length} skills, clean\n`);
});
