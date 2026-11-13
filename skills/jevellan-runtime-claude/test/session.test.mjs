// Sessions of the owner's on a named provider (H-044), alone: the provider's env and projects list, the session plan
// (guards, arguments, environment), the first-run answers in the session's config folder, and session.mjs end to end
// with a fake `claude` (JH_CLAUDE_BIN). Nothing here reaches the network.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { HARNESS_HOME, NODE, SKILL_DIR, TOKEN, makeProject, tempDir, waitFor, writeProviders } from './helpers/fakes.mjs';
import { assertProjectAllowed, providerEnv, providerLogin } from '../scripts/lib/env.mjs';
import { readClaudeArgs, seedConfig, sessionPlan, shownPlan } from '../scripts/lib/session.mjs';
import { findProvider } from '../scripts/lib/common.mjs';

const KEY = 'fake-third-party-key-0123456789';
const SESSION = path.join(SKILL_DIR, 'scripts', 'session.mjs');
let project;
let wt;
let other;
let secrets;

function setProviders(extra) {
  const file = path.join(HARNESS_HOME, 'providers.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.providers = config.providers.filter((p) => !extra.some((e) => e.name === p.name)).concat(extra);
  fs.writeFileSync(file, JSON.stringify(config));
}

const third = (over = {}) => ({
  name: 'third-test',
  kind: 'claude-endpoint',
  baseUrl: 'http://127.0.0.1:9',
  keyFile: path.join(secrets, 'third.key'),
  placement: false,
  projects: [project],
  env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '65536', MAX_THINKING_TOKENS: '0' },
  models: [{ id: 'third-model', efforts: ['low', 'medium', 'high', 'max'] }],
  ...over,
});

before(() => {
  ({ secrets } = writeProviders());
  ({ project, wt } = makeProject());
  other = makeProject().project;
  fs.writeFileSync(path.join(secrets, 'third.key'), `${KEY}\n`, { mode: 0o600 });
  setProviders([third()]);
});

