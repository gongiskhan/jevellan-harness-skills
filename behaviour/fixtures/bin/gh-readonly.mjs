// The GitHub CLI for the real replay (R01): the real gh, read-only, and as GitHub looked at the replay's moment. The
// runner copies it to <run>/bin/gh with a shebang to Node 22 and writes readonly.json next to it:
//   {realGh: "/usr/bin/gh", cutoff: "2026-11-03T11:34:59Z"}
// Only `list` and `view` subcommands pass (pr, issue, repo). `pr list` and `issue list` get "created:<=<cutoff>" added
// to their search, and `pr view` refuses a pull request created after the cutoff, so nothing that happened after the
// replay's moment (the task's own pull request among it) can reach the session. Every call is logged to calls.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, 'readonly.json'), 'utf8'));
const argv = process.argv.slice(2);

function finish(out, code, err = '', note = undefined) {
  fs.appendFileSync(path.join(here, 'calls.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), argv, cwd: process.cwd(), exit: code, ...(note ? { note } : {}) })}\n`);
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(code);
}

const real = (args) => spawnSync(config.realGh, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
const [group, command] = argv;
if (!['pr', 'issue', 'repo'].includes(group) || !['list', 'view'].includes(command)) {
  finish('', 1, `gh (replay, read-only): ${argv.slice(0, 2).join(' ') || '(nothing)'} is refused; only list and view run here\n`, 'refused');
}

let args = [...argv];
if (command === 'list' && group !== 'repo') {
  const filter = `created:<=${config.cutoff}`;
  const i = args.findIndex((a) => a === '--search' || a === '-S');
  if (i >= 0) args[i + 1] = `${args[i + 1]} ${filter}`;
  else args.push('--search', filter);
}
if (command === 'view' && group !== 'repo') {
  const target = args[2] && !args[2].startsWith('-') ? args[2] : null;
  const repo = args.includes('--repo') ? ['--repo', args[args.indexOf('--repo') + 1]] : args.includes('-R') ? ['-R', args[args.indexOf('-R') + 1]] : [];
  const probe = real([group, 'view', ...(target ? [target] : []), '--json', 'createdAt', ...repo]);
  if (probe.status !== 0) finish(probe.stdout, probe.status ?? 1, probe.stderr);
  const createdAt = JSON.parse(probe.stdout).createdAt;
  if (createdAt > config.cutoff) finish('', 1, `no pull requests found for ${target ?? 'the current branch'}\n`, `hidden: created ${createdAt}`);
}
const r = real(args);
finish(r.stdout, r.status ?? 1, r.stderr);
