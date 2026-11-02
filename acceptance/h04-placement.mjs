// H4 Placement: route.mjs for an investigate step returns a decision with probabilities and appends task.placed;
// with the key file renamed it exits 2 with "Jev: no key configured"; with claude-main's ceilingPct set below its
// usage the menu excludes it and the decision names claude-second. Every change to the machine's files is restored
// in a finally block, and the restore is checked.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESS, Journey, NODE, REPO, SANDBOX, ledgerCli, readLedger, sh, skillDir, skillScript } from './lib.mjs';

const j = new Journey('H4', 'Placement');
const install = sh(NODE, [path.join(REPO, 'install.mjs'), SANDBOX, '--json']);
j.check('the current skills are installed in the sandbox', install.status === 0, install.stderr.trim() || `changed ${install.json?.changed?.length ?? 0} paths`);

const created = ledgerCli(SANDBOX, ['task', 'create', '--kind', 'single', '--duty', 'investigate', '--title', 'H4: which port does the web server listen on', '--text', 'Find the port the sandbox web server listens on and where it is set. Acceptance H4.', '--json']);
const task = created.json?.task;
j.check('task created', created.status === 0 && Boolean(task), created.stderr.trim());
const wt = skillScript(SANDBOX, 'jevellan-git', 'scripts/worktree.mjs', ['create', '--task', task, '--json']);
j.check('worktree created through the git skill', wt.status === 0 && fs.existsSync(wt.json?.path ?? '/nonexistent'), wt.stdout.trim() || wt.stderr.trim());
j.check('the worktree has the .claude link and an evidence folder', fs.existsSync(path.join(wt.json.path, '.claude', 'skills', 'jevellan-ledger', 'SKILL.md')) && fs.existsSync(path.join(wt.json.path, '.jevellan', 'evidence')));
j.check('the worktree is clean in git', sh('git', ['-C', wt.json.path, 'status', '--porcelain']).stdout.trim() === '', sh('git', ['-C', wt.json.path, 'status', '--porcelain']).stdout.trim());

const route = (extra = []) => skillScript(SANDBOX, 'jevellan-router', 'scripts/route.mjs', ['--task', task, '--step', '1', '--duty', 'investigate', ...extra], { timeoutMs: 120_000 });

// 1. A real placement.
const t0 = Date.now();
const placed = route();
j.time('placement', Date.now() - t0);
const decision = placed.json;
j.check('route.mjs exits 0 with provider, model, effort, kind, probabilities, latencyMs, policyHash', placed.status === 0 && ['provider', 'model', 'effort', 'kind', 'probabilities', 'latencyMs', 'policyHash'].every((k) => decision?.[k] !== undefined), placed.stdout.trim().slice(0, 400) || placed.stderr.trim());
j.check('the decision carries probabilities for the model question', decision && Object.keys(decision.probabilities?.model ?? {}).length >= 2, JSON.stringify(decision?.probabilities));
const placedLine = readLedger(SANDBOX).filter((e) => e.task === task && e.kind === 'task.placed').pop();
j.check('task.placed is in the ledger with source jev and a decision file', placedLine?.data?.source === 'jev' && placedLine.data.model === decision?.model && fs.existsSync(path.isAbsolute(placedLine.data.decisionFile ?? '') ? placedLine.data.decisionFile : path.join(SANDBOX, placedLine?.data?.decisionFile ?? '/nonexistent')), JSON.stringify(placedLine?.data ?? {}).slice(0, 300));
j.note(`Jev placed the investigate step on ${decision?.model} ${decision?.effort} via ${decision?.provider} (model p ${decision?.probabilities?.model?.[decision?.model]?.toFixed?.(2)}), ${decision?.latencyMs} ms`);

// 2. No key.
const keyFile = path.join(HARNESS, 'secrets', 'jev.key');
const renamed = `${keyFile}.h4-renamed`;
const before = readLedger(SANDBOX).length;
let noKey;
try {
  fs.renameSync(keyFile, renamed);
  noKey = route();
} finally {
  if (fs.existsSync(renamed)) fs.renameSync(renamed, keyFile);
}
j.check('with the key file renamed, route.mjs exits 2 "Jev: no key configured"', noKey.status === 2 && /Jev: no key configured/.test(noKey.stderr + noKey.stdout), (noKey.stderr || noKey.stdout).trim());
j.check('nothing was appended for the refused placement', readLedger(SANDBOX).length === before);
j.check('the key file is back with mode 600', fs.existsSync(keyFile) && (fs.statSync(keyFile).mode & 0o777) === 0o600);

