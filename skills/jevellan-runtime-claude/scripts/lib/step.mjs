// The Claude runtime's own part: the claude command line for a turn. Everything else the scripts use comes from
// task.mjs and env.mjs, re-exported here.

import { workerSettings } from './env.mjs';
import { NO_TOOL_DUTIES, READ_ONLY_DUTIES, dutyMode } from './prompt.mjs';

export * from './task.mjs';
export { RuntimeError, workerEnv, nodeBinary } from './env.mjs';
export { dutyMode };

// The claude command line for a turn in the step's worktree `cwd`. The prompt always follows "--" (H-005).
export function claudeArgs({ duty, session, resume = false, model, effort, appendFile, prompt, cwd }) {
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
  args.push('--append-system-prompt-file', appendFile, '--settings', workerSettings(cwd), '--output-format', 'stream-json', '--verbose', '--', prompt);
  return args;
}

export function isReadOnly(duty) {
  return READ_ONLY_DUTIES.includes(duty) || NO_TOOL_DUTIES.includes(duty);
}

