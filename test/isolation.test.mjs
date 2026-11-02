// Every skill alone: each folder under skills/ is copied, without its siblings, into a temporary git project's
// .claude/skills/ (the way install.mjs lays a project out), and every script at the top of its scripts/ folder is run
// there twice: with --help (exit 0 and some usage text) and with a command that needs another role (exit 2, the
// role-missing sentence on stderr, {"error", "exitCode": 2} on stdout with --json, and no crash: never exit 1, never a
// stack trace). The ledger needs no other role, so its commands simply work alone; the Jev client needs no role either,
// and refuses a decision without a key as a Jev error. A skill without scripts has none.
//
// The table below names the role-dependent command of every public script. A script missing from it fails the suite:
// add its command here, or move a script only its own skill runs into scripts/lib/.
//
// Nothing here reaches the network or the owner's files: HOME and the harness home are private temporary folders,
// providers.json names key and token files that do not exist, and the Jev and Anthropic URLs point at a closed
// loopback port.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(REPO, 'skills');
const NODE = process.execPath;
const BASE = process.env.JH_TEST_TMPDIR || os.tmpdir();
fs.mkdirSync(BASE, { recursive: true });
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(BASE, 'jh-isolation-')));

const TASK = 'T000000';
const MISSING_ADVICE = 'tell the owner which role is missing and do not improvise it';
const STACK_FRAME = /\n\s+at \S.*:\d+:\d+\)?\s*(\n|$)/;
const CLOSED_PORT = 'http://127.0.0.1:9';

// The role-dependent command of each public script, by the role of its skill. `roles`: the roles whose absence may be
// the one reported (a script may look up any of them first). `cwdArg` adds --cwd <project>.
const TABLE = {
  git: {
    'worktree.mjs': { args: ['create', '--task', TASK, '--json'], roles: ['ledger'] },
    'land.mjs': { args: ['--task', TASK, '--json'], roles: ['ledger'] },
  },
  placement: {
    'route.mjs': { args: ['--task', TASK, '--step', '1', '--duty', 'investigate', '--json'], roles: ['ledger', 'duty', 'runtime'] },
    'providers.mjs': { args: ['check', '--json'], roles: ['runtime'] },
    'jev.mjs': { jev: true, args: ['decide', '--json'] },
  },
  runtime: {
    'start.mjs': { args: ['--task', TASK, '--step', '1', '--duty', 'investigate', '--provider', '<provider>', '--model', '<model>', '--effort', 'low', '--json'], cwdArg: true, roles: ['ledger', 'duty'] },
    'resume.mjs': { args: ['--task', TASK, '--step', '1', '--message', 'Carry on.', '--json'], roles: ['ledger'] },
    'stop.mjs': { args: ['--task', TASK, '--step', '1', '--json'], roles: ['ledger'] },
    'status.mjs': { args: ['--task', TASK, '--step', '1', '--json'], roles: ['ledger'] },
  },
  ledger: {
    'ledger.mjs': { alone: true, args: ['status', '--json'] },
  },
};

// The provider a runtime's start command names: one of its own kinds.
const PROVIDER_FOR_KIND = {
  'claude-subscription': { name: 'claude-main', model: 'claude-sonnet-5-5' },
  'claude-endpoint': { name: 'glm', model: 'glm-5.3' },
  'codex-subscription': { name: 'codex', model: 'gpt-6-astra' },
};

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  for (const line of match ? match[1].split(/\r?\n/) : []) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim();
    out[kv[1]] = /^\[.*\]$/.test(value) ? value.slice(1, -1).split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : value.replace(/^["']|["']$/g, '');
  }
  return out;
}

