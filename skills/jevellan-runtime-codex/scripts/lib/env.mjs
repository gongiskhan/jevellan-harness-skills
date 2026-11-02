// The Codex worker's environment and command lines (brief 5.3; the skills repo's codex.ts used the SDK, this runs
// `codex exec`). A Codex worker gets the shared base environment (common.mjs) and CODEX_HOME: the provider's
// codexHome, or the owner's ~/.codex when it has none. No key or token is ever passed: Codex signs in with the login
// stored in that folder, which is never copied, read or refreshed by these scripts.

import fs from 'node:fs';
import path from 'node:path';
import { RuntimeError, baseWorkerEnv, expandHome, ownerHome } from './common.mjs';

export * from './common.mjs';
export const CODEX_KINDS = ['codex-subscription'];
export const INSTRUCTIONS_LINE = 'Instructions for this session:';

export function codexHome(provider) {
  return provider.codexHome ? expandHome(provider.codexHome) : path.join(ownerHome(), '.codex');
}

export function workerEnv({ provider, task, step, duty, project, session, cwd, base = process.env }) {
  if (!CODEX_KINDS.includes(provider.kind)) throw new RuntimeError(`provider ${provider.name} is ${provider.kind}, not a Codex provider`);
  if (provider.enabled === false) throw new RuntimeError(`provider ${provider.name} is disabled in providers.json`);
  const home = codexHome(provider);
  if (!fs.existsSync(path.join(home, 'auth.json'))) throw new RuntimeError(`provider ${provider.name}: no Codex login in ${home}; the owner runs "codex login" once`);
  const env = baseWorkerEnv({ task, step, duty, project, session, cwd, base });
  env.CODEX_HOME = home;
  return env;
}

// codex exec for a first turn; the message is read from stdin ("-"), so a long append never meets the argument size
// limit. Every duty runs with approvals and the sandbox bypassed, as brief 5.3 says; a read-only duty is held to its
// duty by its instructions (H-025).
export function codexStartArgs({ cwd, model, effort }) {
  return ['exec', '--json', '-C', cwd, '-m', model, '-c', `model_reasoning_effort=${effort}`, '--dangerously-bypass-approvals-and-sandbox', '-'];
}

// codex exec resume has no -C: the process runs in the worktree instead.
export function codexResumeArgs({ threadId, model, effort }) {
  return ['exec', 'resume', '--json', '-m', model, '-c', `model_reasoning_effort=${effort}`, '--dangerously-bypass-approvals-and-sandbox', threadId, '-'];
}

export function firstMessage(append, prompt) {
  return `${INSTRUCTIONS_LINE}\n\n${append.trim()}\n\n${prompt}`;
}
