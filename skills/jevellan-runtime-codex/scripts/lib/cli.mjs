// Command-line plumbing of the runtime scripts: text or --json output, exit codes 0 ok, 2 refused, 3 not found;
// --help (or -h) prints the script's usage and exits 0.

import fs from 'node:fs';

export async function main(fn, usage) {
  const json = process.argv.includes('--json');
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(`${usage ?? 'usage: see the Interface section of this skill\'s SKILL.md'}\n`);
    process.exitCode = 0;
    return;
  }
  try {
    const { out, text, exitCode = 0 } = await fn(process.argv.slice(2));
    process.stdout.write(json ? `${JSON.stringify(out, null, 2)}\n` : `${text}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : String(error?.code ?? '').startsWith('ERR_PARSE_ARGS') ? 2 : 1;
    if (json) process.stdout.write(`${JSON.stringify({ error: error.message, exitCode })}\n`);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = exitCode;
  }
}

export function isEntry(url) {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(url));
  } catch {
    return false;
  }
}
