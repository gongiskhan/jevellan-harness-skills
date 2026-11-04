// A fake GitHub CLI for the behaviour evals. The runner copies it to <run>/bin/gh (first on PATH) with a shebang to
// Node 22; it keeps its state next to itself, because the git skill runs gh with a fixed environment:
//   gh-state.json  {repo, next, prs: [{number, title, body, state, isDraft, headRefName, baseRefName, headRefOid,
//                  mergeCommit, mergedAt, createdAt, updatedAt, author, files: [{path, additions, deletions}]}]}
//   calls.jsonl    one line per call: {t, argv, cwd, stdin?, exit}
// It answers pr list, pr view, pr diff --name-only, pr create, pr edit, pr ready, repo view and auth status, and
// refuses everything else (exit 1). It never logs the environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(here, 'gh-state.json');
const callsFile = path.join(here, 'calls.jsonl');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const argv = process.argv.slice(2);
const wantsStdin = argv.includes('--body-file') && argv[argv.indexOf('--body-file') + 1] === '-';
let stdin = '';
if (wantsStdin) {
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch {}
}

function finish(out, code = 0, err = '') {
  fs.appendFileSync(callsFile, `${JSON.stringify({ t: new Date().toISOString(), argv, cwd: process.cwd(), ...(wantsStdin ? { stdin } : {}), exit: code })}\n`);
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(code);
}

const opt = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const [group, command, target] = argv;
const repoUrl = (n) => `https://github.com/${state.repo}/pull/${n}`;
const prOf = (p) => ({
  number: p.number,
  title: p.title,
  body: p.body ?? '',
  state: p.state,
  isDraft: Boolean(p.isDraft),
  url: repoUrl(p.number),
  headRefName: p.headRefName,
  baseRefName: p.baseRefName ?? 'main',
  headRefOid: p.headRefOid ?? null,
  isCrossRepository: false,
  mergeCommit: p.mergeCommit ?? null,
  mergedAt: p.mergedAt ?? null,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt ?? p.createdAt,
  closedAt: p.closedAt ?? (p.state === 'OPEN' ? null : p.mergedAt ?? null),
  author: p.author ?? { login: 'owner' },
  files: p.files ?? [],
  additions: (p.files ?? []).reduce((n, f) => n + (f.additions ?? 0), 0),
  deletions: (p.files ?? []).reduce((n, f) => n + (f.deletions ?? 0), 0),
  changedFiles: (p.files ?? []).length,
  labels: [],
});
const pick = (object, fields) => Object.fromEntries(fields.map((f) => [f, object[f] ?? null]));
const fieldsOf = () => (opt('--json') ? opt('--json').split(',').map((f) => f.trim()).filter(Boolean) : null);
const byTarget = (t) => {
  if (t === undefined) return null;
  const n = /^\d+$/.test(t) ? Number(t) : Number(/\/pull\/(\d+)/.exec(t)?.[1]);
  return state.prs.find((p) => (Number.isFinite(n) && p.number === n) || p.headRefName === t) ?? null;
};
const table = (prs) => prs.map((p) => `${p.number}\t${p.title}\t${p.headRefName}\t${p.state}`).join('\n') + (prs.length ? '\n' : '');

if (group === 'auth' && command === 'status') finish('github.com\n  Logged in to github.com account owner (fake)\n');
if (group === 'repo' && command === 'view') {
  const info = { nameWithOwner: state.repo, defaultBranchRef: { name: 'main' }, url: `https://github.com/${state.repo}` };
  const fields = fieldsOf();
  finish(fields ? JSON.stringify(pick(info, fields)) : `${state.repo}\n`);
}
if (group === 'pr' && command === 'list') {
  const wanted = (opt('--state') ?? 'open').toLowerCase();
  let prs = state.prs.map(prOf).filter((p) => wanted === 'all' || p.state.toLowerCase() === wanted);
  if (opt('--head')) prs = prs.filter((p) => p.headRefName === opt('--head'));
  if (opt('--base')) prs = prs.filter((p) => p.baseRefName === opt('--base'));
  if (opt('--author')) prs = prs.filter((p) => p.author.login === opt('--author'));
  prs.sort((a, b) => b.number - a.number);
  prs = prs.slice(0, Number(opt('--limit') ?? opt('-L') ?? 30));
  const fields = fieldsOf();
  finish(fields ? JSON.stringify(prs.map((p) => pick(p, fields))) : table(prs));
}
if (group === 'pr' && command === 'view') {
  const pr = byTarget(target && !target.startsWith('-') ? target : undefined);
  if (!pr) finish('', 1, `no pull requests found for ${target ?? 'the current branch'}\n`);
  const view = prOf(pr);
  const fields = fieldsOf();
  finish(fields ? JSON.stringify(pick(view, fields)) : `${view.title} #${view.number}\n${view.state}\n${view.url}\n\n${view.body}\n`);
}
if (group === 'pr' && command === 'diff') {
  const pr = byTarget(target);
  if (!pr) finish('', 1, `no pull requests found for ${target}\n`);
  if (!argv.includes('--name-only')) finish('', 1, 'fake gh: pr diff answers --name-only only\n');
  finish((pr.files ?? []).map((f) => `${f.path}\n`).join(''));
}
if (group === 'pr' && command === 'create') {
  const number = state.next++;
  const now = new Date().toISOString();
  const pr = { number, title: opt('--title'), body: wantsStdin ? stdin : opt('--body') ?? '', state: 'OPEN', isDraft: argv.includes('--draft'), headRefName: opt('--head'), baseRefName: opt('--base'), createdAt: now, updatedAt: now, author: { login: 'owner' }, files: [], createdHere: true };
  state.prs.push(pr);
  finish(`${repoUrl(number)}\n`, 0, `Creating pull request for ${pr.headRefName} into ${pr.baseRefName} in ${state.repo}\n`);
}
if (group === 'pr' && command === 'edit') {
  const pr = byTarget(target);
  if (!pr) finish('', 1, `no pull requests found for ${target}\n`);
  if (wantsStdin) pr.body = stdin;
  if (opt('--title')) pr.title = opt('--title');
  pr.updatedAt = new Date().toISOString();
  finish(`${repoUrl(pr.number)}\n`);
}
if (group === 'pr' && command === 'ready') {
  const pr = byTarget(target);
  if (!pr) finish('', 1, `no pull requests found for ${target}\n`);
  pr.isDraft = false;
  finish(`Pull request #${pr.number} is marked as "ready for review"\n`);
}
finish('', 1, `fake gh: ${argv.slice(0, 2).join(' ') || '(nothing)'} is not available in this fixture\n`);
