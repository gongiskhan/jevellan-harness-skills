// scripts/run-trigger-evals.mjs against a fake `claude` (JH_CLAUDE_BIN) that emits stream-json lines: the scoring of
// positive, negative and role-missing runs, the installs without the removed role, the context skill's body in the
// system prompt, the command line and environment of every run, the thresholds, the exit codes, and that the provider
// token never reaches the output. The last suite checks the case files the repository ships.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NODE, REPO, tempDir } from './helpers/ledger-fixture.mjs';
import { readSkills } from '../scripts/check-roles.mjs';
import {
  THRESHOLDS,
  contextSkill,
  loadCases,
  namesMissingRole,
  parseStream,
  selectCases,
  summarize,
} from '../scripts/run-trigger-evals.mjs';

const SCRIPT = path.join(REPO, 'scripts', 'run-trigger-evals.mjs');
const FAKE_TOKEN = 'fake-eval-token-5f1c9e0a7b3d42';
const NAME_EQ = ['CLAUDE_CODE', 'OAUTH_TOKEN', '='].join('_').replace('_=', '=');
const EM_DASH = String.fromCharCode(0x2014);
const TMP_BASE = process.env.JH_TEST_TMPDIR || os.tmpdir();

// The fake reads its plan from $TMPDIR/fake-plan.json, keyed by the exact query: invoke (skill names, each emitted as a
// Skill tool_use when installed), ifMissing (the answer when a named skill is not installed), text, crash ("once" or
// "always"), sleepMs, unloaded (an init event without the installed skills), leak (the token in the answer), guess
// (skill names emitted as Skill calls whether installed or not). Like Claude Code, it leaves an empty
// projects/<cwd>/memory folder in CLAUDE_CONFIG_DIR. Every call is logged to $TMPDIR/fake-log.jsonl with its argv, cwd, installed skills and the environment it saw.
const FAKE_BIN = path.join(tempDir('jh-te-bin-'), 'claude');
fs.writeFileSync(FAKE_BIN, `#!${NODE}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const out = process.env.TMPDIR;
const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const query = dash >= 0 ? argv.slice(dash + 1).join(' ') : '';
const at = argv.indexOf('--append-system-prompt');
const append = at >= 0 && (dash < 0 || at < dash) ? argv[at + 1] : null;
const skillsDir = path.join(process.cwd(), '.claude', 'skills');
let installed = [];
try { installed = fs.readdirSync(skillsDir).sort(); } catch {}
let plan = {};
try { plan = JSON.parse(fs.readFileSync(path.join(out, 'fake-plan.json'), 'utf8')); } catch {}
const entry = plan[query] || {};
const countFile = path.join(out, 'count-' + crypto.createHash('sha1').update(query).digest('hex').slice(0, 16));
const count = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1;
fs.writeFileSync(countFile, String(count));
fs.appendFileSync(path.join(out, 'fake-log.jsonl'), JSON.stringify({
  argv, cwd: process.cwd(), query, append, installed, count,
  evalsCopied: installed.some((name) => fs.existsSync(path.join(skillsDir, name, 'evals'))),
  gitDir: fs.existsSync(path.join(process.cwd(), '.git')),
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
  configDir: process.env.CLAUDE_CONFIG_DIR || null,
  mcp: process.env.ENABLE_CLAUDEAI_MCP_SERVERS || null,
  envKeys: Object.keys(process.env).sort(),
}) + '\\n');
if (entry.crash === 'always' || (entry.crash === 'once' && count === 1)) {
  process.stderr.write('fake claude crashed\\n');
  process.exit(3);
}
if (process.env.CLAUDE_CONFIG_DIR) fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), 'memory'), { recursive: true });
if (entry.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, entry.sleepMs);
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
emit({ type: 'system', subtype: 'init', skills: entry.unloaded ? ['verify'] : [...installed, 'verify', 'debug'], claude_code_version: '9.9.9-fake', model: argv[argv.indexOf('--model') + 1] });
let text = entry.text || 'Done.';
const content = (entry.guess || []).map((name) => ({ type: 'tool_use', id: 'toolu_guess_' + name, name: 'Skill', input: { skill: name } }));
for (const name of entry.invoke || []) {
  if (installed.includes(name)) content.push({ type: 'tool_use', id: 'toolu_' + name, name: 'Skill', input: { skill: name } });
  else if (entry.ifMissing) text = entry.ifMissing;
}
if (entry.leak) text += ' ' + process.env.CLAUDE_CODE_OAUTH_TOKEN;
emit({ type: 'assistant', message: { content: [...content, { type: 'text', text }] } });
if (content.length) emit({ type: 'user', message: { content: content.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'Launching skill: ' + c.input.skill })) } });
emit({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.0125, num_turns: content.length ? 2 : 1 });
`, { mode: 0o755 });

