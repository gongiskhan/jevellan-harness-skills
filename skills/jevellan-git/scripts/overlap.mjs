#!/usr/bin/env node
// The overlap check: has the work this task is about already been done, or is it being done, somewhere else?
//
//   node overlap.mjs --task T [--checkpoint intake|step|landing] [--days N] [--json]
//
// It gathers, for the coordinator to judge (it decides nothing itself beyond "nothing related" or "look at these"):
//   - the commits on the default branch: after `git fetch origin` (when there is an origin) the default branch is
//     origin/<defaultBranch>, else the local one. The first check of a task lists the last N days (7); a later one
//     only the commits since the head the previous check saw;
//   - the pull requests (gh, when origin names a GitHub repository): open ones, and the ones merged in the last N days;
//     a later check only those opened, updated or merged since the previous check. The task's own pull request is
//     left out;
//   - the project's other open tasks (the ledger skill's status).
// Each item is related when it touches a path the task names (the brief's file paths, plan.md's scope block, the files
// the task branch changed) or when its title shares most of its words with the task's title and brief. The verdict is
// "none" (nothing related) or "possible" (related items listed). Every check is recorded as a note on the task with the
// related items (number, commit, title, files), so the next check knows where this one stopped.
//
// Exit 0 with the result; 2 refused (no such task's worktree, git failing); 3 no such task. gh missing or failing is
// not a refusal: the result says gh was not available and why, and the git and ledger parts still run.

import fs from 'node:fs';
import path from 'node:path';
import { appendLine, callLedger } from './lib/ledger-client.mjs';
import { ghClient, runGh } from './lib/gh.mjs';
import { pathMatches, scopeBlock } from './lib/scope.mjs';
import { ownerHome } from './lib/project.mjs';
import {
  GitSkillError,
  defaultBranch,
  firstLine,
  git,
  gitEnv,
  isAncestor,
  isMain,
  lastWorktree,
  parse,
  print,
  readProjectConfig,
  remotes,
  requireRoot,
  requireTask,
  resolveRef,
  runCli,
} from './worktree.mjs';

export const CHECKPOINTS = Object.freeze(['intake', 'step', 'landing']);
export const DEFAULT_DAYS = 7;
const MAX_COMMITS = 200;
const MAX_ITEMS = 20;
const TEXT_RELATED = 0.5;
const FIELDS_OPEN = 'number,title,body,headRefName,files,url,createdAt,updatedAt,isDraft,author';
const FIELDS_MERGED = 'number,title,body,headRefName,files,url,createdAt,updatedAt,mergedAt,mergeCommit,author';

// ---- words and paths ----------------------------------------------------------------------------------------------

const STOP = new Set('the and for with from that this into when then than what which while where will would should could have has had been being them they their there these those your yours ours about after before over under only also each every both some more most other such very just make made does done not but can are was were its our out off per via upon como para pela pelo pelos pelas uma umas uns com sem que dos das nos nas mais menos sobre entre quando onde este esta isto esse essa isso aquele aquela'.split(' '));

// The words of a text as stems: lower case, accents off, words of four letters or more, a plural or past ending off.
export function terms(text) {
  const out = new Set();
  for (const raw of String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(raw.replace(/(ings?|ed|es|s)$/, '').replace(/e$/, '') || raw);
  }
  return out;
}

// How much of an item's title is in the task's words: shared / min(both), and how many are shared.
export function textOverlap(taskTerms, title) {
  const item = terms(title);
  if (!item.size || !taskTerms.size) return { score: 0, shared: [] };
  const shared = [...item].filter((t) => taskTerms.has(t));
  return { score: shared.length / Math.min(item.size, taskTerms.size), shared };
}

