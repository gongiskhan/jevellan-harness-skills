// What every hook shares: read the hook input from stdin, log to .jevellan/hooks.log, and never break a session.
// A hook that fails for any reason logs the error and exits 0 (section 1: hooks must not break a session).

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

// Runs `body(input, root)`; whatever happens, the process exits 0 and stdout carries only what body printed.
export function runHook(name, body) {
  let root = null;
  try {
    const input = readInput();
    root = projectRoot(input.cwd || process.cwd());
    body(input, root);
  } catch (error) {
    logLine(root, name, `error: ${error?.stack ?? error}`);
  }
  process.exitCode = 0;
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