describe('a provider\'s env and projects list', () => {
  test('an endpoint without env keeps exactly the login it had', () => {
    const login = providerLogin(findProvider('endpoint-test'));
    assert.deepEqual(Object.keys(login).sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL']);
  });

  test('an endpoint\'s env is added to its login, for steps and sessions alike', () => {
    const login = providerLogin(findProvider('third-test'));
    assert.equal(login.ANTHROPIC_AUTH_TOKEN, KEY);
    assert.equal(login.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'third-model');
    assert.equal(login.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '65536');
    assert.equal(login.MAX_THINKING_TOKENS, '0');
  });

  test('env refuses the runtime\'s own variables, a secret\'s name, a non-text, a bad name and another kind', () => {
    const cases = [
      [{ ANTHROPIC_AUTH_TOKEN: 'x' }, /env may not set ANTHROPIC_AUTH_TOKEN; the runtime sets it/],
      [{ CLAUDE_CONFIG_DIR: '/x' }, /env may not set CLAUDE_CONFIG_DIR/],
      [{ JH_TASK: 'T' }, /env may not set JH_TASK/],
      [{ GITHUB_TOKEN: 'x' }, /env may not hold a secret \(GITHUB_TOKEN\)/],
      [{ AWS_SECRET_ACCESS_KEY: 'x' }, /env may not hold a secret/],
      [{ API_TIMEOUT_MS: 5 }, /env.API_TIMEOUT_MS must be a text/],
      [{ lower: 'x' }, /must be capitals, digits and underscores/],
    ];
    for (const [env, pattern] of cases) assert.throws(() => providerEnv(third({ env })), (e) => e.exitCode === 2 && pattern.test(e.message), String(pattern));
    assert.throws(() => providerEnv({ name: 's', kind: 'claude-subscription', env: { A: 'b' } }), /env is for claude-endpoint providers only/);
    assert.deepEqual(providerEnv(third({ env: undefined })), {});
  });

  test('projects: the listed repository and its worktrees and subfolders, by real path; never a parent, another repository or a folder outside git', () => {
    const real = fs.realpathSync(project);
    assert.equal(assertProjectAllowed(third(), project), real);
    assert.equal(assertProjectAllowed(third(), wt), real, 'a worktree counts as its repository');
    fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
    assert.equal(assertProjectAllowed(third(), path.join(project, 'sub')), real);
    const link = path.join(tempDir('jh-link-'), 'project');
    fs.symlinkSync(project, link);
    assert.equal(assertProjectAllowed(third({ projects: [link] }), project), real, 'a symlinked spelling of the listed folder');
    assert.throws(() => assertProjectAllowed(third(), other), /runs only in the projects its projects list in providers.json names, and .* is not one of them/);
    assert.throws(() => assertProjectAllowed(third({ projects: [path.dirname(project)] }), project), /is not one of them/, 'a parent folder allows nothing below it');
    assert.throws(() => assertProjectAllowed(third(), tempDir('jh-plain-')), /is not inside a git repository/);
    assert.throws(() => assertProjectAllowed(third({ projects: [] }), project), /projects must be a non-empty list/);
    assert.equal(assertProjectAllowed(findProvider('endpoint-test'), other), null, 'no list, no restriction');
  });
});

describe('the session plan', () => {
  test('an endpoint needs a projects list and a key file that is a regular file only its owner can read', () => {
    assert.throws(() => sessionPlan({ provider: 'endpoint-test', cwd: project }), (e) => e.exitCode === 2 && /has no projects list; name in providers.json \(projects\)/.test(e.message));
    const open = path.join(secrets, 'open.key');
    fs.writeFileSync(open, `${KEY}\n`, { mode: 0o644 });
    fs.chmodSync(open, 0o644);
    const linked = path.join(secrets, 'linked.key');
    fs.symlinkSync(path.join(secrets, 'third.key'), linked);
    setProviders([third({ name: 'open-key', keyFile: open }), third({ name: 'linked-key', keyFile: linked }), third({ name: 'no-key', keyFile: path.join(secrets, 'absent.key') })]);
    assert.throws(() => sessionPlan({ provider: 'open-key', cwd: project }), /must be readable by its owner only \(chmod 600\)/);
    assert.throws(() => sessionPlan({ provider: 'linked-key', cwd: project }), /must be a regular file/);
    assert.throws(() => sessionPlan({ provider: 'no-key', cwd: project }), /is missing; save the key there \(the key only\) with mode 600/);
    setProviders([third({ name: 'v1-path', baseUrl: 'https://gateway.invalid/v1' })]);
    assert.throws(() => sessionPlan({ provider: 'v1-path', cwd: project }), /baseUrl must be the origin without \/v1/);
  });

  test('refused outside the listed projects, through --add-dir too; refused for other kinds, a disabled provider; an unknown one is exit 3', () => {
    assert.throws(() => sessionPlan({ provider: 'third-test', cwd: other }), (e) => e.exitCode === 2 && /is not one of them/.test(e.message));
    assert.throws(() => sessionPlan({ provider: 'third-test', cwd: project, args: ['--add-dir', other] }), /is not one of them/);
    assert.throws(() => sessionPlan({ provider: 'third-test', cwd: project, args: ['--add-dir', wt, other] }), /is not one of them/, 'every folder after --add-dir');
    assert.ok(sessionPlan({ provider: 'third-test', cwd: project, args: ['--add-dir', wt] }));
    assert.throws(() => sessionPlan({ provider: 'codex-test', cwd: project }), /is codex-subscription, not a Claude provider/);
    assert.throws(() => sessionPlan({ provider: 'off-test', cwd: project }), /is disabled in providers.json/);
    assert.throws(() => sessionPlan({ provider: 'nobody', cwd: project }), (e) => e.exitCode === 3);
  });

  test('the arguments: the provider\'s model, no remote control, strict MCP, the plugin, the caller\'s settings merged with the workers\'', () => {
    const plan = sessionPlan({
      provider: 'third-test',
      cwd: wt,
      plugin: '/plugins/jh',
      args: ['--dangerously-skip-permissions', '--mcp-config', '/x.json', '--remote-control', 'ekoa-x', '--model', 'opus', '--effort', 'medium', '--settings', '{"advisorModel":"","permissions":{"deny":["Bash(rm:*)"]}}'],
    });
    const at = plan.args.indexOf('--settings');
    assert.deepEqual([...plan.args.slice(0, at), ...plan.args.slice(at + 2)], ['--model', 'third-model', '--strict-mcp-config', '--plugin-dir', '/plugins/jh', '--dangerously-skip-permissions', '--mcp-config', '/x.json', '--effort', 'medium']);
    const settings = JSON.parse(plan.args[at + 1]);
    assert.equal(settings.advisorModel, '', 'the caller\'s settings stay');
    assert.deepEqual(settings.attribution, { commit: '', pr: '', sessionUrl: false });
    assert.ok(settings.claudeMdExcludes.includes(path.join(path.dirname(wt), 'CLAUDE.md')), 'instructions above the session\'s folder stay out');
    assert.ok(settings.claudeMdExcludes.includes(path.join(path.dirname(wt), '.claude', '**')));
    assert.ok(settings.permissions.deny.includes('Bash(rm:*)'));
    assert.ok(settings.permissions.deny.some((rule) => rule.startsWith('Read(//') && rule.includes('secrets')), 'the harness\'s secrets stay unread');
    assert.equal(plan.bypass, true);
    assert.equal(plan.model, 'third-model');
    assert.equal(plan.project, fs.realpathSync(project));
    assert.deepEqual(plan.notices, ['--model opus is not served by third-test; the session runs on third-model', '--remote-control was left out: remote control needs a claude.ai login, and sessions on third-test have none']);

    const kept = sessionPlan({ provider: 'third-test', cwd: wt, plugin: null, args: ['--model=third-model', '--strict-mcp-config', '--remote-control', '-p', 'hi'] });
    assert.deepEqual(kept.args.filter((a, i) => kept.args[i - 1] !== '--settings' && a !== '--settings'), ['--model', 'third-model', '--strict-mcp-config', '-p', 'hi']);
    assert.deepEqual(kept.notices, ['--remote-control was left out: remote control needs a claude.ai login, and sessions on third-test have none']);
    const withPlugin = sessionPlan({ provider: 'third-test', cwd: wt, plugin: '/plugins/jh', args: ['--plugin-dir', '/mine'] });
    assert.equal(withPlugin.args.filter((a) => a === '--plugin-dir').length, 1, 'the caller\'s plugin folder wins');
    assert.deepEqual(readClaudeArgs(['--remote-control=x', '--', '--model', 'y']).rest, ['--', '--model', 'y'], 'nothing after -- is read');
    assert.throws(() => sessionPlan({ provider: 'third-test', cwd: wt, args: ['--settings', '[1]'] }), (e) => e.exitCode === 2 && /is neither a JSON object nor a readable file/.test(e.message));
    fs.writeFileSync(path.join(wt, 'list.json'), '[1]');
    assert.throws(() => sessionPlan({ provider: 'third-test', cwd: wt, args: ['--settings', 'list.json'] }), (e) => e.exitCode === 2 && /does not hold a JSON object/.test(e.message));
    fs.writeFileSync(path.join(wt, 'mine.json'), '{"model":"x"}');
    const fromFile = sessionPlan({ provider: 'third-test', cwd: wt, args: ['--settings', 'mine.json'] });
    assert.equal(JSON.parse(fromFile.args[fromFile.args.indexOf('--settings') + 1]).model, 'x', 'a settings file is read from the session\'s folder');
  });

  test('the environment: the provider\'s login, env and model, its own config folder; nothing of other logins, of a parent session, of a step or named like a secret', () => {
    const base = {
      PATH: '/bin', HOME: '/home/x', SSH_AUTH_SOCK: '/tmp/agent', EKOA_SESSION: 'e1', JH_HARNESS_HOME: HARNESS_HOME,
      ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://elsewhere', ANTHROPIC_MODEL: 'claude-x', CLAUDE_CODE_OAUTH_TOKEN: 'owner-token', CLAUDE_CONFIG_DIR: '/home/x/.claude',
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_EFFORT_LEVEL: 'max', GITHUB_TOKEN: 'g', GH_TOKEN: 'g', AWS_SECRET_ACCESS_KEY: 'a', JH_TASK: 'T000000', JH_CWD: '/w',
    };
    const plan = sessionPlan({ provider: 'third-test', cwd: project, base });
    const env = plan.env;
    for (const key of ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'EKOA_SESSION', 'JH_HARNESS_HOME']) assert.equal(env[key], base[key], key);
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_EFFORT_LEVEL', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'JH_TASK', 'JH_CWD']) assert.equal(env[key], undefined, key);
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, KEY);
    assert.equal(env.ANTHROPIC_MODEL, 'third-model');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'third-model');
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '65536');
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(HARNESS_HOME, 'claude-config-sessions', 'third-test'));
    assert.equal(fs.statSync(env.CLAUDE_CONFIG_DIR).mode & 0o777, 0o700);
    const shown = JSON.stringify(shownPlan(plan));
    assert.ok(!shown.includes(KEY), 'the key never appears in what is shown');
    assert.equal(shownPlan(plan).set.ANTHROPIC_AUTH_TOKEN, '<from the provider\'s key or token file>');
    assert.ok(shownPlan(plan).inherited.includes('EKOA_SESSION'));
    assert.equal(shownPlan(plan).env, undefined);
  });

  test('a subscription session: its token, its own config folder, no projects list needed, its own models kept', () => {
    const plan = sessionPlan({ provider: 'claude-test', cwd: other, base: { PATH: '/bin' }, args: ['--model', 'claude-opus-5-5'] });
    assert.equal(plan.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
    assert.equal(plan.env.ANTHROPIC_MODEL, undefined);
    assert.equal(plan.env.CLAUDE_CONFIG_DIR, path.join(HARNESS_HOME, 'claude-config-sessions', 'claude-test'));
    assert.equal(plan.model, 'claude-opus-5-5');
    assert.deepEqual(plan.notices, []);
    assert.equal(plan.project, null);
  });
});