// File paths a brief names: words with a slash or a dot extension that look like repository paths.
export function namedPaths(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/(?:^|[\s`'"(\[])((?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9]{1,6})+|(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@*-]*)(?=$|[\s`'",.;:)\]])/g)) {
    const p = m[1].replace(/[.,;:]+$/, '');
    if (p.includes('://') || /^\d/.test(p) || p.length < 4) continue;
    if (!p.includes('/') && !/\.(m?[jt]sx?|json|md|css|html|py|go|rb|sql|ya?ml|toml|sh)$/i.test(p)) continue;
    out.add(p.replace(/^\.\//, '').replace(/\/$/, ''));
  }
  return [...out];
}

// The item's files that touch one of the task's paths: the same file, a file under a named folder or pattern, or a
// task path under one of the item's folders.
export function filesOverlap(itemFiles, taskPaths) {
  const hits = new Set();
  for (const file of itemFiles) {
    for (const p of taskPaths) {
      if (file === p || pathMatches(file, p) || (/[*?]/.test(p) === false && file.startsWith(`${p}/`))) hits.add(file);
      else if (!/\./.test(path.basename(p)) && p && file.startsWith(`${p.replace(/\/$/, '')}/`)) hits.add(file);
      else if (path.basename(file) === path.basename(p) && path.basename(p).includes('.') && (file.endsWith(`/${p}`) || p.endsWith(`/${file}`))) hits.add(file);
    }
  }
  return [...hits];
}

// ---- the parts ----------------------------------------------------------------------------------------------------

// Where the last check stopped. A landing check that found overlap is not a place to stop: the owner may never have
// been asked (the landing failed after it), so the next check looks at the same items again.
function previousCheck(info) {
  for (let i = info.events.length - 1; i >= 0; i -= 1) {
    const e = info.events[i];
    const o = e.kind === 'note' ? e.data?.overlap : null;
    if (!o?.originHead) continue;
    if (o.checkpoint === 'landing' && o.verdict === 'possible') continue;
    return o;
  }
  return null;
}

function commitsOf(root, args) {
  const r = git(root, ['log', '--no-merges', `--max-count=${MAX_COMMITS}`, '--format=%x1e%H%x1f%cI%x1f%s', '--name-only', ...args], { permitted: [0, 128] });
  if (r.code !== 0) return [];
  return r.stdout.split('\x1e').filter((x) => x.trim()).map((chunk) => {
    const [head, ...rest] = chunk.split('\n');
    const [commit, date, subject] = head.split('\x1f');
    return { commit, date, subject, files: rest.map((l) => l.trim()).filter(Boolean) };
  });
}

function ghList(gh, cwd, args) {
  const out = runGh(gh, cwd, ['pr', 'list', ...args]);
  const list = JSON.parse(out);
  if (!Array.isArray(list)) throw new GitSkillError('gh pr list printed no list');
  return list;
}

function prFiles(pr) {
  return (Array.isArray(pr.files) ? pr.files : []).map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean);
}

function firstLines(text, n = 3) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n).join(' ').slice(0, 400);
}

// ---- the check ----------------------------------------------------------------------------------------------------

