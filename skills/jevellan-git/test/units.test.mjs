// The git skill's pure parts, imported from this skill's own folder only: the exclude lines and harness paths, the
// git output parsers, the landing state (building and cutting), the landing checks, the landing policy parsed from
// this skill's SKILL.md, resolveChoice, the project settings and the facts read from a task.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUDE_LINES, ensureExclude, isHarnessPath, listText, parseWorktrees } from '../scripts/worktree.mjs';
import {
  CHECK_TIMEOUT_MS,
  LANDING_QUESTION,
  ROUTES,
  STATE_LIMIT,
  TASK_SHORTENED,
  buildLandingState,
  checkEnvironment,
  cut,
  landingFacts,
  landingPolicy,
  landingQuestions,
  landingSettings,
  parseNumstat,
  pathMatches,
  refusedFiles,
  resolveChoice,
  runCheck,
} from '../scripts/land.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.JH_TEST_TMPDIR || os.tmpdir();
const tempDir = (prefix) => {
  fs.mkdirSync(BASE, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(BASE, prefix)));
};

// The body of a policy section as a reader would cut it: from its heading to the next level-2 heading.
const POLICY_TEXT = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
const POLICY_BODY = POLICY_TEXT.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
const section = (name) => new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(POLICY_BODY)[1].trim();
// What the policy hash covers: the body without the "## Interface" section, which is last.
const POLICY_HASHED = POLICY_BODY.replace(/\n## Interface\n[\s\S]*$/, '');

describe('worktree paths and exclude lines', () => {
  test('isHarnessPath counts the report folder, the plan and the .claude link, nothing else', () => {
    for (const p of ['.jevellan', '.jevellan/', '.jevellan/report.json', '.jevellan/evidence/shot.png', 'plan.md', '.claude', '.claude/']) assert.equal(isHarnessPath(p), true, p);
    for (const p of ['docs/plan.md', 'plan.md.bak', '.jevellanx', '.claudex', 'src/.jevellan/x', 'README.md']) assert.equal(isHarnessPath(p), false, p);
  });

  test('ensureExclude adds the missing lines once, accepts a leading slash, and starts on a fresh line', () => {
    assert.deepEqual(EXCLUDE_LINES.map((w) => w.line), ['.jevellan/', 'plan.md', '.claude']);
    const common = tempDir('jh-git-exclude-');
    assert.deepEqual(ensureExclude(null, common), ['.jevellan/', 'plan.md', '.claude']);
    const file = path.join(common, 'info', 'exclude');
    assert.equal(fs.readFileSync(file, 'utf8'), '.jevellan/\nplan.md\n.claude\n');
    assert.deepEqual(ensureExclude(null, common), []);

    const other = tempDir('jh-git-exclude-');
    fs.mkdirSync(path.join(other, 'info'));
    fs.writeFileSync(path.join(other, 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n/.jevellan\n.claude/');
    assert.deepEqual(ensureExclude(null, other), ['plan.md', '.claude']);
    // ".claude/" matches directories only and the worktree's .claude is a link, so ".claude" is still added.
    assert.equal(fs.readFileSync(path.join(other, 'info', 'exclude'), 'utf8'), '# git ls-files --others --exclude-from=.git/info/exclude\n/.jevellan\n.claude/\nplan.md\n.claude\n');
  });

  test('parseWorktrees reads git worktree list --porcelain -z', () => {
    const out = 'worktree /p\0HEAD abc\0branch refs/heads/main\0\0worktree /w\0HEAD def\0branch refs/heads/jh/x\0locked\0\0worktree /gone\0HEAD 123\0detached\0prunable gitdir file points to non-existent location\0\0';
    assert.deepEqual(parseWorktrees(out), [
      { path: '/p', head: 'abc', branch: 'refs/heads/main', prunable: false, locked: false, bare: false },
      { path: '/w', head: 'def', branch: 'refs/heads/jh/x', prunable: false, locked: true, bare: false },
      { path: '/gone', head: '123', prunable: true, locked: false, bare: false },
    ]);
  });

  test('listText names at most ten and counts the rest', () => {
    assert.equal(listText(['a', 'b']), 'a, b');
    assert.equal(listText(Array.from({ length: 12 }, (_, i) => `f${i}`)), 'f0, f1, f2, f3, f4, f5, f6, f7, f8, f9 and 2 more');
  });
});

describe('git output parsers', () => {
  test('parseNumstat reads counts, binary files and tabs in names', () => {
    assert.deepEqual(parseNumstat('3\t1\tdocs/run.md\0-\t-\timg.png\0' + '2\t0\ta\tb.txt\0'), [
      { path: 'docs/run.md', additions: 3, deletions: 1 },
      { path: 'img.png', additions: 0, deletions: 0 },
      { path: 'a\tb.txt', additions: 2, deletions: 0 },
    ]);
    assert.deepEqual(parseNumstat(''), []);
  });

  test('pathMatches is the path itself or below it', () => {
    assert.equal(pathMatches('src/billing/rates.js', 'src/billing'), true);
    assert.equal(pathMatches('src/billing', './src/billing/'), true);
    assert.equal(pathMatches('src/billing-old/x.js', 'src/billing'), false);
    assert.equal(pathMatches('anything', './'), false);
  });

  test('refusedFiles reads the tab-indented names of a git refusal', () => {
    const stderr = 'error: The following untracked working tree files would be overwritten by merge:\n\tlogs\n\tbuild/out.js\nPlease move or remove them before you merge.\nAborting\n';
    assert.deepEqual(refusedFiles(stderr), ['logs', 'build/out.js']);
    assert.deepEqual(refusedFiles(undefined), []);
  });

  test('cut keeps short text and ends long text with three dots', () => {
    assert.equal(cut('short', 10), 'short');
    assert.equal(cut('a'.repeat(20), 10), `${'a'.repeat(7)}...`);
  });
});

describe('the landing state', () => {
  const project = { name: 'demo', guidance: 'Be careful with billing.' };
  const task = { id: 'T1AAAAA', kind: 'feature', title: 'Add a How to run section', text: 'Brief text' };
  const step = (ordinal, duty, extra = {}) => ({ ordinal, duty, state: 'done', summary: `${duty} summary`, tested: null, ...extra });

  test('a small state carries everything, risky files flagged, and only done steps count', () => {
    const { state, json } = buildLandingState({
      project,
      task,
      steps: [
        step(1, 'implement'),
        step(2, 'verify', { tested: { command: 'npm test', passed: true, summary: '12 passed', at: '2026-11-02T00:00:00.000Z' } }),
        step(3, 'document', { state: 'skipped', summary: 'never ran' }),
      ],
      corrections: ['verify failed (attempt 1):   one   test\nwas red'],
      files: [{ path: 'docs/run.md', bytes: 20, additions: 3, deletions: 0 }, { path: 'src/billing/rates.js', bytes: 10, additions: 5, deletions: 1 }],
      riskyPaths: ['src/billing'],
      rules: 'The rules.',
    });
    assert.equal(json, JSON.stringify(state));
    assert.deepEqual(state, {
      schema: 'landing-route-state-v1',
      project,
      title: task.title,
      task: { id: task.id, kind: task.kind, text: task.text },
      summaries: [{ duty: 'implement', summary: 'implement summary' }, { duty: 'verify', summary: 'verify summary' }],
      riskyAreas: ['src/billing'],
      files: [
        { path: 'src/billing/rates.js', bytes: 10, additions: 5, deletions: 1, risky: true },
        { path: 'docs/run.md', bytes: 20, additions: 3, deletions: 0, risky: false },
      ],
      totals: { files: 2, additions: 8, deletions: 1, filesOmitted: 0 },
      checks: [{ duty: 'verify', command: 'npm test', passed: true, summary: '12 passed', at: '2026-11-02T00:00:00.000Z' }],
      corrections: ['verify failed (attempt 1): one test was red'],
      rules: 'The rules.',
    });
  });

  test('over the limit the file list is cut first and risky files are always kept', () => {
    const files = Array.from({ length: 4000 }, (_, i) => ({ path: `src/module-${String(i).padStart(4, '0')}/file-${i}.js`, bytes: 100, additions: 4000 - i, deletions: 1 }));
    files.push({ path: 'db/migrations/0001.sql', bytes: 5, additions: 0, deletions: 0 });
    const { state, json } = buildLandingState({ project, task, steps: [step(1, 'implement')], corrections: [], files, riskyPaths: ['db/migrations'], rules: 'r' });
    assert.ok(json.length <= STATE_LIMIT, String(json.length));
    assert.equal(state.files.length, 501);
    assert.deepEqual(state.files.at(-1), { path: 'db/migrations/0001.sql', bytes: 5, additions: 0, deletions: 0, risky: true });
    assert.equal(state.files[0].path, 'src/module-0000/file-0.js');
    assert.equal(state.totals.files, 4001);
    assert.equal(state.totals.filesOmitted, 4001 - 501);
  });

  test('then the summaries are cut to 1000 characters, then the task text is shortened', () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(i + 1, 'implement', { summary: 's'.repeat(5000) }));
    const big = buildLandingState({ project, task, steps, corrections: [], files: [], riskyPaths: [], rules: 'r' });
    assert.ok(big.json.length <= STATE_LIMIT);
    assert.ok(big.state.summaries.every((s) => s.summary.length === 1000 && s.summary.endsWith('...')));
    assert.equal(big.state.task.text, task.text);

    const long = buildLandingState({ project, task: { ...task, text: 't'.repeat(100000) }, steps: [step(1, 'implement')], corrections: [], files: [], riskyPaths: [], rules: 'r' });
    assert.ok(long.json.length <= STATE_LIMIT, String(long.json.length));
    assert.ok(long.state.task.text.endsWith(`\n${TASK_SHORTENED}`));
    assert.equal(long.state.summaries[0].summary, 'implement summary');
  });

  test('redact masks values before the size is measured', () => {
    const { state } = buildLandingState({
      project,
      task: { ...task, text: 'token sk-secret-value inside' },
      steps: [],
      corrections: [],
      files: [],
      riskyPaths: [],
      rules: 'r',
      redact: (v) => JSON.parse(JSON.stringify(v).replaceAll('sk-secret-value', '[redacted]')),
    });
    assert.equal(state.task.text, 'token [redacted] inside');
  });

  test('landingFacts reads the projection steps, each step\'s view since its reset, and the retry reasons', () => {
    const events = [
      { seq: 1, kind: 'task.created', task: 'T1AAAAA', data: {} },
      { seq: 2, kind: 'step.started', task: 'T1AAAAA', step: 2, data: { duty: 'verify' } },
      { seq: 3, kind: 'step.report', task: 'T1AAAAA', step: 2, t: 'old', data: { summary: 'first try', testsRun: { command: 'npm test', passed: false, summary: 'red' } } },
      { seq: 4, kind: 'step.retrying', task: 'T1AAAAA', step: 2, data: { ordinal: 2, attempt: 1, gotoOrdinal: 1, reason: 'one test was red' } },
      { seq: 5, kind: 'step.started', task: 'T1AAAAA', step: 2, data: { duty: 'verify' } },
      { seq: 6, kind: 'step.report', task: 'T1AAAAA', step: 2, t: 'new', data: { summary: 'second try', testsRun: { command: 'npm test', passed: true, summary: 'green' } } },
    ];
    const views = {
      1: { ordinal: 1, resetSeq: 4, started: null, lastReport: null },
      2: { ordinal: 2, resetSeq: 4, started: events[4], lastReport: events[5] },
    };
    const info = {
      steps: [{ ordinal: 1, duty: 'implement', state: 'done' }, { ordinal: 2, duty: null, state: 'done' }],
      events,
      view: (o) => views[o],
    };
    assert.deepEqual(landingFacts(info), {
      steps: [
        { ordinal: 1, duty: 'implement', state: 'done', summary: null, tested: null },
        { ordinal: 2, duty: 'verify', state: 'done', summary: 'second try', tested: { command: 'npm test', passed: true, summary: 'green', at: 'new' } },
      ],
      corrections: ['verify failed (attempt 1): one test was red'],
    });
  });
});

describe('the landing checks', () => {
  const check = (command, timeoutMs = 60000) => ({ name: cut(command, 80), command, timeoutMs });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

  test('a passing check keeps its output tail', async () => {
    const r = await runCheck(os.tmpdir(), check('echo out; echo err >&2'), env);
    assert.equal(r.passed, true);
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.tail, 'out\nerr\n');
  });

  test('a failing check reports its exit code', async () => {
    const r = await runCheck(os.tmpdir(), check('echo nope; exit 3'), env);
    assert.equal(r.passed, false);
    assert.equal(r.exitCode, 3);
    assert.equal(r.tail, 'nope\n');
  });

  test('a check over its timeout is ended with its process group and says so', async () => {
    const started = Date.now();
    const r = await runCheck(os.tmpdir(), check('echo begin; sleep 30', 300), env);
    assert.equal(r.passed, false);
    assert.equal(r.timedOut, true);
    assert.match(r.tail, /^begin\n[\s\S]*\[timed out after 300 ms\]$/);
    assert.ok(Date.now() - started < 10000, 'ended well before the sleep');
  });

  test('what a check leaves running in its group does not hold the landing', async () => {
    const started = Date.now();
    const r = await runCheck(os.tmpdir(), check('sleep 30 & echo started'), env);
    assert.equal(r.passed, true);
    assert.equal(r.tail, 'started\n');
    assert.ok(Date.now() - started < 10000);
  });

  test('checkEnvironment passes only the base keys, the owner\'s HOME and the git identity', () => {
    const out = checkEnvironment('/home/owner', { name: 'Owner', email: 'o@example.com' }, { PATH: '/bin', LANG: 'C', SOME_TOKEN: 'x', HOME: '/elsewhere' });
    assert.deepEqual(out, {
      PATH: '/bin', LANG: 'C', HOME: '/home/owner',
      GIT_AUTHOR_NAME: 'Owner', GIT_COMMITTER_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'o@example.com', GIT_COMMITTER_EMAIL: 'o@example.com',
    });
    assert.equal(checkEnvironment('/home/owner', {}, {}).PATH, '/usr/local/bin:/usr/bin:/bin');
  });
});

