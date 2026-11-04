// gh, the GitHub CLI, the way this skill runs it: --repo from origin's configured URL, the owner's HOME (its login),
// prompts and colour off. JH_GH_BIN replaces the binary in tests. Used by land.mjs and overlap.mjs.
import { spawnSync } from 'node:child_process';
import { ownerHome } from './project.mjs';
import { GitSkillError, firstLine, git } from '../worktree.mjs';

// [host/]owner/repo from a remote URL: https://host/owner/repo(.git), ssh://user@host[:port]/owner/repo(.git) or
// user@host:owner/repo(.git). github.com is left out of the name, as gh writes it. Anything else (a local path) is null.
export function githubRepo(url) {
  const text = String(url ?? '').trim();
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text) ??
    /^(?:[^@/\s]+@)?([^/:\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text);
  if (!m) return null;
  const [, host, owner, name] = m;
  return host === 'github.com' ? `${owner}/${name}` : `${host}/${owner}/${name}`;
}

// gh's environment: the owner's HOME (its login), PATH, the session bus a keyring login needs, prompts and colour off.
// Nothing from providers or Jev.
export function ghEnvironment(owner, base = process.env) {
  const env = {};
  for (const key of ['PATH', 'USER', 'LANG', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (base[key]) env[key] = base[key];
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  return { ...env, HOME: owner, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' };
}

export function ghClient(root) {
  // The URL as configured: `git remote get-url` would expand url.<base>.insteadOf, which can name a local mirror.
  const url = git(root, ['config', '--get', 'remote.origin.url'], { permitted: [0, 1] }).stdout.trim();
  const repo = githubRepo(url);
  if (!repo) throw new GitSkillError(`origin's URL ${url ? JSON.stringify(url) : '(none)'} names no host, owner and repository; "landing": "pr" opens the pull request there with gh`);
  return { bin: process.env.JH_GH_BIN || 'gh', repo, env: ghEnvironment(ownerHome()) };
}

// Runs gh with --repo, the body (if any) on stdin. Refuses (exit 2) with gh's first error line.
export function runGh(gh, cwd, args, input) {
  const what = `gh ${args.slice(0, 2).join(' ')}`;
  const r = spawnSync(gh.bin, [...args, '--repo', gh.repo], { cwd, env: gh.env, input: input ?? '', encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error?.code === 'ENOENT') throw new GitSkillError(`gh is not installed or not on PATH; "landing": "pr" opens the pull request with it`);
  if (r.error) throw new GitSkillError(`${what} failed: ${r.error.message}`);
  if (r.status !== 0) throw new GitSkillError(`${what} failed: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.status ?? r.signal}`}`);
  return r.stdout ?? '';
}

