// H12 No leaks, no runtime: the contents of every secret file, and the assignment form of the OAuth token variable,
// appear nowhere in the ledgers, logs, evidence, reports, decision files, acceptance outputs or the repository; the
// skills name no jv runtime; the sandbox tracks no .claude or .jevellan file; and the skills run's tmux session, ~/.jv
// (except the read-only copies of section 8) and the live sandbox have no modification newer than this run's start.
// Patterns go to grep on stdin, and only file names are printed, never a match.

import fs from 'node:fs';
import path from 'node:path';
import { HARNESS, Journey, OWNER_HOME, REPO, SANDBOX, TOKEN_ASSIGNMENT, git, sh } from './lib.mjs';

const j = new Journey('H12', 'No leaks, no runtime');
const marker = path.join(HARNESS, 'run-start.marker');
const runStart = fs.readFileSync(path.join(HARNESS, 'run-start.txt'), 'utf8').trim();
j.note(`run start ${runStart}`);

// The secret values: every line of at least 8 characters of every file in the secrets folder, and the whole files.
const secretDir = path.join(HARNESS, 'secrets');
const values = new Set();
for (const name of fs.readdirSync(secretDir)) {
  const text = fs.readFileSync(path.join(secretDir, name), 'utf8');
  if (text.trim().length >= 8) values.add(text.trim());
  for (const line of text.split('\n')) if (line.trim().length >= 8) values.add(line.trim());
}
j.check('secret values loaded for the search', values.size >= 3, `${values.size} values from ${fs.readdirSync(secretDir).length} files`);
const patterns = `${[...values].join('\n')}\n`;

// Where to look.
const ledgerProjects = [SANDBOX, ...(() => {
  const runs = path.join(OWNER_HOME, 'jevellan-projects', 'jevellan-harness-runs');
  return fs.existsSync(runs) ? fs.readdirSync(runs).map((d) => path.join(runs, d, 'jevellan-harness-sandbox')).filter((d) => fs.existsSync(d)) : [];
})()];
const places = [
  ...ledgerProjects.map((p) => path.join(p, '.jevellan')),
  path.join(HARNESS, 'logs'),
  path.join(HARNESS, 'worktrees'),
  path.join(HARNESS, 'archive'),
  path.join(HARNESS, 'providers-state.json'),
  path.join(HARNESS, 'providers.json'),
  path.join(REPO, 'acceptance'),
].filter((p) => fs.existsSync(p));
const repoFiles = git(REPO, ['ls-files']).split('\n').filter(Boolean).map((f) => path.join(REPO, f));

function grepFiles(args, input, targets) {
  const out = [];
  for (let i = 0; i < targets.length; i += 200) {
    const r = sh('grep', [...args, ...targets.slice(i, i + 200)], { input, timeoutMs: 600_000 });
    out.push(...r.stdout.split('\n').filter(Boolean));
  }
  return out;
}
// -I skips binary files (screenshots) and node_modules folders are left out: they hold no file of ours.
const valueHits = [
  ...grepFiles(['-rIlF', '--exclude-dir=node_modules', '-f', '-'], patterns, places),
  ...grepFiles(['-IlF', '-f', '-'], patterns, repoFiles),
];
j.check('no secret value in the ledgers, logs, evidence, reports, decisions, worktrees, acceptance outputs or the repository', valueHits.length === 0, valueHits.slice(0, 10).join(', '));
const assignHits = [
  ...grepFiles(['-rIlF', '--exclude-dir=node_modules', '-e', TOKEN_ASSIGNMENT], undefined, places),
  ...grepFiles(['-IlF', '-e', TOKEN_ASSIGNMENT], undefined, repoFiles),
];
j.check(`no "${TOKEN_ASSIGNMENT}" anywhere in those`, assignHits.length === 0, assignHits.slice(0, 10).join(', '));
const claudeLogs = path.join(HARNESS, 'claude-config', 'projects');
if (fs.existsSync(claudeLogs)) {
  const transcriptHits = grepFiles(['-rIlF', '-f', '-'], patterns, [claudeLogs]);
  j.check('no secret value in the workers\' native transcripts', transcriptHits.length === 0, transcriptHits.slice(0, 5).join(', '));
}

// No jv runtime named by the skills.
const jv = sh('grep', ['-rn', 'jv \\|~/.jv\\|jevellan-hub', path.join(REPO, 'skills')]);
j.check('grep -rn "jv \\|~/.jv\\|jevellan-hub" skills/ finds nothing', jv.stdout.trim() === '', jv.stdout.split('\n').slice(0, 5).join(' | '));

// The sandbox tracks nothing of the harness.
const tracked = git(SANDBOX, ['ls-files', '.claude', '.jevellan', 'CLAUDE.md']);
j.check('the sandbox tracks no .claude or .jevellan file', tracked === '', tracked);
j.check('the sandbox checkout is clean', git(SANDBOX, ['status', '--porcelain']) === '', git(SANDBOX, ['status', '--porcelain']));

// The other run's things.
const jvNewer = sh('find', [path.join(OWNER_HOME, '.jv'), '-newer', marker]).stdout.split('\n').filter(Boolean);
j.check('~/.jv has no modification newer than this run\'s start', jvNewer.length === 0, jvNewer.slice(0, 10).join(', '));
const live = path.join(OWNER_HOME, 'jevellan-projects', 'jevellan-live-sandbox');
const liveNewer = sh('find', [live, '-newer', marker, '-not', '-path', `${live}/node_modules/*`]).stdout.split('\n').filter(Boolean);
const liveFiles = liveNewer.filter((p) => p !== path.join(live, '.git'));
j.check('the live sandbox has no file modified after this run\'s start', liveFiles.length === 0, liveFiles.slice(0, 10).join(', '));
if (liveNewer.includes(path.join(live, '.git'))) j.note('the live sandbox\'s .git folder mtime moved at 22:46:14Z when this run\'s first read-only git status created and removed index.lock (docs/findings.md); no file in it changed');
const liveHead = sh('git', ['-C', live, 'rev-parse', 'HEAD'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).stdout.trim();
j.check('the live sandbox is still at 43e279e', liveHead.startsWith('43e279e'), liveHead);
const skillsRepo = path.join(OWNER_HOME, 'dev', 'jevellan-skills');
if (fs.existsSync(skillsRepo)) {
  const newer = sh('find', [skillsRepo, '-newer', marker, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*']).stdout.split('\n').filter(Boolean);
  j.check('~/dev/jevellan-skills has no file modified after this run\'s start', newer.length === 0, newer.slice(0, 10).join(', '));
}
const tmuxInfo = sh('tmux', ['display-message', '-p', '-t', '=jv-build:', '#{session_created}']).stdout.trim();
if (tmuxInfo) {
  const created = new Date(Number(tmuxInfo) * 1000).toISOString();
  j.check('the tmux session jv-build is the one created before this run, never re-created', Date.parse(created) < Date.parse(runStart), `created ${created}`);
  j.note('no script of this run targets jv-build: the only tmux session the journeys type into is jh-coord (acceptance/coord.mjs)');
}
const typedOther = sh('grep', ['-rn', 'jv-build', path.join(REPO, 'acceptance'), path.join(REPO, 'skills'), path.join(REPO, 'scripts')]).stdout.split('\n').filter((l) => l && !l.includes('h12-no-leaks.mjs') && !l.includes('RESULTS.md') && !l.includes('/results/'));
j.check('no script of this repository names the jv-build session', typedOther.length === 0, typedOther.slice(0, 3).join(' | '));
j.finish();