describe('the first-run answers', () => {
  test('onboarding done and the folder trusted under each spelling; the bypass warning only when asked; nothing rewritten when present; other keys kept', async () => {
    const dir = tempDir('jh-seed-');
    const link = path.join(tempDir('jh-seed-link-'), 'wt');
    fs.symlinkSync(wt, link);
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ numStartups: 3, projects: { '/elsewhere': { hasTrustDialogAccepted: false } } }));
    seedConfig({ configDir: dir, cwd: link, bypass: false });
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
    assert.equal(state.hasCompletedOnboarding, true);
    assert.equal(state.numStartups, 3);
    assert.equal(state.projects['/elsewhere'].hasTrustDialogAccepted, false);
    assert.equal(state.projects[link].hasTrustDialogAccepted, true);
    assert.equal(state.projects[wt].hasTrustDialogAccepted, true);
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
    assert.equal(fs.statSync(path.join(dir, '.claude.json')).mode & 0o777, 0o600);
    const before = fs.statSync(path.join(dir, '.claude.json')).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    seedConfig({ configDir: dir, cwd: link, bypass: false });
    assert.equal(fs.statSync(path.join(dir, '.claude.json')).mtimeMs, before, 'unchanged, so not rewritten');
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'light' }));
    seedConfig({ configDir: dir, cwd: link, bypass: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), { theme: 'light', skipDangerousModePermissionPrompt: true });
  });
});

