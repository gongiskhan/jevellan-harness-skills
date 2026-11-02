// What every runtime skill shares, a copy in each of them (kept identical where it can be; the copies may drift): the
// error type, the owner's and the harness's folders, providers.json lookups, secrets read for a child's environment
// only, the machine's git identity and the Node 22 binary.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const BASE_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR'];

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


export function joinPath(first, rest) {
  const out = [];
  for (const p of [...first, ...String(rest ?? '').split(path.delimiter)]) if (p && !out.includes(p)) out.push(p);
  return out.join(path.delimiter);
}

// The environment every worker starts from: the base keys, the Node 22 folder first on PATH, the git identity and the
// Playwright browsers, and the hooks' variables (JH_CWD is the step's working folder, the task's worktree, where
// the Stop hook looks for the report). Each runtime adds its provider's login.
export function baseWorkerEnv({ task, step, duty, project, session, cwd, base = process.env }) {
  const env = {};
  for (const key of BASE_KEYS) if (base[key]) env[key] = base[key];
  env.HOME = env.HOME || ownerHome();
  env.LANG = env.LANG || 'C.UTF-8';
  env.TERM = env.TERM || 'dumb';
  env.TMPDIR = env.TMPDIR || '/tmp';
  env.PATH = joinPath([path.dirname(nodeBinary())], base.PATH ?? '/usr/local/bin:/usr/bin:/bin');
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
  if (cwd) env.JH_CWD = cwd;
  return env;
}
