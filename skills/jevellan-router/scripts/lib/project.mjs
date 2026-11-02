// Where things live: the project root (found through git, so a hook in a worktree writes to the project's
// ledger), the project's .jevellan folder, and the machine-level ~/.jevellan-harness folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The owner's home from the user database, never from HOME: a process may run with another HOME.
export function ownerHome() {
  try {
    const home = os.userInfo().homedir;
    if (home) return home;
  } catch {}
  return os.homedir();
}

// JH_HARNESS_HOME exists for tests and for a second installation on one machine.
export function harnessHome() {
  return process.env.JH_HARNESS_HOME || path.join(ownerHome(), '.jevellan-harness');
}

export function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return ownerHome();
  if (value.startsWith('~/')) return path.join(ownerHome(), value.slice(2));
  return value;
}

// Walk up from `start` to the nearest .git. Returns {top, commonDir, root} or null.
// top: the checkout or worktree holding `start`; commonDir: the repository's shared git folder; root: the main
// checkout (the parent of commonDir), which is where the project's .jevellan lives.
export function gitLocate(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {}
    if (stat?.isDirectory()) {
      return { top: dir, commonDir: dotGit, root: dir };
    }
    if (stat?.isFile()) {
      const text = fs.readFileSync(dotGit, 'utf8');
      const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
      if (match) {
        const gitDir = path.resolve(dir, match[1].trim());
        let commonDir = gitDir;
        try {
          commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
        } catch {}
        if (path.basename(commonDir) === '.git') return { top: dir, commonDir, root: path.dirname(commonDir) };
        return viaGit(dir);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function viaGit(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n');
    const top = out[0];
    const commonDir = path.resolve(dir, out[1]);
    return { top, commonDir, root: path.dirname(commonDir) };
  } catch {
    return null;
  }
}

// The project root for this process: JH_PROJECT when the runtime set it, otherwise found from `cwd`.
export function projectRoot(cwd = process.cwd()) {
  const fromEnv = process.env.JH_PROJECT;
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);
  return gitLocate(cwd)?.root ?? null;
}

export function projectPaths(root) {
  const dir = path.join(root, '.jevellan');
  return {
    root,
    dir,
    ledger: path.join(dir, 'ledger.jsonl'),
    locks: path.join(dir, 'locks'),
    ledgerLock: path.join(dir, 'locks', 'ledger.lock'),
    reports: path.join(dir, 'reports'),
    hooksLog: path.join(dir, 'hooks.log'),
    projectJson: path.join(dir, 'project.json'),
    workflows: path.join(dir, 'workflows'),
  };
}

export function readProjectJson(root) {
  try {
    return JSON.parse(fs.readFileSync(projectPaths(root).projectJson, 'utf8'));
  } catch {
    return {};
  }
}
