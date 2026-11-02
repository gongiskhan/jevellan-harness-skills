// The worker environment, ported from the skills repo's env.ts (minimalEnvironment, itself from Jevellan's
// environment.ts) with its D-004 additions and this repository's H-001. A worker never gets the whole process
// environment; it gets:
//
// - PATH, HOME, USER, LANG, TERM, SHELL, TMPDIR from the process, PATH prefixed with the Node 22 binary's folder;
// - the provider's login: CLAUDE_CODE_OAUTH_TOKEN from tokenFile for a claude-subscription provider that has one,
//   or ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN (keyFile) and the ANTHROPIC_DEFAULT_*_MODEL ids for claude-endpoint;
// - CLAUDE_CONFIG_DIR, the harness's own Claude config folder (H-001), so the owner's personal Claude settings,
//   hooks, plugins, memory and transcripts are neither used nor written by workers;
// - ENABLE_CLAUDEAI_MCP_SERVERS=false and CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1;
// - GIT_AUTHOR_* and GIT_COMMITTER_* from the machine's git config;
// - PLAYWRIGHT_BROWSERS_PATH when ~/.cache/ms-playwright exists;
// - JH_TASK, JH_STEP, JH_DUTY, JH_PROJECT, JH_SESSION and JH_CWD (the step's worktree) for the hooks.
//
// The --settings of every worker (workerSettings) keep out the instruction files of every folder above the step's
// worktree, so nothing from outside the project tells a worker what to do.
//
// Values may be secrets: the result only ever goes into a child process environment, never onto a command line,
// into a log or into a file.

import fs from 'node:fs';
import path from 'node:path';
import { RuntimeError, baseWorkerEnv, harnessHome, readSecret } from './common.mjs';

export * from './common.mjs';
export const CLAUDE_KINDS = ['claude-subscription', 'claude-endpoint'];

export function claudeConfigDir() {
  const dir = path.join(harnessHome(), 'claude-config');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

// The provider's login variables. Refuses when the provider cannot run a Claude session here.
export function providerLogin(provider) {
  if (!CLAUDE_KINDS.includes(provider.kind)) throw new RuntimeError(`provider ${provider.name} is ${provider.kind}, not a Claude provider`);
  if (provider.enabled === false) throw new RuntimeError(`provider ${provider.name} is disabled in providers.json`);
  const env = {};
  if (provider.kind === 'claude-subscription') {
    if (provider.tokenFile) {
      const token = readSecret(provider.tokenFile);
      if (!token) throw new RuntimeError(`provider ${provider.name}: token file ${provider.tokenFile} is missing or empty`);
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }
  } else {
    const key = readSecret(provider.keyFile);
    if (!key) throw new RuntimeError(`provider ${provider.name}: key file ${provider.keyFile ?? '(none named)'} is missing or empty`);
    if (!provider.baseUrl) throw new RuntimeError(`provider ${provider.name} has no baseUrl`);
    env.ANTHROPIC_BASE_URL = provider.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = key;
    const ids = provider.models.map((m) => m.id);
    if (ids[0]) {
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = ids[0];
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = ids[1] ?? ids[0];
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = ids[ids.length - 1];
    }
  }
  return env;
}

export function workerEnv({ provider, task, step, duty, project, session, cwd, base = process.env }) {
  const env = baseWorkerEnv({ task, step, duty, project, session, cwd, base });
  Object.assign(env, providerLogin(provider));
  env.CLAUDE_CONFIG_DIR = claudeConfigDir();
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  return env;
}

// The harness's secrets folder, as it is named and as it resolves (a symlinked harness home has two spellings).
export function secretsDirs() {
  const dir = path.join(harnessHome(), 'secrets');
  const dirs = [dir];
  try {
    const real = fs.realpathSync(dir);
    if (!dirs.includes(real)) dirs.push(real);
  } catch {}
  return dirs;
}

// The folders above `cwd`, nearest first, under each of its spellings (as given and as it resolves, since a
// symlinked folder has two). `cwd` itself is not one of them.
export function foldersAbove(cwd) {
  const starts = [path.resolve(cwd)];
  try {
    const real = fs.realpathSync(cwd);
    if (!starts.includes(real)) starts.push(real);
  } catch {}
  const out = [];
  for (const start of starts) {
    for (let dir = start, parent = path.dirname(dir); parent !== dir; dir = parent, parent = path.dirname(dir)) {
      if (!out.includes(parent)) out.push(parent);
    }
  }
  return out;
}

// The instruction files Claude Code would load from the folders above `cwd` (CLAUDE.md, CLAUDE.local.md, and
// everything under .claude, where .claude/CLAUDE.md and .claude/rules/ live), as claudeMdExcludes patterns. The step's worktree lives under
// the harness folder, so the owner's home is one of those folders and the owner's personal instructions stay out;
// the worktree itself and what is below it are the project's, which keeps no CLAUDE.md either (AGENTS.md is what the
// worker is given).
export function instructionExcludes(cwd) {
  return foldersAbove(cwd).flatMap((dir) => [path.join(dir, 'CLAUDE.md'), path.join(dir, 'CLAUDE.local.md'), path.join(dir, '.claude', '**')]);
}

// The --settings JSON every worker gets (H-001, H-014): no instruction file from a folder above the step's worktree
// `cwd` is loaded, no commit or pull request of a worker carries attribution, and the Read and Edit tools (and the
// tools built on them: Grep, Glob, Write) may not touch the harness's secrets folder. A permission path that starts
// with "//" is absolute from the filesystem root ("/x" would be relative to a settings file); deny rules hold under
// bypassPermissions too ("auto-approves every tool call (except explicit deny rules)", Claude Code 2.1.316). The rules
// do not reach a Bash command that reads the folder; nothing short of a sandbox does. The worker's raw output goes to
// ~/.jevellan-harness/logs/<session>.log and its native transcript to the harness's claude-config folder, both
// mode 600 in mode 700 folders under the harness folder, never into the project (status.mjs redacts what it shows).
// Without `cwd` the folders above this process's working folder are used.
export function workerSettings(cwd = process.cwd()) {
  const secrets = secretsDirs().map((dir) => `/${dir}/**`);
  return JSON.stringify({
    claudeMdExcludes: instructionExcludes(cwd),
    attribution: { commit: '', pr: '', sessionUrl: false },
    permissions: { deny: [...secrets.map((p) => `Read(${p})`), ...secrets.map((p) => `Edit(${p})`)] },
  });
}