describe('the landing policy', () => {
  test('this SKILL.md parses: three routes, the instructions and the rules, and the Interface section is not sent', () => {
    const lp = landingPolicy();
    assert.deepEqual([...lp.routes.keys()], ROUTES);
    assert.equal(lp.instructions, section('landing_route'));
    assert.equal(lp.rules, section('rules'));
    // The Interface section documents the scripts: it is neither a section the script reads nor part of the hash.
    assert.ok(POLICY_BODY.includes('\n## Interface\n'));
    assert.equal(lp.policy.hash, crypto.createHash('sha256').update(POLICY_HASHED).digest('hex'));
    assert.equal(lp.policy.sections.has('interface'), false);
    const sent = JSON.stringify(landingQuestions(lp)) + lp.rules;
    assert.equal(sent.includes('## Interface'), false);
    assert.equal(sent.includes('worktree.mjs'), false);
    assert.deepEqual(landingQuestions(lp), {
      [LANDING_QUESTION]: { type: 'choice', instructions: lp.instructions, criteria: Object.fromEntries(ROUTES.map((r) => [r, lp.routes.get(r)])) },
    });
  });

  test('a policy with a missing section or other routes refuses', () => {
    const dir = tempDir('jh-git-policy-');
    const write = (body) => {
      const file = path.join(dir, `${crypto.randomUUID()}.md`);
      fs.writeFileSync(file, `---\nname: x\n---\n${body}`);
      return file;
    };
    const full = (routes) => `## landing_route\n\nChoose.\n\n## routes\n\n${routes}\n\n## rules\n\nRules.\n\n## Interface\n\n- \`land.mjs\`\n`;
    assert.throws(() => landingPolicy(write('## landing_route\n\nChoose.\n\n## rules\n\nR.\n')), (e) => e.exitCode === 2 && /the section "## routes" is missing or empty/.test(e.message));
    assert.throws(
      () => landingPolicy(write(full('land: a\nverify-then-land: b\nask-owner: c\nyolo: d'))),
      (e) => e.exitCode === 2 && /must have exactly the lines land, verify-then-land, ask-owner; unknown yolo$/.test(e.message),
    );
    assert.throws(() => landingPolicy(write(full('land: a\nask-owner: c'))), /; missing verify-then-land$/);
    assert.throws(() => landingPolicy(write(full('land: a\nnot a line'))), /is not an "<id>: <text>" line/);
    const ok = landingPolicy(write(full('land: a\nverify-then-land: b\nask-owner: c')));
    assert.equal(ok.rules, 'Rules.');
  });

  test('resolveChoice: the highest probability wins, a tie goes to Jev\'s own choice', () => {
    const question = { criteria: { land: 'a', 'verify-then-land': 'b', 'ask-owner': 'c' } };
    assert.deepEqual(resolveChoice(question, { choice: 'land', probabilities: { land: 0.2, 'verify-then-land': 0.7, 'ask-owner': 0.1 } }), {
      option: 'verify-then-land',
      probabilities: { land: 0.2, 'verify-then-land': 0.7, 'ask-owner': 0.1 },
    });
    assert.equal(resolveChoice(question, { choice: 'ask-owner', probabilities: { land: 0.45, 'ask-owner': 0.45 } }).option, 'ask-owner');
    assert.equal(resolveChoice(question, { choice: 'nonsense', probabilities: { land: 0.45, 'ask-owner': 0.45 } }).option, 'land');
    // No answer at all is no option (the caller refuses it as an invalid response), never a route by default.
    assert.deepEqual(resolveChoice(question, undefined), { option: undefined, probabilities: { land: 0, 'verify-then-land': 0, 'ask-owner': 0 } });
    assert.equal(resolveChoice(question, { choice: 'nonsense', probabilities: {} }).option, 'nonsense');
  });
});