describe('session.mjs', () => {
  const env = (extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: 'C.UTF-8', JH_HARNESS_HOME: HARNESS_HOME, ...extra });
  const run = (args, extra = {}, cwd = wt) => spawnSync(NODE, [SESSION, ...args], { cwd, env: env(extra), encoding: 'utf8', timeout: 30000 });

  // A fake claude that writes how it was run to $FAKE_OUT, then exits with $FAKE_EXIT, or, with FAKE_WAIT, waits for
  // a signal and writes which one it got.
  function fakeClaude() {
    const bin = path.join(tempDir('jh-fake-session-'), 'claude');
    fs.writeFileSync(bin, `#!${NODE}
const fs = require('fs');
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
if (process.env.FAKE_WAIT) {
  for (const s of ['SIGTERM', 'SIGHUP']) process.on(s, () => { fs.writeFileSync(process.env.FAKE_OUT + '.signal', s); process.exit(0); });
  setInterval(() => {}, 1000);
} else process.exit(Number(process.env.FAKE_EXIT || 0));
`, { mode: 0o755 });
    return bin;
  }

  test('--help prints the usage; refusals exit 2 (3 for an unknown provider) with {"error"} and start nothing', () => {
    const help = run(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage: node session.mjs --provider P/);
    let r = run(['--json']);
    assert.equal(r.status, 2);
    assert.deepEqual(JSON.parse(r.stdout), { error: '--provider is required', exitCode: 2 });
    r = run(['--provider', 'endpoint-test', '--json']);
    assert.equal(r.status, 2);
    assert.match(JSON.parse(r.stdout).error, /has no projects list/);
    r = run(['--provider', 'third-test', '--json'], {}, other);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /is not one of them/);
    r = run(['--provider', 'nobody', '--json']);
    assert.equal(r.status, 3);
  });

  test('--dry-run prints what would run, the key masked, and starts nothing', () => {
    const out = path.join(tempDir('jh-dry-'), 'run.json');
    const r = run(['--provider', 'third-test', '--dry-run', '--json', '--', '--model', 'opus'], { JH_CLAUDE_BIN: fakeClaude(), FAKE_OUT: out });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(KEY));
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.model, 'third-model');
    assert.equal(plan.cwd, wt);
    assert.equal(fs.existsSync(out), false, 'nothing ran');
  });

  test('runs claude in the foreground with the plan, answers the first-run screens, prints the notices, and exits with its code', () => {
    const out = path.join(tempDir('jh-run-'), 'run.json');
    const r = run(['--provider', 'third-test', '--', '--dangerously-skip-permissions', '--remote-control', 'x', '--model', 'opus'], { JH_CLAUDE_BIN: fakeClaude(), FAKE_OUT: out, FAKE_EXIT: '7', GITHUB_TOKEN: 'gh-secret' });
    assert.equal(r.status, 7, r.stderr);
    assert.match(r.stderr, /session: --model opus is not served by third-test/);
    assert.match(r.stderr, /session: --remote-control was left out/);
    const rec = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(rec.argv.slice(0, 2), ['--model', 'third-model']);
    assert.ok(!rec.argv.join(' ').includes(KEY), 'the key is never on the command line');
    assert.equal(rec.cwd, wt);
    assert.equal(rec.env.ANTHROPIC_AUTH_TOKEN, KEY);
    assert.equal(rec.env.GITHUB_TOKEN, undefined);
    const configDir = path.join(HARNESS_HOME, 'claude-config-sessions', 'third-test');
    assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8')).projects[wt].hasTrustDialogAccepted, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).skipDangerousModePermissionPrompt, true);
  });

  test('a SIGTERM or SIGHUP to session.mjs reaches the session', async () => {
    for (const signal of ['SIGTERM', 'SIGHUP']) {
      const out = path.join(tempDir('jh-sig-'), 'run.json');
      const child = spawn(NODE, [SESSION, '--provider', 'third-test'], { cwd: wt, env: env({ JH_CLAUDE_BIN: fakeClaude(), FAKE_OUT: out, FAKE_WAIT: '1' }), stdio: 'ignore' });
      assert.ok(waitFor(() => fs.existsSync(out)), 'the fake session started');
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
      child.kill(signal);
      assert.equal(await exited, 0, 'session.mjs exits with the session\'s code');
      assert.equal(fs.readFileSync(`${out}.signal`, 'utf8'), signal);
    }
  });
});
