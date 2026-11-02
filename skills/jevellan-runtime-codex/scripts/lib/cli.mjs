// Command-line plumbing of the runtime scripts: text or --json output, exit codes 0 ok, 2 refused, 3 not found.

import fs from 'node:fs';

export async function main(fn) {
  const json = process.argv.includes('--json');
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
