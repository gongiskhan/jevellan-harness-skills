// Shared command-line plumbing: argument parsing, output in text or JSON, and exit codes
// (0 ok, 2 refused with a reason, 3 not found, other codes as each command documents).

import { parseArgs } from 'node:util';
import { LedgerError } from './ledger.mjs';

export function parse(argv, options, { allowPositionals = true } = {}) {
  try {
    return parseArgs({ args: argv, options, allowPositionals, strict: true });
  } catch (error) {
    throw new LedgerError(error.message.replace(/^TypeError \[[A-Z_]+\]: /, ''));
  }
}

export function print(json, value, text) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (text !== undefined && text !== null) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export async function run(main) {
  const json = process.argv.includes('--json');
  try {
    const code = await main(process.argv.slice(2));
    process.exitCode = Number.isInteger(code) ? code : 0;
  } catch (error) {
    const exitCode = error instanceof LedgerError || Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    const message = error?.message ?? String(error);
    if (json) process.stdout.write(`${JSON.stringify({ error: message, exitCode })}\n`);
    process.stderr.write(`${message}\n`);
    if (exitCode === 1 && error?.stack && process.env.JH_DEBUG) process.stderr.write(`${error.stack}\n`);
    process.exitCode = exitCode;
  }
}