const skills = fs.readdirSync(SKILLS).filter((name) => fs.existsSync(path.join(SKILLS, name, 'SKILL.md'))).sort();
const topScripts = (dir) => {
  try {
    return fs.readdirSync(path.join(dir, 'scripts'), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.mjs')).map((e) => e.name).sort();
  } catch {
    return [];
  }
};

let counter = 0;
// A git project holding only `skill` in .claude/skills/, with .jevellan/ as install.mjs leaves it, plus a private home
// and harness home.
function isolate(skill) {
  counter += 1;
  const root = path.join(TMP, `${String(counter).padStart(2, '0')}-${skill}`);
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  const harness = path.join(root, 'harness');
  for (const dir of [project, home, harness]) fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'README.md'), '# isolation fixture\n');
  git('add', 'README.md');
  git('commit', '-q', '--no-verify', '-m', 'init');
  fs.mkdirSync(path.join(project, '.jevellan'), { recursive: true });
  const installed = path.join(project, '.claude', 'skills', skill);
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.cpSync(path.join(SKILLS, skill), installed, { recursive: true, verbatimSymlinks: true });
  // Absolute paths to files that do not exist: no key or token is ever read, and "~" (the owner's real home) is never
  // expanded.
  const secrets = path.join(harness, 'secrets');
  fs.writeFileSync(path.join(harness, 'providers.json'), `${JSON.stringify({
    jev: { keyFile: path.join(secrets, 'jev.key'), model: 'jev-latest', timeoutMs: 2000 },
    providers: [
      { name: 'claude-main', kind: 'claude-subscription', tokenFile: path.join(secrets, 'claude-main.token'), ceilingPct: 90, models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet', efforts: ['low', 'medium', 'high'] }] },
      { name: 'glm', kind: 'claude-endpoint', baseUrl: CLOSED_PORT, keyFile: path.join(secrets, 'glm.key'), models: [{ id: 'glm-5.3', label: 'GLM', efforts: ['low', 'medium', 'high'] }] },
      { name: 'codex', kind: 'codex-subscription', codexHome: path.join(home, '.codex'), ceilingPct: 90, models: [{ id: 'gpt-6-astra', label: 'GPT', efforts: ['low', 'medium', 'high'] }] },
    ],
  }, null, 2)}\n`);
  const env = {
    PATH: [path.dirname(NODE), process.env.PATH ?? '/usr/bin:/bin'].join(path.delimiter),
    HOME: home,
    USER: process.env.USER ?? 'test',
    LANG: 'C.UTF-8',
    TMPDIR: root,
    JH_HARNESS_HOME: harness,
    JH_TEST_TMPDIR: root,
    JH_JEV_URL: CLOSED_PORT,
    JH_ANTHROPIC_URL: CLOSED_PORT,
  };
  return { project, installed, env };
}

