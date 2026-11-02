// What every hook shares: read the hook input from stdin, log to .jevellan/hooks.log, and never break a session.
// A hook that fails for any reason logs the error and exits 0 (section 1: hooks must not break a session).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPaths, projectRoot } from './project.mjs';
import { redactText } from './redact.mjs';

export function readInput() {
  try {
    const text = fs.readFileSync(0, 'utf8');
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export function logLine(root, hook, message) {
  if (!root) return;
  try {
    const file = projectPaths(root).hooksLog;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${hook} ${redactText(String(message)).replace(/\s+/g, ' ').slice(0, 2000)}\n`);
  } catch {}
}

// How long a claim keeps a second run of the same hook for the same event away. The two runs of a hook registered twice
// start together; an identical event later than this is a new event.
export const CLAIM_MS = 30000;
const SWEEP_MS = 10 * 60000;

// Claude Code runs a hook once per registration: a project installed with install.mjs whose owner also enabled the
// plugin has each of these hooks twice, and both processes get the same input at the same moment (a second Stop hook
// would find the report already moved to the archive and block the worker). The first to claim the event handles it,
// the other returns false and does nothing. The claim is a file under .jevellan/locks/hooks/ named after the hook, its
// input and the transcript's size (the transcript grows between two real events), made with O_EXCL; a claim older
// than CLAIM_MS belongs to an earlier identical event and is taken over. Only a call that names its transcript (every
// call Claude Code makes does) is claimed; nothing is claimed outside a project set up for the harness, where the hooks
// do nothing anyway; and anything that keeps the claim from working lets the hook run.
export function claimEvent(root, name, input) {
  if (!root || typeof input?.transcript_path !== 'string' || !fs.existsSync(projectPaths(root).dir)) return true;
  try {
    let size = '';
    try {
      size = String(fs.statSync(input.transcript_path).size);
    } catch {}
    const key = crypto.createHash('sha256').update(`${name}\n${size}\n${JSON.stringify(input ?? {})}`).digest('hex').slice(0, 32);
    const dir = path.join(projectPaths(root).locks, 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}-${key}`);
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') return true;
      if (Date.now() - fs.statSync(file).mtimeMs < CLAIM_MS) return false;
      fs.writeFileSync(file, `${process.pid}\n`);
    }
    if (Math.random() < 0.05) sweepClaims(dir);
    return true;
  } catch {
    return true;
  }
}

// Removes claims older than ten minutes (this module's own files, never anything else).
export function sweepClaims(dir, now = Date.now()) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > SWEEP_MS) fs.unlinkSync(file);
      } catch {}
    }
  } catch {}
}

// The hooks run with the node first on the session's PATH (a plugin's hooks name no binary). Node 22.13 or later is
// what they are built and tested for; an older one is named in hooks.log and, by the SessionStart hook, to the session.
export const MIN_NODE = [22, 13];
export function nodeTooOld(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
}

// Runs `body(input, root)` once per event; whatever happens, the process exits 0 and stdout carries only what body
// printed.
export function runHook(name, body) {
  let root = null;
  try {
    const input = readInput();
    root = projectRoot(input.cwd || process.cwd());
    if (!claimEvent(root, name, input)) {
      logLine(root, name, 'the same event is handled by another registration of this hook; skipped');
      return;
    }
    if (nodeTooOld() && root && fs.existsSync(projectPaths(root).dir)) logLine(root, name, `running on Node ${process.version} (${process.execPath}); the hooks need 22.13 or later`);
    body(input, root);
  } catch (error) {
    logLine(root, name, `error: ${error?.stack ?? error}`);
  } finally {
    process.exitCode = 0;
  }
}

// True when the module at `url` is the process's entry point (symlinks resolved), so a hook file can be imported
// by tests without running. fileURLToPath decodes the URL: a project path with a space is "%20" in the URL's
// pathname, which names no file.
export function isMain(url) {
  try {
    const entry = process.argv[1] && fs.realpathSync(process.argv[1]);
    return Boolean(entry) && fs.realpathSync(fileURLToPath(url)) === entry;
  } catch {
    return false;
  }
}