describe('the project settings', () => {
  test('checks are commands or {name, command, timeoutMs}; none means the testCommand', () => {
    const s = landingSettings({ checks: ['npm test', { name: 'e2e', command: 'npm run e2e', timeoutMs: 1000 }], riskyPaths: [' src/billing '], pushAfterLanding: true, guidance: 'g' });
    assert.deepEqual(s, {
      riskyPaths: ['src/billing'],
      checks: [{ name: 'npm test', command: 'npm test', timeoutMs: CHECK_TIMEOUT_MS }, { name: 'e2e', command: 'npm run e2e', timeoutMs: 1000 }],
      pushAfterLanding: true,
      guidance: 'g',
    });
    assert.deepEqual(landingSettings({ checks: [], testCommand: 'make test' }).checks, [{ name: 'make test', command: 'make test', timeoutMs: CHECK_TIMEOUT_MS }]);
    assert.deepEqual(landingSettings({}), { riskyPaths: [], checks: [], pushAfterLanding: false, guidance: '' });
  });

  test('bad settings refuse naming the file and the field', () => {
    const bad = [
      [{ riskyPaths: 'src' }, 'riskyPaths must be a list of paths'],
      [{ checks: 'npm test' }, 'checks must be a list'],
      [{ checks: [''] }, 'checks[0] is empty'],
      [{ checks: [{ command: 'x', extra: 1 }] }, 'checks[0] has an unknown key "extra"'],
      [{ checks: [{ command: 'x', timeoutMs: -1 }] }, 'checks[0].timeoutMs must be a positive integer'],
      [{ pushAfterLanding: 'yes' }, 'pushAfterLanding must be true or false'],
      [{ testCommand: 3 }, 'testCommand must be a command or null'],
    ];
    for (const [config, message] of bad) assert.throws(() => landingSettings(config, 'p.json'), (e) => e.exitCode === 2 && e.message === `p.json: ${message}`, message);
  });
});