export function checkOverlap(root, taskId, { checkpoint = 'intake', days = DEFAULT_DAYS, now = new Date(), record = true } = {}) {
  if (!CHECKPOINTS.includes(checkpoint)) throw new GitSkillError(`--checkpoint must be one of ${CHECKPOINTS.join(', ')}`);
  const info = requireTask(root, taskId);
  const created = info.created?.data ?? {};
  const config = readProjectConfig(root);
  const into = defaultBranch(root, config);
  const wt = lastWorktree(info);
  const hasOrigin = remotes(root).includes('origin');
  let fetched = null;
  if (hasOrigin) {
    const r = git(root, ['fetch', '--quiet', '--no-prune', 'origin'], { permitted: [0, 1, 128], timeoutMs: 180000, env: gitEnv({ HOME: ownerHome() }) });
    fetched = r.code === 0 ? true : `git fetch origin failed: ${firstLine(r.stderr) || `exit ${r.code}`}`;
  }
  const baseRef = hasOrigin && resolveRef(root, `refs/remotes/origin/${into}`) ? `refs/remotes/origin/${into}` : `refs/heads/${into}`;
  const base = baseRef.replace(/^refs\/(remotes|heads)\//, '');
  const head = resolveRef(root, baseRef);
  if (!head) throw new GitSkillError(`${base} does not exist; check project.json's defaultBranch`);
  const previous = previousCheck(info);
  const sinceHead = previous?.originHead && previous.originHead !== head && isAncestor(root, previous.originHead, head) ? previous.originHead : null;
  // A later checkpoint with no earlier check looks at what arrived after the task's branch started (its commits are
  // the base the task built on, not overlap).
  const branchStart = !previous && checkpoint !== 'intake' && wt?.branch && resolveRef(root, `refs/heads/${wt.branch}`) ? `refs/heads/${wt.branch}` : null;
  const sinceTime = previous?.checkedAt ?? (branchStart ? info.events.find((e) => e.kind === 'task.worktree')?.t ?? null : null);
  const fresh = previous && previous.originHead === head;
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString();

  // What the task is about: its words, and the paths it names, plans or changed.
  const taskTerms = terms(`${created.title ?? ''}\n${String(created.text ?? '').slice(0, 6000)}`);
  const titleTerms = terms(created.title ?? '');
  const plan = wt?.path && fs.existsSync(path.join(wt.path, 'plan.md')) ? fs.readFileSync(path.join(wt.path, 'plan.md'), 'utf8') : null;
  const scope = scopeBlock(plan) ?? [];
  let branchFiles = [];
  if (wt?.branch && resolveRef(root, `refs/heads/${wt.branch}`)) {
    const r = git(root, ['diff', '--name-only', `${baseRef}...refs/heads/${wt.branch}`], { permitted: [0, 128] });
    if (r.code === 0) branchFiles = r.stdout.split('\n').filter(Boolean);
  }
  const taskPaths = [...new Set([...namedPaths(created.text), ...scope, ...branchFiles])];
  const relate = (title, files) => {
    const text = textOverlap(taskTerms, title);
    const strongTitle = textOverlap(titleTerms, title);
    const touched = filesOverlap(files, taskPaths);
    const related = touched.length > 0 || (text.score >= TEXT_RELATED && text.shared.length >= 2) || (strongTitle.score >= TEXT_RELATED && strongTitle.shared.length >= 2);
    const textRelated = (text.score >= TEXT_RELATED && text.shared.length >= 2) || (strongTitle.score >= TEXT_RELATED && strongTitle.shared.length >= 2);
    return { related, textRelated, filesOverlap: touched.slice(0, 20), words: text.shared.slice(0, 12), textScore: Number(text.score.toFixed(2)) };
  };

  // Commits on the default branch: since the previous check's head, or the last `days` days.
  const commitList = fresh ? [] : commitsOf(root, sinceHead ? [`${sinceHead}..${baseRef}`] : branchStart ? [`${branchStart}..${baseRef}`] : [`--since=${cutoff}`, baseRef]);
  const ownCommits = new Set(wt?.branch ? git(root, ['rev-list', `--max-count=500`, `${baseRef}..refs/heads/${wt.branch}`], { permitted: [0, 128] }).stdout.split('\n').filter(Boolean) : []);

  // Pull requests.
  const gh = { available: false, reason: null };
  let prs = [];
  try {
    const client = ghClient(root);
    const open = ghList(client, root, ['--state', 'open', '--limit', '50', '--json', FIELDS_OPEN]);
    const merged = ghList(client, root, ['--state', 'merged', '--limit', '50', '--search', `merged:>=${cutoff.slice(0, 10)}`, '--json', FIELDS_MERGED]);
    gh.available = true;
    prs = [...open.map((p) => ({ ...p, state: 'OPEN' })), ...merged.map((p) => ({ ...p, state: 'MERGED' }))]
      .filter((p) => !wt?.branch || p.headRefName !== wt.branch)
      .filter((p) => (p.state === 'MERGED' ? !p.mergedAt || p.mergedAt >= cutoff : true))
      .filter((p) => !sinceTime || (p.state === 'MERGED' ? (p.mergedAt ?? '') > sinceTime : (p.updatedAt ?? p.createdAt ?? '') > sinceTime));
  } catch (error) {
    gh.reason = error.message;
  }
  const mergeCommits = new Map(prs.filter((p) => p.mergeCommit?.oid).map((p) => [p.mergeCommit.oid, p.number]));

  const items = [];
  for (const p of prs) {
    const files = prFiles(p);
    items.push({ kind: p.state === 'OPEN' ? 'open-pr' : 'merged-pr', number: p.number, title: p.title, url: p.url ?? null, branch: p.headRefName ?? null, author: p.author?.login ?? null, at: p.state === 'OPEN' ? p.updatedAt ?? p.createdAt ?? null : p.mergedAt ?? null, commit: p.mergeCommit?.oid ?? null, draft: p.isDraft ?? undefined, body: firstLines(p.body), files: files.slice(0, 30), ...relate(p.title, files) });
  }
  const newCommits = [];
  for (const c of commitList) {
    if (ownCommits.has(c.commit)) continue;
    const pr = mergeCommits.get(c.commit) ?? Number(/\(#(\d+)\)\s*$/.exec(c.subject)?.[1]) ?? null;
    const rel = relate(c.subject, c.files);
    newCommits.push({ commit: c.commit, date: c.date, subject: c.subject, files: c.files.slice(0, 30), pr: Number.isFinite(pr) ? pr : null, related: rel.related });
    if (Number.isFinite(pr) && items.some((i) => i.number === pr)) {
      const item = items.find((i) => i.number === pr);
      item.commit = item.commit ?? c.commit;
      continue;
    }
    items.push({ kind: 'commit', number: Number.isFinite(pr) ? pr : null, commit: c.commit, title: c.subject, at: c.date, files: c.files.slice(0, 30), ...rel });
  }

  // The project's other open tasks.
  try {
    const status = callLedger(['status'], { cwd: root });
    for (const t of status.tasks ?? []) {
      if (t.task === taskId) continue;
      const rel = relate(t.title, []);
      items.push({ kind: 'task', task: t.task, title: t.title, state: t.state, files: [], ...rel });
    }
  } catch {}

  const related = items.filter((i) => i.related).sort((a, b) => b.filesOverlap.length - a.filesOverlap.length || b.textScore - a.textScore).slice(0, MAX_ITEMS);
  const verdict = related.length ? 'possible' : 'none';
  const result = {
    task: taskId,
    checkpoint,
    verdict,
    base,
    originHead: head,
    since: sinceHead ?? (fresh ? head : null),
    checkedAt: now.toISOString(),
    fetched,
    paths: taskPaths.slice(0, 50),
    items: related,
    newCommits: newCommits.slice(0, 50),
    looked: { commits: commitList.length, pullRequests: prs.length, tasks: items.filter((i) => i.kind === 'task').length },
    gh,
  };
  if (record) result.recorded = recordOverlap(root, taskId, result).seq;
  return result;
}

// Records a check as a note on the task: the verdict, where it stopped (the default branch's head, the time) and the
// related items with their numbers, commits, titles and files.
export function recordOverlap(root, taskId, result) {
  const related = result.items;
  const names = related.map((i) => (i.kind === 'task' ? `${i.task} (${i.title})` : `${i.number ? `#${i.number} ` : ''}${i.commit ? `${i.commit.slice(0, 9)} ` : ''}${i.kind === 'open-pr' ? '(open) ' : ''}${i.title}`));
  const text = `Overlap check (${result.checkpoint}) against ${result.base} at ${result.originHead.slice(0, 9)}: ${result.verdict === 'none' ? 'nothing related' : `look at ${names.join('; ')}`}`.slice(0, 2000);
  const items = related.map(({ body, words, ...rest }) => ({ ...rest, files: (rest.files ?? []).slice(0, 10) }));
  return appendLine(root, 'note', { task: taskId, command: 'append', data: { text, overlap: { checkpoint: result.checkpoint, verdict: result.verdict, base: result.base, originHead: result.originHead, checkedAt: result.checkedAt, items, newCommits: result.newCommits.length, gh: result.gh.available } } });
}

function render(r) {
  const lines = [`Overlap check (${r.checkpoint}) of ${r.task} against ${r.base} at ${r.originHead.slice(0, 9)}: ${r.verdict === 'none' ? 'nothing related' : `${r.items.length} related item(s)`}.`];
  for (const i of r.items) {
    const what = i.kind === 'task' ? `task ${i.task} (${i.state})` : `${i.kind}${i.number ? ` #${i.number}` : ''}${i.commit ? ` ${i.commit.slice(0, 9)}` : ''}`;
    lines.push(`- ${what}: ${i.title}${i.filesOverlap.length ? ` | same files: ${i.filesOverlap.slice(0, 5).join(', ')}` : ''}${i.words.length ? ` | words: ${i.words.slice(0, 6).join(', ')}` : ''}${i.url ? ` | ${i.url}` : ''}`);
  }
  if (!r.gh.available) lines.push(`(pull requests not checked: ${r.gh.reason})`);
  if (r.fetched && r.fetched !== true) lines.push(`(${r.fetched}; checked what was already fetched)`);
  return lines.join('\n');
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: overlap.mjs --task T [--checkpoint intake|step|landing] [--days N] [--json]\n');
    return 0;
  }
  const { values } = parse(argv, { task: { type: 'string' }, checkpoint: { type: 'string' }, days: { type: 'string' }, json: { type: 'boolean' } });
  const days = values.days === undefined ? DEFAULT_DAYS : Number(values.days);
  if (!(Number.isInteger(days) && days > 0 && days <= 60)) throw new GitSkillError('--days must be a whole number from 1 to 60');
  const root = requireRoot();
  const result = checkOverlap(root, values.task, { checkpoint: values.checkpoint ?? 'intake', days });
  print(values.json, result, render(result));
  return 0;
}

if (isMain(import.meta.url)) runCli(main);
