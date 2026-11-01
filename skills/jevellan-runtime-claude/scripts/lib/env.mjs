// The worker environment, ported from the skills repo's env.ts (minimalEnvironment, itself from Jevellan's
// environment.ts) with its D-004 additions and this repository's H-001. A worker never gets the whole process
// environment; it gets:
//
// - PATH, HOME, USER, LANG, TERM, SHELL, TMPDIR from the process, PATH prefixed with the Node 22 binary's folder;
// - the provider's login: CLAUDE_CODE_OAUTH_TOKEN from tokenFile for a claude-subscription provider that has one,
//   or ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN (keyFile) and the ANTHROPIC_DEFAULT_*_MODEL ids for claude-endpoint;
// - CLAUDE_CONFIG_DIR, the harness's own Claude config folder (H-001), so the owner's ~/.claude settings, hooks,
//   plugins, memory and transcripts are neither used nor written by workers;
// - ENABLE_CLAUDEAI_MCP_SERVERS=false and CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1;
// - GIT_AUTHOR_* and GIT_COMMITTER_* from the machine's git config;
// - PLAYWRIGHT_BROWSERS_PATH when ~/.cache/ms-playwright exists;
// - JH_TASK, JH_STEP, JH_DUTY, JH_PROJECT, JH_SESSION for the hooks.
//
// Values may be secrets: the result only ever goes into a child process environment, never onto a command line,
// into a log or into a file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const BASE_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR'];
export const CLAUDE_KINDS = ['claude-subscription', 'claude-endpoint'];

export class RuntimeError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function ownerHome() {
  try {
    const home = os.userInfo().homedir;
    if (home) return home;
  } catch {}
  return os.homedir();
}

export function harnessHome() {
  return process.env.JH_HARNESS_HOME || path.join(ownerHome(), '.jevellan-harness');
}

export function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return ownerHome();
  if (value.startsWith('~/')) return path.join(ownerHome(), value.slice(2));
  return value;
}

export function providersFile() {
  return path.join(harnessHome(), 'providers.json');
}

export function loadProvidersFile(file = providersFile()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new RuntimeError(`cannot read ${file}: ${error.code ?? error.message}`);
  }
  if (!raw || !Array.isArray(raw.providers)) throw new RuntimeError(`${file} has no providers list`);
  return raw;
}

// The provider entry with its models resolved ("same as <other>" lists the other provider's models).
export function findProvider(name, config = loadProvidersFile()) {
  const provider = config.providers.find((p) => p.name === name);
  if (!provider) throw new RuntimeError(`no provider "${name}" in providers.json`, 3);
  let models = provider.models;
  const same = typeof models === 'string' ? /^same as (\S+)$/.exec(models) : null;
  if (same) models = config.providers.find((p) => p.name === same[1])?.models;
  return { ...provider, models: Array.isArray(models) ? models : [] };
}

export function readSecret(file) {
  if (!file) return undefined;
  try {
    const value = fs.readFileSync(expandHome(file), 'utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

let cachedIdentity = null;
export function machineGitIdentity() {
  if (cachedIdentity) return cachedIdentity;
  const read = (key) => {
    try {
      const value = execFileSync('git', ['config', '--global', '--get', key], {
        cwd: '/',
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: ownerHome() },
      }).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  };
  cachedIdentity = { name: read('user.name'), email: read('user.email') };
  return cachedIdentity;
}

// The Node binary the hooks and scripts are written for: this process's when it is 22 or later.
export function nodeBinary() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) return process.execPath;
  const known = path.join(ownerHome(), '.nvm/versions/node/v22.23.2/bin/node');
  return fs.existsSync(known) ? known : process.execPath;
}

export function claudeConfigDir() {
  const dir = path.join(harnessHome(), 'claude-config');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function joinPath(first, rest) {
  const out = [];
  for (const p of [...first, ...String(rest ?? '').split(path.delimiter)]) if (p && !out.includes(p)) out.push(p);
  return out.join(path.delimiter);
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

export function workerEnv({ provider, task, step, duty, project, session, base = process.env }) {
  const env = {};
  for (const key of BASE_KEYS) if (base[key]) env[key] = base[key];
  env.HOME = env.HOME || ownerHome();
  env.LANG = env.LANG || 'C.UTF-8';
  env.TERM = env.TERM || 'dumb';
  env.TMPDIR = env.TMPDIR || '/tmp';
  env.PATH = joinPath([path.dirname(nodeBinary())], base.PATH ?? '/usr/local/bin:/usr/bin:/bin');
  Object.assign(env, providerLogin(provider));
  env.CLAUDE_CONFIG_DIR = claudeConfigDir();
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  const identity = machineGitIdentity();
  if (identity.name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = identity.name;
  if (identity.email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = identity.email;
  const browsers = path.join(ownerHome(), '.cache', 'ms-playwright');
  if (fs.existsSync(browsers)) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  if (process.env.JH_HARNESS_HOME) env.JH_HARNESS_HOME = process.env.JH_HARNESS_HOME;
  env.JH_TASK = task;
  env.JH_STEP = String(step);
  env.JH_DUTY = duty;
  env.JH_PROJECT = project;
  env.JH_SESSION = session;
  return env;
}

// The --settings JSON every worker gets (H-001, H-014): the owner's personal instruction files stay out, and no
// commit or pull request of a worker carries attribution.
export function workerSettings() {
  const home = ownerHome();
  return JSON.stringify({
    claudeMdExcludes: [`${home}/.claude/**`, `${home}/CLAUDE.md`, `${home}/CLAUDE.local.md`],
    attribution: { commit: '', pr: '', sessionUrl: false },
  });
}
