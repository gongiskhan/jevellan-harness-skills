// The Claude runtime's own part: the claude command line for a turn. Everything else the scripts use comes from
// task.mjs and env.mjs, re-exported here.

import { workerSettings } from './env.mjs';
import { NO_TOOL_DUTIES, READ_ONLY_DUTIES, dutyMode } from './prompt.mjs';
import { pluginRoot } from './roles.mjs';

export * from './task.mjs';
export { RuntimeError, assertProjectAllowed, workerEnv, nodeBinary } from './env.mjs';
export { dutyMode };

// The claude command line for a turn in the step's worktree `cwd`. The prompt always follows "--" (H-005). When these
// skills came with a Claude Code plugin, the worker loads that plugin (`plugin`, its folder): the worker's own
// configuration folder holds none of the owner's plugins, and its worktree has no .claude link to a project's skills
// (H-038), so --plugin-dir is how it finds the duty skills and the ledger's hooks.
export function claudeArgs({ duty, session, resume = false, model, effort, appendFile, prompt, cwd, plugin = pluginRoot() }) {
  const mode = dutyMode(duty);
  const args = ['-p', resume ? '--resume' : '--session-id', session, '--model', model, '--effort', effort];
  if (mode === 'write') {
    args.push('--permission-mode', 'bypassPermissions');
  } else if (mode === 'no-tools') {
    args.push('--max-turns', '1', '--tools', '');
  } else {
    const writes = ['./.jevellan/report.json', ...(mode === 'plan' ? ['./plan.md'] : [])];
    args.push(
      '--permission-mode', 'dontAsk',
      '--tools', 'Read,Glob,Grep,WebSearch,WebFetch,Skill,Write,Edit',
      '--allowedTools', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill',
      ...writes.flatMap((file) => [`Write(${file})`, `Edit(${file})`]),
    );
  }
  if (plugin) args.push('--plugin-dir', plugin);
  args.push('--append-system-prompt-file', appendFile, '--settings', workerSettings(cwd), '--output-format', 'stream-json', '--verbose', '--', prompt);
  return args;
}

export function isReadOnly(duty) {
  return READ_ONLY_DUTIES.includes(duty) || NO_TOOL_DUTIES.includes(duty);
}

