#!/usr/bin/env node
// Starts a Claude Code session of the owner's (a coordinator, or any session the owner or Ekoa starts) on a named
// Claude provider from providers.json, in the foreground, and exits with the session's exit code (H-044).
//
//   node session.mjs --provider P [--cwd DIR] [--dry-run] [--json] [-- <claude arguments>]
//
// Everything after "--" goes to claude (for example --model opus --effort medium --dangerously-skip-permissions
// --mcp-config F). lib/session.mjs says what the session gets and the guards; a refusal exits 2 with the reason, an
// unknown provider 3, before anything starts. --dry-run prints what would run (the secret masked) and starts nothing.
// The provider's secret goes only into the session's environment, never onto a command line or into output.

import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { RuntimeError } from './lib/env.mjs';
import { seedConfig, sessionPlan, shownPlan } from './lib/session.mjs';
import { isEntry } from './lib/cli.mjs';

export const USAGE = 'usage: node session.mjs --provider P [--cwd DIR] [--dry-run] [--json] [-- <claude arguments>]';

export function parseSessionArgs(argv) {
  const cut = argv.indexOf('--');
  const own = cut === -1 ? argv : argv.slice(0, cut);
  const claude = cut === -1 ? [] : argv.slice(cut + 1);
  const { values } = parseArgs({
    args: own,
    options: { provider: { type: 'string' }, cwd: { type: 'string' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
  });
  if (values.help) return { help: true };
  if (!values.provider) throw new RuntimeError('--provider is required');
  return { provider: values.provider, cwd: values.cwd ?? process.cwd(), dryRun: Boolean(values['dry-run']), json: Boolean(values.json), claude };
}

function fail(error, json) {
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : String(error?.code ?? '').startsWith('ERR_PARSE_ARGS') ? 2 : 1;
  if (json) process.stdout.write(`${JSON.stringify({ error: error.message, exitCode })}\n`);
  process.stderr.write(`${error.message}\n`);
  process.exitCode = exitCode;
}

export async function run(argv = process.argv.slice(2)) {
  const json = argv.slice(0, argv.indexOf('--') === -1 ? argv.length : argv.indexOf('--')).includes('--json');
  let opts;
  let plan;
  try {
    opts = parseSessionArgs(argv);
    if (opts.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    plan = sessionPlan({ provider: opts.provider, cwd: opts.cwd, args: opts.claude });
  } catch (error) {
    fail(error, json);
    return;
  }
  if (opts.dryRun) {
    const shown = shownPlan(plan);
    process.stdout.write(opts.json ? `${JSON.stringify(shown, null, 2)}\n` : `${[`provider ${shown.provider} model ${shown.model} in ${shown.cwd}`, `claude ${shown.args.join(' ')}`, ...shown.notices.map((n) => `notice: ${n}`)].join('\n')}\n`);
    return;
  }
  seedConfig({ configDir: plan.configDir, cwd: plan.cwd, bypass: plan.bypass });
  for (const notice of plan.notices) process.stderr.write(`session: ${notice}\n`);
  const child = spawn(process.env.JH_CLAUDE_BIN || 'claude', plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'inherit' });
  // The terminal sends Ctrl-C to the session itself; a termination or hang-up of this process is passed on to it.
  process.on('SIGINT', () => {});
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {}
    });
  }
  const code = await new Promise((resolve) => {
    child.on('error', (error) => {
      process.stderr.write(`session: claude did not start: ${error.message}\n`);
      resolve(1);
    });
    child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 128 + (({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 })[signal] ?? 0) : 1)));
  });
  process.exitCode = code;
}

if (isEntry(import.meta.url)) await run();