function runScript(fx, script, args, input) {
  const r = spawnSync(NODE, [path.join(fx.installed, 'scripts', script), ...args], {
    cwd: fx.project,
    env: fx.env,
    encoding: 'utf8',
    input: input === undefined ? '' : JSON.stringify(input),
    timeout: 60000,
  });
  return { code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

const show = (r) => `exit ${r.code}${r.signal ? ` (${r.signal})` : ''}\n--- stdout\n${r.stdout.slice(0, 2000)}\n--- stderr\n${r.stderr.slice(0, 2000)}`;

function assertNoCrash(r, what) {
  assert.equal(r.error, undefined, `${what}: ${r.error?.message}`);
  assert.equal(r.signal, null, `${what}: killed\n${show(r)}`);
  assert.notEqual(r.code, 1, `${what}: exit 1 is a crash\n${show(r)}`);
  assert.doesNotMatch(r.stderr, STACK_FRAME, `${what}: a stack trace on stderr\n${show(r)}`);
  assert.doesNotMatch(r.stdout, STACK_FRAME, `${what}: a stack trace on stdout\n${show(r)}`);
}

function lastJson(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {}
  }
  return null;
}

for (const skill of skills) {
  const dir = path.join(SKILLS, skill);
  const meta = frontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  const role = meta['jh-role'];
  const scripts = topScripts(dir);

  describe(`${skill} alone (role ${role})`, () => {
    if (!TABLE[role]) {
      test('has no scripts', () => {
        assert.deepEqual(scripts, [], `${skill} has scripts at the top of scripts/ but its role ${role} has no row in the table of test/isolation.test.mjs`);
      });
      return;
    }

    test('every public script has a role-dependent command in the table', () => {
      const missing = scripts.filter((s) => !TABLE[role][s]);
      assert.deepEqual(missing, [], `no command in the table for ${missing.join(', ')}: add one, or move a script only ${skill} runs into scripts/lib/`);
    });

    for (const script of scripts) {
      const row = TABLE[role][script];

      test(`${script} --help prints its usage and exits 0`, () => {
        const fx = isolate(skill);
        const r = runScript(fx, script, ['--help']);
        assertNoCrash(r, `${script} --help`);
        assert.equal(r.code, 0, `${script} --help\n${show(r)}`);
        const text = `${r.stdout}${r.stderr}`;
        assert.ok(/usage/i.test(text) || text.includes(script), `${script} --help prints no usage text\n${show(r)}`);
      });

      if (!row) continue;

      if (row.alone) {
        test(`${script} ${row.args.join(' ')} works with no other skill installed`, () => {
          const fx = isolate(skill);
          const r = runScript(fx, script, row.args);
          assertNoCrash(r, script);
          assert.equal(r.code, 0, show(r));
          const json = lastJson(r.stdout);
          assert.ok(json && typeof json === 'object', `${script} ${row.args.join(' ')} printed no JSON\n${show(r)}`);
          assert.doesNotMatch(r.stderr, /no installed skill has the role/, show(r));
        });
        continue;
      }

      if (row.jev) {
        test(`${script} ${row.args.join(' ')} without a key is a Jev error with exit 2, not a crash`, () => {
          const fx = isolate(skill);
          const input = {
            state: JSON.stringify({ task: { title: 'Isolation check' } }),
            questions: { landing_route: { type: 'choice', instructions: 'Pick a route.', criteria: { land: 'Small and tested.', 'ask-owner': 'Anything else.' } } },
          };
          const r = runScript(fx, script, row.args, input);
          assertNoCrash(r, `${script} decide`);
          assert.equal(r.code, 2, show(r));
          const json = lastJson(r.stdout);
          assert.ok(json && typeof json.error === 'string', `no {"error"} on stdout\n${show(r)}`);
          assert.equal(json.exitCode, 2, show(r));
          assert.match(json.error, /^Jev: /, show(r));
          assert.ok(r.stderr.includes(json.error), `stderr carries the same message\n${show(r)}`);
        });
        continue;
      }

      const kinds = Array.isArray(meta['jh-kinds']) ? meta['jh-kinds'] : [];
      const provider = PROVIDER_FOR_KIND[kinds[0]];
      const args = row.args.map((a) => (a === '<provider>' ? provider?.name ?? 'claude-main' : a === '<model>' ? provider?.model ?? 'claude-sonnet-5-5' : a));

      test(`${script} ${row.args.join(' ')} refuses with exit 2 and the role-missing sentence (${row.roles.join(' or ')})`, () => {
        const fx = isolate(skill);
        const r = runScript(fx, script, row.cwdArg ? [...args, '--cwd', fx.project] : args);
        assertNoCrash(r, script);
        assert.equal(r.code, 2, `${script}\n${show(r)}`);
        const named = row.roles.find((name) => r.stderr.includes(`no installed skill has the role ${name}`));
        assert.ok(named, `stderr does not say "no installed skill has the role <${row.roles.join('|')}>"\n${show(r)}`);
        assert.ok(r.stderr.includes(MISSING_ADVICE), `stderr lacks "${MISSING_ADVICE}"\n${show(r)}`);
        const json = lastJson(r.stdout);
        assert.ok(json && typeof json.error === 'string' && json.exitCode === 2, `with --json, stdout is {"error", "exitCode": 2}\n${show(r)}`);
        assert.ok(json.error.includes(`no installed skill has the role ${named}`), show(r));
      });
    }
  });
}

test('the table names no script that no skill has', () => {
  const present = new Map();
  for (const skill of skills) {
    const role = frontmatter(fs.readFileSync(path.join(SKILLS, skill, 'SKILL.md'), 'utf8'))['jh-role'];
    for (const script of topScripts(path.join(SKILLS, skill))) present.set(`${role}/${script}`, true);
  }
  const stale = Object.entries(TABLE).flatMap(([role, rows]) => Object.keys(rows).map((s) => `${role}/${s}`)).filter((key) => !present.has(key));
  assert.deepEqual(stale, [], 'rows for scripts that no longer exist');
});