const ROLE_MISSING = "If no skill in your list has that role (a skill's role is the first word of its description), call no skill at all: stop, tell the owner which role is missing, and do not improvise it.";
const SKILLS = {
  'demo-coordinator': { role: 'coordinator', description: 'Coordinator. Use when the owner asks for project work.', body: `Coordinator body C0RD-MARKER. Use the placement skill now and continue with its answer. Use the git skill to make the worktree.\n\n${ROLE_MISSING}` },
  'demo-router': { role: 'placement', description: 'Placement. Use when a step needs a model.', body: 'Placement body.' },
  'demo-git': { role: 'git', description: 'Git. Use when a task needs a worktree.', body: 'Git body.' },
  'demo-duty-plan': { role: 'duty', extra: 'jh-duty: plan\njh-needs: [repo-read]\n', description: 'Duty plan. Use when the step duty is plan.', body: 'Plan body.' },
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

// A repository with the demo skills (each with an evals/ folder holding its case file) and `extra` ones, a harness
// home with providers.json and a token file, and the fake's output folder with its plan.
function setup({ cases, plan = {}, providers, token = true, extra = {} } = {}) {
  const root = tempDir('jh-te-repo-');
  for (const [name, s] of Object.entries({ ...SKILLS, ...extra })) {
    const dir = path.join(root, 'skills', name);
    fs.mkdirSync(path.join(dir, 'evals'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "${s.description}"\njh-role: ${s.role}\n${s.extra ?? ''}---\n\n${s.body}\n`);
    writeJson(path.join(dir, 'evals', 'trigger-cases.json'), cases[name] ?? [{ query: `${name} positive`, should_trigger: true }]);
  }
  const harness = tempDir('jh-te-harness-');
  const tokenFile = path.join(harness, 'secrets', 'claude-second.token');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  if (token) fs.writeFileSync(tokenFile, `${FAKE_TOKEN}\n`, { mode: 0o600 });
  if (providers !== null) {
    writeJson(path.join(harness, 'providers.json'), providers ?? {
      providers: [
        { name: 'claude-second', kind: 'claude-subscription', tokenFile, ceilingPct: 90, models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet', efforts: ['low'] }] },
        { name: 'codex', kind: 'codex-subscription', ceilingPct: 90, models: [{ id: 'gpt-6-astra', label: 'GPT', efforts: ['low'] }] },
      ],
    });
  }
  const fakeOut = tempDir('jh-te-out-');
  writeJson(path.join(fakeOut, 'fake-plan.json'), plan);
  return { root, harness, fakeOut };
}

function run(fx, args = [], env = {}) {
  const r = spawnSync(NODE, [SCRIPT, '--root', fx.root, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      TMPDIR: fx.fakeOut,
      JH_HARNESS_HOME: fx.harness,
      JH_CLAUDE_BIN: FAKE_BIN,
      JH_TEST_TMPDIR: TMP_BASE,
      ...env,
    },
  });
  const outDir = path.join(fx.root, 'evals');
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    results: () => JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8')),
    md: () => fs.readFileSync(path.join(outDir, 'RESULTS.md'), 'utf8'),
    log: () => {
      const file = path.join(fx.fakeOut, 'fake-log.jsonl');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    },
    streamsDir: () => /streams in (\S+)/.exec(r.stdout)?.[1] ?? null,
  };
}

const skillOf = (results, name) => results.skills.find((s) => s.skill === name);
const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

describe('scoring and installs', () => {
  const Q = {
    place: 'Task T1AAAA is created and has its worktree. Use the placement skill now and continue with its answer.',
    model: 'Which model and effort should step 2 of T1AAAA run on? Ask Jev.',
    worktree: 'Task T1AAAA is created. Use the git skill to make the worktree.',
    plain: 'How do I reverse a list in Python?',
    natural: 'Make a worktree for task T1AAAA based on main.',
  };
  const cases = {
    'demo-router': [
      { query: Q.place, should_trigger: true, role_phrase: true, context_role: 'coordinator' },
      { query: Q.model, should_trigger: true },
      { query: Q.worktree, should_trigger: false, role_phrase: true, context_role: 'coordinator' },
      { query: Q.plain, should_trigger: false, held_out: true },
      { query: Q.place, should_trigger: false, role_phrase: true, context_role: 'coordinator', remove_role: 'placement', expect_role_missing: 'placement' },
    ],
    'demo-git': [
      { query: Q.worktree, should_trigger: true, role_phrase: true, context_role: 'coordinator' },
      { query: Q.natural, should_trigger: true, held_out: true },
      { query: Q.model, should_trigger: false },
    ],
  };
  const plan = {
    [Q.place]: { invoke: ['demo-router'], ifMissing: 'The placement role is missing: no skill with that role is installed, so I stop here.' },
    [Q.model]: { invoke: ['demo-router'] },
    [Q.worktree]: { invoke: ['demo-git'] },
    [Q.plain]: { text: 'Use reversed(xs) or xs[::-1].' },
    [Q.natural]: { invoke: ['demo-git'] },
  };

  test('positives, negatives and role-missing runs pass; exit 0 when every skill meets the thresholds', () => {
    const fx = setup({ cases, plan });
    const r = run(fx, ['--skill', 'demo-router', '--skill', 'demo-git', '--parallel', '3']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /exit 0: every skill meets the thresholds/);
    const results = r.results();
    assert.equal(results.verdict.ok, true);
    assert.deepEqual(results.selectedSkills, ['demo-router', 'demo-git']);
    const router = skillOf(results, 'demo-router');
    assert.deepEqual([router.positives.passed, router.positives.runs], [2, 2]);
    assert.deepEqual([router.negatives.passed, router.negatives.runs, router.negatives.fired], [2, 2, 0]);
    assert.deepEqual([router.roleMissing.passed, router.roleMissing.runs], [1, 1]);
    assert.deepEqual([router.rolePhrase.passed, router.rolePhrase.runs], [3, 3]);
    assert.deepEqual([router.heldOut.negatives.passed, router.heldOut.negatives.runs], [1, 1]);
    assert.equal(skillOf(results, 'demo-git').heldOut.positives.passed, 1);
    const links = Object.fromEntries(results.links.map((l) => [l.link, `${l.passed}/${l.runs}`]));
    assert.equal(links['demo-coordinator -> demo-router'], '1/1');
    assert.equal(links['demo-coordinator -> demo-router (placement removed)'], '1/1');
    assert.equal(links['demo-coordinator -> demo-router (must not fire)'], '1/1');
    assert.equal(links['demo-coordinator -> demo-git'], '1/1');
    const missing = results.cases.find((c) => c.remove_role);
    assert.equal(missing.runs[0].namedMissing, true);
    assert.deepEqual(missing.runs[0].invoked, [], 'with the role missing, nothing is invoked');
    assert.equal(missing.runs[0].passed, true);
    const md = r.md();
    assert.match(md, /Verdict: every skill meets the thresholds\./);
    assert.match(md, /\| demo-router \| 2\/2 \(100%\) \| 0 \| 0\/2 \| 1\/1 \| 3\/3 \(100%\) \|/);
    assert.match(md, /## Failing cases\n\nNone\./);
    assert.match(md, /## Role-missing runs\n\nEvery run of a case whose role was not installed: what it invoked and how it answered\.\n\n- demo-router case 5 \(placement removed, context demo-coordinator\), run 1: passed; invoked no skill; answer: "The placement role is missing/);
    assert.deepEqual(fs.readdirSync(path.join(fx.harness, 'claude-config-evals', 'projects')), [], 'the empty projects/<cwd> folders are removed');
    assert.match(md, /model claude-sonnet-5-5, effort low, provider claude-second, 1 run per case, split all/);
    assert.match(md, /Claude Code 9\.9\.9-fake/);
    assert.equal(md.includes(EM_DASH), false);
    const streams = r.streamsDir();
    assert.ok(streams && streams.startsWith(path.resolve(TMP_BASE)), `streams under JH_TEST_TMPDIR: ${streams}`);
    assert.equal(fs.readdirSync(streams).length, 8);
    assert.equal(fs.readdirSync(path.dirname(streams)).filter((n) => n.startsWith('project-')).length, 0, 'case projects are removed');
  });

  test('every run gets the command line, environment and install the brief names', () => {
    const fx = setup({ cases, plan });
    const r = run(fx, ['--skill', 'demo-router', '--skill', 'demo-git', '--model', 'claude-haiku-5-5', '--effort', 'medium', '--parallel', '2']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const log = r.log();
    assert.equal(log.length, 8);
    const configDir = path.join(fx.harness, 'claude-config-evals');
    assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
    for (const call of log) {
      const { argv } = call;
      assert.equal(argv[0], '-p');
      assert.equal(flagValue(argv, '--model'), 'claude-haiku-5-5');
      assert.equal(flagValue(argv, '--effort'), 'medium');
      assert.equal(flagValue(argv, '--tools'), 'Skill,Read,Glob,Grep');
      assert.equal(flagValue(argv, '--permission-mode'), 'dontAsk');
      assert.equal(flagValue(argv, '--max-turns'), '3');
      assert.equal(flagValue(argv, '--output-format'), 'stream-json');
      assert.ok(argv.includes('--verbose'));
      const settings = JSON.parse(flagValue(argv, '--settings'));
      // No instruction file from a folder above the session's project reaches it (H-001, generalized in H-034).
      const above = path.dirname(call.cwd);
      assert.ok(settings.claudeMdExcludes.includes(path.join(above, '.claude', '**')), 'the folder above the project is excluded');
      assert.ok(settings.claudeMdExcludes.includes(path.join(above, 'CLAUDE.md')));
      assert.equal(settings.claudeMdExcludes.some((p) => p.startsWith(`${call.cwd}/`)), false, 'nothing inside the project is excluded');
      assert.equal(argv[argv.length - 2], '--', 'the query follows "--"');
      assert.equal(argv[argv.length - 1], call.query);
      assert.equal(argv.indexOf('--'), argv.length - 2);
      assert.equal(call.token, FAKE_TOKEN, 'the provider token reaches the child through its environment');
      assert.equal(argv.some((a) => a.includes(FAKE_TOKEN)), false, 'never on the command line');
      assert.equal(call.configDir, configDir);
      assert.equal(call.mcp, 'false');
      for (const key of ['JH_HARNESS_HOME', 'JH_CLAUDE_BIN', 'JH_TEST_TMPDIR', 'JH_TASK']) assert.equal(call.envKeys.includes(key), false, key);
      assert.equal(call.gitDir, true, 'a git project');
      assert.equal(call.evalsCopied, false, 'evals/ folders are not copied');
      assert.ok(fs.realpathSync(path.dirname(path.dirname(call.cwd))).startsWith(fs.realpathSync(TMP_BASE)));
    }
    const removed = log.find((c) => c.query === cases['demo-router'][0].query && !c.installed.includes('demo-router'));
    assert.ok(removed, 'the remove_role run has no placement skill installed');
    assert.deepEqual(removed.installed, ['demo-coordinator', 'demo-duty-plan', 'demo-git']);
    const full = log.filter((c) => c !== removed);
    for (const call of full) assert.deepEqual(call.installed, Object.keys(SKILLS).sort());
    for (const call of log) {
      const withContext = [cases['demo-router'][0].query, cases['demo-router'][2].query].includes(call.query);
      if (withContext) {
        assert.ok(call.append.startsWith('The skill demo-coordinator is loaded; follow its instructions:\n\n'), call.append);
        assert.match(call.append, /C0RD-MARKER/);
        assert.match(call.append, /If no skill in your list has that role/);
        assert.doesNotMatch(call.append, /jh-role:/, 'the body without its frontmatter');
      } else {
        assert.equal(call.append, null, `no system prompt append for "${call.query}"`);
      }
    }
  });

  test('a positive that does not fire and a negative that fires: exit 1, with the failing cases and the skills they invoked', () => {
    const fx = setup({
      cases: {
        'demo-router': [
          { query: 'P1 which model for step 1', should_trigger: true },
          { query: 'P2 place step 2', should_trigger: true },
          { query: 'N1 explain merge sort', should_trigger: false },
        ],
      },
      plan: { 'P1 which model for step 1': { invoke: ['demo-router'] }, 'P2 place step 2': { invoke: ['demo-git'] }, 'N1 explain merge sort': { invoke: ['demo-router'] } },
    });
    const r = run(fx, ['--skill', 'demo-router']);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stdout, /exit 1: 1 skill below the thresholds: demo-router/);
    const results = r.results();
    assert.deepEqual(results.verdict.failingSkills, ['demo-router']);
    const router = skillOf(results, 'demo-router');
    assert.deepEqual(router.verdict.reasons, ['positives 1/2 below 90%', 'negatives failed 1/1 above 5%']);
    const md = r.md();
    assert.match(md, /Verdict: 1 of 1 skills below the thresholds: demo-router\./);
    assert.match(md, /### demo-router case 2 \(positive\)\n\n> P2 place step 2\n\n- Run 1: failed; invoked demo-git/);
    assert.match(md, /### demo-router case 3 \(negative\)\n\n> N1 explain merge sort\n\n- Run 1: failed; invoked demo-router/);
    assert.doesNotMatch(md, /### demo-router case 1 /);
  });

  test('a role-missing run fails when the answer does not name the missing role', () => {
    const q = 'Step 1 of T2BBBB is next. Use the placement skill now and continue with its answer.';
    const fx = setup({
      cases: {
        'demo-router': [
          { query: 'P1 which model', should_trigger: true },
          { query: q, should_trigger: false, role_phrase: true, context_role: 'coordinator', remove_role: 'placement', expect_role_missing: 'placement' },
        ],
      },
      plan: { 'P1 which model': { invoke: ['demo-router'] }, [q]: { invoke: ['demo-router'], ifMissing: 'I cannot continue with this step.' } },
    });
    const r = run(fx, ['--skill', 'demo-router']);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const router = skillOf(r.results(), 'demo-router');
    assert.deepEqual([router.roleMissing.passed, router.roleMissing.runs], [0, 1]);
    assert.deepEqual(router.verdict.reasons, ['role-phrase runs 0/1 below 98%']);
    assert.match(r.md(), /- Run 1: failed; invoked no skill; named the missing role: no; answer: "I cannot continue with this step\."/);
  });

  test('a removed role is removed for every skill holding it, and a context skill keeps its body in the prompt', () => {
    const q = 'Use the duty skill for plan now.';
    const fx = setup({
      cases: {
        'demo-duty-plan': [
          { query: 'Your step is duty plan. Use the duty skill for plan now and follow it.', should_trigger: true, role_phrase: true },
          { query: q, should_trigger: false, role_phrase: true, context_role: 'placement', remove_role: 'duty', expect_role_missing: 'duty' },
        ],
      },
      plan: {
        'Your step is duty plan. Use the duty skill for plan now and follow it.': { invoke: ['demo-duty-plan'] },
        [q]: { invoke: ['demo-duty-plan'], ifMissing: 'No skill with the duty role is installed, so I stop and leave the step to the owner.' },
      },
    });
    const r = run(fx, ['--skill', 'demo-duty-plan']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const removed = r.log().find((c) => c.query === q);
    assert.deepEqual(removed.installed, ['demo-coordinator', 'demo-git', 'demo-router']);
    assert.ok(removed.append.startsWith('The skill demo-router is loaded; follow its instructions:'));
    assert.match(removed.append, /Placement body\./);
    const links = r.results().links.map((l) => l.link);
    assert.ok(links.includes('runtime duty line -> demo-duty-plan'), links.join(', '));
    assert.ok(links.includes('demo-router -> demo-duty-plan (duty removed)'), links.join(', '));
  });
});

describe('errors', () => {
  test('a crashed run is retried once, and an error never counts as a pass', () => {
    const fx = setup({
      cases: {
        'demo-router': [
          { query: 'C1 place it', should_trigger: true },
          { query: 'C2 unrelated', should_trigger: false },
        ],
      },
      plan: { 'C1 place it': { invoke: ['demo-router'], crash: 'once' }, 'C2 unrelated': { crash: 'always' } },
    });
    const r = run(fx, ['--skill', 'demo-router']);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const results = r.results();
    const [c1, c2] = results.cases;
    assert.equal(c1.runs[0].passed, true);
    assert.equal(c1.runs[0].attempts, 2);
    assert.equal(c2.runs[0].passed, false, 'a crash on a negative is not a pass');
    assert.equal(c2.runs[0].attempts, 2);
    assert.match(c2.runs[0].error, /no result event \(exit 3\): fake claude crashed/);
    assert.equal(skillOf(results, 'demo-router').errors, 1);
    assert.match(r.md(), /- Run 1: failed; invoked no skill; error: no result event \(exit 3\): fake claude crashed/);
    assert.equal(r.log().filter((c) => c.query === 'C2 unrelated').length, 2);
  });

  test('exit 2 when no run completes: crashes, timeouts, skills that did not load', () => {
    const fx = setup({
      cases: { 'demo-router': [{ query: 'X1 place', should_trigger: true }, { query: 'X2 other', should_trigger: false }] },
      plan: { 'X1 place': { crash: 'always' }, 'X2 other': { unloaded: true } },
    });
    const r = run(fx, ['--skill', 'demo-router']);
    assert.equal(r.status, 2, r.stderr + r.stdout);
    assert.match(r.stderr, /no run completed/);
    const [x1, x2] = r.results().cases;
    assert.match(x1.runs[0].error, /no result event/);
    assert.match(x2.runs[0].error, /installed skills not loaded: demo-coordinator, demo-duty-plan, demo-git, demo-router/);

    const slow = setup({ cases: { 'demo-router': [{ query: 'S1 slow', should_trigger: true }] }, plan: { 'S1 slow': { sleepMs: 5000, invoke: ['demo-router'] } } });
    const started = Date.now();
    const t = run(slow, ['--skill', 'demo-router', '--timeout', '1']);
    assert.equal(t.status, 2, t.stderr + t.stdout);
    assert.ok(Date.now() - started < 9000, 'the run is killed at its timeout');
    assert.match(t.results().cases[0].runs[0].error, /timed out after 1 s/);
  });

  test('exit 2, before any run, when the evals cannot run', () => {
    const ok = { 'demo-router': [{ query: 'Q1', should_trigger: true }] };
    const expect2 = (fx, args, env, pattern) => {
      const r = run(fx, args, env);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
      assert.match(r.stderr, pattern);
      assert.equal(r.log().length, 0, 'claude never ran');
    };
    expect2(setup({ cases: ok, providers: null }), ['--skill', 'demo-router'], {}, /provider claude-second: cannot read .*providers\.json/);
    expect2(setup({ cases: ok }), ['--skill', 'demo-router', '--provider', 'nope'], {}, /provider nope: no provider "nope"/);
    expect2(setup({ cases: ok }), ['--skill', 'demo-router', '--provider', 'codex'], {}, /run-trigger-evals: provider codex is codex-subscription, not a Claude provider/);
    expect2(setup({ cases: ok, token: false }), ['--skill', 'demo-router'], {}, /run-trigger-evals: provider claude-second: token file .* is missing or empty/);
    expect2(setup({ cases: ok }), ['--skill', 'demo-router'], { JH_CLAUDE_BIN: path.join(TMP_BASE, 'no-such-claude') }, /no claude binary/);
    expect2(setup({ cases: ok }), ['--skill', 'demo-nothing'], {}, /skills\/demo-nothing: no such skill/);
    expect2(setup({ cases: ok }), ['--split', 'some'], {}, /--split must be one of all, tuning, held-out/);
    expect2(setup({ cases: ok }), ['--bogus'], {}, /unknown argument "--bogus"\nusage:/);
    expect2(setup({ cases: ok }), ['--skill', 'demo-router', '--split', 'held-out'], {}, /no case to run \(split held-out\)/);
    const bad = setup({
      cases: {
        'demo-router': [
          { query: 'B1', should_trigger: true, shuold: 1 },
          { query: 'B2', should_trigger: true, remove_role: 'placement', expect_role_missing: 'placement', role_phrase: true },
          { query: 'B3', should_trigger: false, context_skill: 'demo-missing' },
          { query: 'B4', should_trigger: false, remove_role: 'git', expect_role_missing: 'git', role_phrase: true },
          { query: `B5 ${EM_DASH} dash`, should_trigger: false },
          { query: '', should_trigger: 'yes' },
          { query: 'B7', should_trigger: true, context_skill: 'demo-coordinator' },
          { query: 'B8', should_trigger: true, context_role: 'duty' },
          { query: 'B9', should_trigger: true, context_role: 'router' },
          { query: 'B10', should_trigger: true, context_role: 'git', context_for: 'main' },
          { query: 'B11', should_trigger: true, context_for: 'plan' },
          { query: 'B12', should_trigger: true, context_role: 'duty', context_for: 'answer' },
          { query: 'B13', should_trigger: true, context_role: 'coordinator', context_skill: 'demo-router' },
          { query: 'B14', should_trigger: false, role_phrase: true, context_role: 'placement', remove_role: 'placement', expect_role_missing: 'placement' },
        ],
      },
      extra: {
        'demo-duty-verify': { role: 'duty', extra: 'jh-duty: verify\njh-needs: [shell]\n', description: 'Duty verify. Use when the step duty is verify.', body: 'Verify body.' },
      },
    });
    const r = run(bad, ['--skill', 'demo-router']);
    assert.equal(r.status, 2);
    for (const pattern of [
      /case 1: unknown field "shuold"/,
      /case 2: a remove_role case needs should_trigger false/,
      /case 3: context_skill "demo-missing" is not a skill/,
      /case 4: remove_role git is not the role of demo-router/,
      /case 5: query holds an em dash/,
      /case 6: query must be a non-empty string/,
      /case 6: should_trigger must be true or false/,
      /case 7: context_skill names another skill, demo-coordinator; name the calling skill by its role with context_role/,
      /case 8: context_role duty: 2 skills hold it \(demo-duty-plan, demo-duty-verify\); add context_for \(their jh-duty\)/,
      /case 9: context_role "router" is not one of coordinator, placement/,
      /case 10: context_for applies only to the roles runtime, duty, workflow, not git/,
      /case 11: context_for needs context_role/,
      /case 12: context_role duty for answer: no skill under skills\/ has it/,
      /case 13: give context_role, not context_skill as well/,
      /case 14: the calling skill demo-router has the removed role placement/,
    ]) assert.match(r.stderr, pattern);
    const noFile = setup({ cases: ok });
    fs.renameSync(path.join(noFile.root, 'skills', 'demo-git', 'evals', 'trigger-cases.json'), path.join(noFile.root, 'skills', 'demo-git', 'evals', 'trigger-cases.json.moved'));
    expect2(noFile, [], {}, /skills\/demo-git\/evals\/trigger-cases\.json: missing/);
  });
});

describe('secrets', () => {
  test('the token never reaches the output, and neither does its variable name followed by an equals sign', () => {
    const fx = setup({ cases: { 'demo-router': [{ query: 'L1 place it', should_trigger: true }] }, plan: { 'L1 place it': { invoke: ['demo-router'], leak: true } } });
    const r = run(fx, ['--skill', 'demo-router']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.log()[0].token, FAKE_TOKEN);
    const texts = { stdout: r.stdout, stderr: r.stderr, md: r.md(), json: JSON.stringify(r.results()) };
    for (const name of fs.readdirSync(r.streamsDir())) texts[name] = fs.readFileSync(path.join(r.streamsDir(), name), 'utf8');
    for (const [where, text] of Object.entries(texts)) {
      assert.equal(text.includes(FAKE_TOKEN), false, `token in ${where}`);
      assert.equal(text.includes(NAME_EQ), false, `variable assignment in ${where}`);
    }
    assert.match(r.results().cases[0].runs[0].finalText, /\[redacted\]/);
    for (const file of [SCRIPT, new URL(import.meta.url).pathname]) {
      assert.equal(fs.readFileSync(file, 'utf8').includes(NAME_EQ), false, `${file} spells the assignment`);
    }
  });
});

describe('selection and thresholds', () => {
  const mk = (skill, should, extra = {}) => ({ skill, index: 0, query: 'q', should_trigger: should, held_out: false, role_phrase: false, context_role: null, context_for: null, context_skill: null, remove_role: null, expect_role_missing: null, ...extra });

  test('--split and --limit choose cases per skill, alternating positives and negatives in file order', () => {
    const list = [
      ...['p1', 'p2', 'p3', 'p4'].map((q, i) => mk('a', true, { query: q, held_out: i === 3 })),
      ...['n1', 'n2', 'n3'].map((q, i) => mk('a', false, { query: q, held_out: i === 2 })),
      ...['bp1', 'bn1'].map((q) => mk('b', q.startsWith('bp'), { query: q })),
    ];
    assert.deepEqual(selectCases(list, { limit: 3 }).map((c) => c.query), ['p1', 'n1', 'p2', 'bp1', 'bn1']);
    assert.deepEqual(selectCases(list, { split: 'held-out' }).map((c) => c.query), ['p4', 'n3']);
    assert.deepEqual(selectCases(list, { split: 'tuning', limit: 4 }).map((c) => c.query), ['p1', 'n1', 'p2', 'n2', 'bp1', 'bn1']);
    assert.equal(selectCases(list).length, list.length);

    const fx = setup({ cases: { 'demo-router': list.filter((c) => c.skill === 'a').map((c) => ({ query: c.query, should_trigger: c.should_trigger, ...(c.held_out ? { held_out: true } : {}) })) } });
    const r = run(fx, ['--skill', 'demo-router', '--limit', '3', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^demo-router: 3 cases, 2 positive, 1 negative, 0 role-missing, 0 role-phrase, 0 held out$/m);
    assert.equal(r.log().length, 0, 'a dry run starts no claude');
  });

  const results = (skill, kind, passed, total, extra = {}) => ({
    case: mk(skill, kind === 'positive', extra),
    runs: Array.from({ length: total }, (_, i) => ({ passed: i < passed, fired: kind === 'positive' ? i < passed : i >= passed, error: null, costUsd: 0 })),
  });
  const verdict = (...caseResults) => summarize(caseResults, ['s']).skills[0].verdict;

  test('positives: 90 percent meets, below it does not', () => {
    assert.equal(THRESHOLDS.positive, 0.9);
    assert.deepEqual(verdict(results('s', 'positive', 9, 10)), { ok: true, reasons: [] });
    assert.deepEqual(verdict(results('s', 'positive', 8, 10)), { ok: false, reasons: ['positives 8/10 below 90%'] });
  });

  test('negatives: 5 percent failing meets, more does not', () => {
    assert.equal(verdict(results('s', 'negative', 19, 20)).ok, true);
    assert.deepEqual(verdict(results('s', 'negative', 18, 20)).reasons, ['negatives failed 2/20 above 5%']);
  });

  test('role-phrase runs: 98 percent meets, below it does not, whether positive or role-missing', () => {
    assert.equal(verdict(results('s', 'positive', 49, 50, { role_phrase: true })).ok, true);
    assert.deepEqual(verdict(results('s', 'positive', 48, 50, { role_phrase: true })).reasons, ['role-phrase runs 48/50 below 98%']);
    const missing = results('s', 'negative', 1, 2, { role_phrase: true, remove_role: 'git', expect_role_missing: 'git' });
    assert.deepEqual(verdict(results('s', 'positive', 10, 10), missing).reasons, ['role-phrase runs 1/2 below 98%']);
    assert.equal(verdict(results('s', 'negative', 20, 20)).ok, true, 'a skill with no positives is judged on what ran');
  });

  test('the answer names the missing role', () => {
    for (const text of [
      'The placement role is missing, so I stop here.',
      'No placement skill is installed in this project.',
      "The **placement** skill isn't installed.",
      'I cannot continue: there is no skill with the placement role.',
      'Placement is not available here.\nStopping.',
    ]) assert.equal(namesMissingRole(text, 'placement'), true, text);
    for (const text of [
      'I cannot continue with this step.',
      'Placement chose claude-second. The ledger is missing a line.',
      '',
    ]) assert.equal(namesMissingRole(text, 'placement'), false, text);
    assert.equal(namesMissingRole('The git skill is not installed.', 'git'), true);
    assert.equal(namesMissingRole('The digital skill is not installed.', 'git'), false);
  });

  test('the stream gives the invoked skills in order and the final text', () => {
    const lines = [
      { type: 'system', subtype: 'init', skills: ['a', 'b'], claude_code_version: '2.1.316' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Loading.' }, { type: 'tool_use', name: 'Skill', input: { skill: 'plugin:a' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }, { type: 'tool_use', name: 'Skill', input: { skill: 'b' } }] } },
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: '', total_cost_usd: 0.02, num_turns: 2 },
    ].map((e) => JSON.stringify(e)).join('\n');
    const parsed = parseStream(`not json\n${lines}\n`);
    assert.deepEqual(parsed.skills, ['a', 'b']);
    assert.equal(parsed.finalText, 'Loading.');
    assert.deepEqual(parsed.init, { skills: ['a', 'b'], version: '2.1.316' });
    assert.equal(parsed.result.subtype, 'error_max_turns');
  });
});

describe('the calling skill, named by its role', () => {
  const skill = (folder, role, data = {}) => ({ folder, data: { 'jh-role': role, ...data } });
  const skills = [
    skill('a-coordinator', 'coordinator'),
    skill('a-runtime-one', 'runtime', { 'jh-kinds': ['one-subscription', 'one-endpoint'] }),
    skill('a-runtime-two', 'runtime', { 'jh-kinds': ['two-subscription'] }),
    skill('a-workflow-bug', 'workflow', { 'jh-kind': 'bug' }),
    skill('a-workflow-feature', 'workflow', { 'jh-kind': 'feature' }),
    skill('a-duty-plan', 'duty', { 'jh-duty': 'plan' }),
  ];

  test('a role held by one skill resolves alone; context_for narrows a runtime, a workflow or a duty', () => {
    assert.deepEqual(contextSkill(skills, 'coordinator'), { skill: 'a-coordinator' });
    assert.deepEqual(contextSkill(skills, 'duty'), { skill: 'a-duty-plan' });
    assert.deepEqual(contextSkill(skills, 'runtime', 'one-endpoint'), { skill: 'a-runtime-one' });
    assert.deepEqual(contextSkill(skills, 'runtime', 'two-subscription'), { skill: 'a-runtime-two' });
    assert.deepEqual(contextSkill(skills, 'workflow', 'feature'), { skill: 'a-workflow-feature' });
    assert.deepEqual(contextSkill(skills, 'duty', 'plan'), { skill: 'a-duty-plan' });
  });

  test('an ambiguous, unknown, missing or wrongly narrowed role is a problem', () => {
    assert.match(contextSkill(skills, 'workflow').problem, /2 skills hold it \(a-workflow-bug, a-workflow-feature\); add context_for \(their jh-kind\)/);
    assert.match(contextSkill(skills, 'runtime').problem, /add context_for \(their jh-kinds\)/);
    assert.match(contextSkill(skills, 'placement').problem, /context_role placement: no skill under skills\/ has it/);
    assert.match(contextSkill(skills, 'router').problem, /is not one of/);
    assert.match(contextSkill(skills, 'workflow', 'automation').problem, /context_role workflow for automation: no skill/);
    assert.match(contextSkill(skills, 'coordinator', 'x').problem, /context_for applies only to the roles runtime, duty, workflow, not coordinator/);
  });

  test('a run gets the resolved skill\'s body, and the results keep its name as context_skill', () => {
    const q = 'Q-ROLE Task T1AAAA is created. Use the placement skill now and continue with its answer.';
    const fx = setup({
      cases: { 'demo-router': [{ query: q, should_trigger: true, role_phrase: true, context_role: 'coordinator' }] },
      plan: { [q]: { invoke: ['demo-router'] } },
    });
    const r = run(fx, ['--skill', 'demo-router']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const [call] = r.log();
    assert.ok(call.append.startsWith('The skill demo-coordinator is loaded; follow its instructions:\n\n'), call.append);
    assert.match(call.append, /C0RD-MARKER/);
    const [c] = r.results().cases;
    assert.equal(c.context_role, 'coordinator');
    assert.equal(c.context_for, null);
    assert.equal(c.context_skill, 'demo-coordinator', 'results files keep the resolved name');
    assert.ok(r.results().links.some((l) => l.link === 'demo-coordinator -> demo-router'));
  });

  test('a case file may still name its own skill with context_skill', () => {
    const q = 'Q-OWN place step 1';
    const fx = setup({ cases: { 'demo-router': [{ query: q, should_trigger: true, context_skill: 'demo-router' }] }, plan: { [q]: { invoke: ['demo-router'] } } });
    const r = run(fx, ['--skill', 'demo-router']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(r.log()[0].append.startsWith('The skill demo-router is loaded'));
    assert.equal(r.results().cases[0].context_role, 'placement');
  });
});

describe('the shipped case files', () => {
  test('no case file names another skill: the calling skill is a role', () => {
    const { skills } = readSkills(REPO);
    for (const skill of skills) {
      const file = path.join(REPO, 'skills', skill.folder, 'evals', 'trigger-cases.json');
      for (const [i, c] of JSON.parse(fs.readFileSync(file, 'utf8')).entries()) {
        assert.equal(c.context_skill, undefined, `${skill.folder} case ${i + 1} still has context_skill`);
        for (const other of skills) {
          if (other.folder !== skill.folder) assert.equal(JSON.stringify(c).includes(other.folder), false, `${skill.folder} case ${i + 1} names ${other.folder}`);
        }
      }
    }
  });

  test('every skill has a valid case file with at least 6 positives, 6 negatives and about one in five held out', () => {
    const { skills } = readSkills(REPO);
    assert.equal(skills.length, 17);
    const { cases, problems } = loadCases(REPO, skills, skills.map((s) => s.folder));
    assert.deepEqual(problems, []);
    for (const skill of skills) {
      const mine = cases.filter((c) => c.skill === skill.folder);
      const positives = mine.filter((c) => c.should_trigger).length;
      const negatives = mine.filter((c) => !c.should_trigger).length;
      const heldOut = mine.filter((c) => c.held_out).length / mine.length;
      assert.ok(positives >= 6, `${skill.folder}: ${positives} positives`);
      assert.ok(negatives >= 6, `${skill.folder}: ${negatives} negatives`);
      assert.ok(heldOut >= 0.12 && heldOut <= 0.3, `${skill.folder}: ${Math.round(heldOut * 100)}% held out`);
      assert.equal(new Set(mine.map((c) => `${c.query}|${c.remove_role}`)).size, mine.length, `${skill.folder}: a case is repeated`);
      for (const c of mine) {
        if (c.remove_role) {
          assert.ok(mine.some((p) => p.should_trigger && p.query === c.query && p.context_role === c.context_role && p.context_for === c.context_for && p.context_skill === c.context_skill), `${skill.folder} case ${c.index}: a role-missing case repeats a positive of the same file`);
        }
      }
    }
  });
});

test('namesMissingRole recognises the ways a session says a role is missing', async () => {
  const { namesMissingRole } = await import('../scripts/run-trigger-evals.mjs');
  assert.equal(namesMissingRole('I can\'t make the worktree because no installed skill has the git role.', 'git'), true);
  assert.equal(namesMissingRole('None of the installed skills has the runtime role, so I stop here.', 'runtime'), true);
  assert.equal(namesMissingRole('The placement skill isn\'t installed in this session.', 'placement'), true);
  assert.equal(namesMissingRole('I made the worktree with the git skill.', 'git'), false);
});