// 3. claude-main over its ceiling.
const providersFile = path.join(HARNESS, 'providers.json');
const original = fs.readFileSync(providersFile, 'utf8');
// The usage placement sees is the current window's: a weekly figure observed before its window reset counts as
// unknown, so the probe runs first and the ceiling goes under what is live now (the router's own reading of it).
const probe = skillScript(SANDBOX, 'jevellan-router', 'scripts/providers.mjs', ['check', '--only', 'claude-main', '--only', 'claude-second', '--json'], { timeoutMs: 180_000 });
j.note(`providers check before the ceiling: exit ${probe.status}`);
const { currentUsage } = await import(pathToFileURL(path.join(skillDir(SANDBOX, 'jevellan-router'), 'scripts', 'lib', 'providers-file.mjs')).href);
const state = JSON.parse(fs.readFileSync(path.join(HARNESS, 'providers-state.json'), 'utf8'));
const live = currentUsage(state.providers?.['claude-main']);
const weekly = Math.max(live.weeklyPct ?? -1, live.fiveHourPct ?? -1);
let ceilingRun;
let ceiling = null;
try {
  if (weekly >= 2) {
    ceiling = Math.max(1, Math.floor(weekly) - 1);
    const changed = JSON.parse(original);
    changed.providers.find((p) => p.name === 'claude-main').ceilingPct = ceiling;
    fs.writeFileSync(providersFile, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
    ceilingRun = route();
  }
} finally {
  fs.writeFileSync(providersFile, original, { mode: 0o600 });
}
j.check('providers.json is restored byte for byte', fs.readFileSync(providersFile, 'utf8') === original);
if (ceilingRun) {
  const d = ceilingRun.json;
  j.note(`claude-main current usage ${weekly}% (weekly ${live.weeklyPct}, five-hour ${live.fiveHourPct}), ceiling set to ${ceiling}% for the check`);
  // Jev chooses the model first: a Claude model must then go to claude-second, any other model to its own provider;
  // never claude-main.
  const claudeModel = /^claude-/.test(d?.model ?? '');
  j.check('with claude-main over its ceiling the decision avoids it (a Claude model goes to claude-second)', ceilingRun.status === 0 && d?.provider !== 'claude-main' && (!claudeModel || d?.provider === 'claude-second'), ceilingRun.stdout.trim().slice(0, 300) || ceilingRun.stderr.trim());
  const line = readLedger(SANDBOX).filter((e) => e.task === task && e.kind === 'task.placed').pop();
  const file = path.isAbsolute(line?.data?.decisionFile ?? '') ? line.data.decisionFile : path.join(SANDBOX, line?.data?.decisionFile ?? '');
  const sent = JSON.parse(JSON.parse(fs.readFileSync(file, 'utf8')).state);
  const menuProviders = (sent.menu?.providers ?? []).map((p) => p.name);
  j.check('the menu Jev saw excludes claude-main', !menuProviders.includes('claude-main') && menuProviders.includes('claude-second'), menuProviders.join(', '));
} else {
  j.check('claude-main has a current usage of at least 2% to set the ceiling under', false, `weekly ${live.weeklyPct}, five-hour ${live.fiveHourPct}`);
}

// Close the journey's task: the owner discards it, the worktree is archived (never deleted).
const archived = skillScript(SANDBOX, 'jevellan-git', 'scripts/worktree.mjs', ['archive', '--task', task, '--reason', 'acceptance H4 finished', '--json']);
j.check('worktree archived through the git skill', archived.status === 0 && !fs.existsSync(wt.json.path), archived.stdout.trim().slice(0, 300) || archived.stderr.trim());
const open = ledgerCli(SANDBOX, ['status', '--json']).json?.tasks ?? [];
j.check('the H4 task is no longer open', !open.some((t) => t.task === task));
j.check('the sandbox checkout stays clean', sh('git', ['-C', SANDBOX, 'status', '--porcelain']).stdout.trim() === '');
j.finish();
