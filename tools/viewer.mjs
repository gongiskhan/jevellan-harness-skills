#!/usr/bin/env node
// A read-only page over one project's ledger, for the owner to follow the coordinator's work from a browser: the open
// and recently finished tasks, each task's steps with their placements and reports, the landing decisions, the
// questions waiting on the owner, and the screenshots the steps saved under their evidence folders.
//
//   node tools/viewer.mjs --project <path> [--port 4460] [--host 127.0.0.1]
//
// It reads the ledger through the ledger skill's public script (status --json, show T --json), so the page shows what
// the skills see. It serves nothing but its own pages and image files under a task worktree's .jevellan/evidence/ or
// the project's .jevellan/; no log, no secret file, no write. Bind it to 127.0.0.1 and publish it on the tailnet with
// `tailscale serve` (never funnel): the reports can name files and commands of a private project.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { project: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, ledger: { type: 'string' } } });
if (!values.project) throw new Error('usage: node tools/viewer.mjs --project <path> [--port 4460] [--host 127.0.0.1] [--ledger <ledger.mjs>]');
const PROJECT = fs.realpathSync(values.project);
const PORT = Number(values.port ?? 4460);
const HOST = values.host ?? '127.0.0.1';
const LEDGER = values.ledger ?? path.join(REPO, 'skills', 'jevellan-ledger', 'scripts', 'ledger.mjs');
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

function ledger(args) {
  const r = spawnSync(process.execPath, [LEDGER, ...args, '--json'], { cwd: PROJECT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, JH_PROJECT: PROJECT } });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: (r.stderr || r.stdout || `exit ${r.status}`).trim() };
  }
}

// What a running step is doing now: the runtime skill's status script (its last log line, redacted by the runtime).
function liveLine(taskId, step, runtime) {
  const skill = runtime === 'codex' ? 'jevellan-runtime-codex' : 'jevellan-runtime-claude';
  const r = spawnSync(process.execPath, [path.join(REPO, 'skills', skill, 'scripts', 'status.mjs'), '--task', taskId, '--step', String(step), '--json'], { cwd: PROJECT, encoding: 'utf8', env: { ...process.env, JH_PROJECT: PROJECT }, timeout: 15000 });
  try {
    const j = JSON.parse(r.stdout);
    return `${j.state}${j.lastLine ? `: ${j.lastLine}` : ''}`;
  } catch {
    return null;
  }
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// A pull request link: only an https URL becomes a link; anything else is shown as text.
const prLink = (url) => (/^https:\/\/[^\s"'<>]+$/.test(String(url ?? '')) ? `<a href="${esc(url)}" rel="noreferrer" target="_blank">${esc(url)}</a>` : esc(url));
const time = (iso) => (iso ? esc(String(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z')) : '');
const STATE_CLASS = { 'waiting-owner': 'warn', running: 'run', landing: 'run', failed: 'bad', queued: 'idle', done: 'good', stopped: 'idle' };

function page(title, body, { refresh = 10 } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refresh}"><title>${esc(title)}</title><style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e3de;--good:#1f7a3f;--bad:#b3261e;--warn:#9a6700;--run:#1d4ed8;--idle:#6b6b66}
@media (prefers-color-scheme: dark){:root{--bg:#141413;--fg:#ececea;--muted:#a3a39d;--card:#1e1e1c;--line:#33332f;--good:#5cc98a;--bad:#f2867d;--warn:#e3b341;--run:#7aa2f7;--idle:#a3a39d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 60px}a{color:var(--run)}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.state{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:99px;border:1px solid currentColor;margin-right:6px}
.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.run{color:var(--run)}.idle{color:var(--idle)}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-top:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:top}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;font-size:13px;margin:6px 0}
.shots{display:flex;flex-wrap:wrap;gap:10px}.shots a{display:block;max-width:300px}.shots img{max-width:100%;border:1px solid var(--line);border-radius:6px}
code{font-size:13px}</style></head><body><main>${body}<p class="muted">Read-only view of ${esc(PROJECT)}. Refreshes every ${refresh} s.</p></main></body></html>`;
}

function stateBadge(state) {
  return `<span class="state ${STATE_CLASS[state] ?? 'idle'}">${esc(state)}</span>`;
}

function indexPage() {
  const status = ledger(['status']);
  if (status.error) return page('Ledger', `<h1>Ledger</h1><div class="card bad">${esc(status.error)}</div>`);
  const all = ledger(['events', '--kind', 'task.created']);
  const created = (all.events ?? []).slice().reverse();
  const open = new Set((status.tasks ?? []).map((t) => t.task));
  const rows = (status.tasks ?? []).map((t) => {
    const optionText = (o, i) => {
      const label = typeof o === 'string' ? o : o.label;
      const means = t.waiting?.meanings?.[label];
      return `${i + 1}) ${label}${means ? `: ${means}` : ''}${t.waiting?.recommended === label ? ' (recommended)' : ''}`;
    };
    const waiting = t.state === 'waiting-owner' && t.waiting?.question ? `<div class="warn">${esc(t.waiting.question)} ${esc((t.waiting.options ?? []).map(optionText).join('  '))}</div>` : '';
    return `<div class="card">${stateBadge(t.state)}<a href="/task/${esc(t.task)}"><strong>${esc(t.task)}</strong></a> ${esc(t.title)} <span class="muted">(${esc(t.kind)}${t.duty ? ` ${esc(t.duty)}` : ''})</span>${waiting}${t.next ? `<div class="muted">next: ${esc(t.next)}</div>` : ''}</div>`;
  }).join('') || '<p class="muted">No open tasks.</p>';
  const past = created.filter((e) => !open.has(e.task)).slice(0, 40).map((e) => `<tr><td><a href="/task/${esc(e.task)}">${esc(e.task)}</a></td><td>${esc(e.data?.title)}</td><td class="muted">${time(e.t)}</td></tr>`).join('');
  return page(`Ledger: ${path.basename(PROJECT)}`, `<h1>${esc(path.basename(PROJECT))}</h1><div class="muted">The coordinator's work in this project, from its ledger.</div>
<h2>Open</h2>${rows}<h2>Earlier tasks</h2>${past ? `<div class="card"><table>${past}</table></div>` : '<p class="muted">None.</p>'}`);
}

function evidenceOf(task) {
  const dirs = [];
  if (task.worktree?.path) dirs.push(path.join(task.worktree.path, '.jevellan', 'evidence'));
  const out = [];
  const walk = (dir, depth = 0) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && IMAGE.test(e.name)) out.push(full);
    }
  };
  dirs.forEach((d) => walk(d));
  return out.slice(0, 60);
}

function reportCard(event) {
  const d = event.data ?? {};
  const tests = d.testsRun ? `<div>tests: <code>${esc(d.testsRun.command)}</code> <span class="${d.testsRun.passed ? 'good' : 'bad'}">${d.testsRun.passed ? 'passed' : 'failed'}</span>${d.testsRun.summary ? ` <span class="muted">${esc(d.testsRun.summary)}</span>` : ''}</div>` : '';
  const files = d.changedFiles?.length ? `<div class="muted">changed: ${d.changedFiles.map((f) => `<code>${esc(f)}</code>`).join(', ')}</div>` : '';
  const question = d.question ? `<div class="warn">${esc(d.question)} ${esc((d.options ?? []).map((o, i) => `${i + 1}) ${typeof o === 'string' ? o : o.label}`).join('  '))}</div>` : '';
  return `<div class="card"><div>${stateBadge(d.status)}step ${esc(event.step)} report <span class="muted">${time(event.t)}${d.synthesized ? ', synthesized' : ''}</span></div>
<pre>${esc(d.summary)}</pre>${question}${tests}${files}${d.limitations ? `<div class="muted">limitations: ${esc(d.limitations)}</div>` : ''}</div>`;
}

const LINE = {
  'task.worktree': (d) => `worktree <code>${esc(d.branch)}</code>`,
  'task.workflow': (d) => `workflow: ${esc((d.steps ?? []).map((s) => `${s.ordinal} ${s.duty}${(d.skipped ?? []).includes(s.ordinal) ? ' (skipped)' : ''}`).join(', '))}`,
  'task.placed': (d) => `step ${esc(d.step)} placed on ${esc(d.model)} ${esc(d.effort)} via ${esc(d.provider)} <span class="muted">(${esc(d.source)})</span>`,
  'step.started': (d) => `started ${esc(d.duty)} on ${esc(d.runtime)}, ${esc(d.model)} ${esc(d.effort)}${d.resumed ? ', resumed' : ''}`,
  'step.message': (d) => `message from ${esc(d.direction)}: ${esc(d.text)}`,
  'step.done': () => 'done',
  'step.failed': (d) => `<span class="bad">failed: ${esc(d.reason)}</span>`,
  'step.retrying': (d) => `retry back to step ${esc(d.gotoOrdinal)}: ${esc(d.reason)}`,
  'step.lost': (d) => `<span class="bad">lost (pid ${esc(d.pid)} gone)</span>`,
  'step.stopped': (d) => `stopped: ${esc(d.reason)}`,
  'landing.decided': (d) => `landing route <strong>${esc(d.route)}</strong> <span class="muted">(${esc(d.source)})</span>: ${esc(d.reason)}`,
  'landing.checked': (d) => `check <code>${esc(d.command)}</code> <span class="${d.passed ? 'good' : 'bad'}">${d.passed ? 'passed' : 'failed'}</span>`,
  'task.landed': (d) =>
    d.pr
      ? `<span class="good">${d.merged ? 'pull request merged on GitHub' : 'pull request open for review'}: ${prLink(d.pr)} at <code>${esc(String(d.commit ?? '').slice(0, 12))}</code></span>`
      : `<span class="good">landed on ${esc(d.target)} at <code>${esc(String(d.commit ?? '').slice(0, 12))}</code> (${esc(d.method)})</span>`,
  'task.asked': (d) => `<span class="warn">asked the owner: ${esc(d.question)}</span>${d.recommended ? ` <span class="muted">recommended: ${esc(d.recommended)}</span>` : ''}${d.pr ? ` <span class="muted">draft:</span> ${prLink(d.pr)}` : ''}`,
  note: (d) => `note: ${esc(d.text)}`,
};

function taskPage(id) {
  if (!/^T[0-9A-Z]{6}$/.test(id)) return null;
  const t = ledger(['show', id]);
  if (t.error) return page(id, `<p><a href="/">All tasks</a></p><div class="card bad">${esc(t.error)}</div>`);
  const events = t.events ?? [];
  const lines = events.filter((e) => LINE[e.kind] && e.kind !== 'step.report').map((e) => `<tr><td class="muted">${time(e.t)}</td><td>${e.step ? `s${esc(e.step)}` : ''}</td><td>${LINE[e.kind](e.data ?? {})}</td></tr>`).join('');
  const reports = events.filter((e) => e.kind === 'step.report').map(reportCard).join('') || '<p class="muted">No report yet.</p>';
  const shots = evidenceOf(t).map((file) => `<a href="/file?path=${encodeURIComponent(file)}"><img src="/file?path=${encodeURIComponent(file)}" alt="${esc(path.basename(file))}" loading="lazy"><div class="muted">${esc(path.basename(file))}</div></a>`).join('');
  const runtimeOf = (ordinal) => [...events].reverse().find((e) => e.kind === 'step.started' && e.step === ordinal)?.data?.runtime;
  const steps = (t.steps ?? []).map((s) => {
    const live = s.state === 'running' ? liveLine(id, s.ordinal, runtimeOf(s.ordinal)) : null;
    return `<tr><td>${esc(s.ordinal)}</td><td>${esc(s.duty)}</td><td>${stateBadge(s.state)}</td><td>${esc([s.model, s.effort, s.provider && `via ${s.provider}`].filter(Boolean).join(' '))}${live ? `<div class="muted">now: ${esc(live)}</div>` : ''}</td></tr>`;
  }).join('');
  const brief = t.text ? `<details class="card"><summary>Brief</summary><pre>${esc(t.text)}</pre></details>` : '';
  return page(`${id} ${t.title}`, `<p><a href="/">All tasks</a></p><h1>${esc(id)} ${esc(t.title)}</h1><div>${stateBadge(t.state)}<span class="muted">${esc(t.kind)}${t.duty ? ` ${esc(t.duty)}` : ''}${t.reason ? `: ${esc(t.reason)}` : ''}</span></div>${t.landedPr ? `<div class="card good">Pull request: ${prLink(t.landedPr)}</div>` : ''}${brief}
<h2>Steps</h2>${steps ? `<div class="card"><table>${steps}</table></div>` : '<p class="muted">No steps yet.</p>'}
<h2>Reports</h2>${reports}${shots ? `<h2>Screenshots</h2><div class="shots">${shots}</div>` : ''}
<h2>Timeline</h2><div class="card"><table>${lines}</table></div>`);
}

// Only images under the project's .jevellan folder or a task worktree's .jevellan/evidence folder, by real path.
function allowedFile(file) {
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return null;
  }
  if (!IMAGE.test(real)) return null;
  const inside = (dir) => real.startsWith(`${dir}${path.sep}`);
  if (inside(path.join(PROJECT, '.jevellan'))) return real;
  return /\/\.jevellan\/evidence\//.test(real) && real.includes(`${path.sep}worktrees${path.sep}`) ? real : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://viewer');
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };
  try {
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', indexPage());
    if (url.pathname.startsWith('/task/')) {
      const html = taskPage(url.pathname.slice('/task/'.length));
      return html ? send(200, 'text/html; charset=utf-8', html) : send(404, 'text/plain', 'not found');
    }
    if (url.pathname === '/file') {
      const file = allowedFile(url.searchParams.get('path') ?? '');
      if (!file) return send(404, 'text/plain', 'not found');
      const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(file).toLowerCase()];
      return send(200, type, fs.readFileSync(file));
    }
    return send(404, 'text/plain', 'not found');
  } catch (error) {
    return send(500, 'text/plain', `error: ${error.message}`);
  }
});
server.listen(PORT, HOST, () => process.stdout.write(`viewer for ${PROJECT} on http://${HOST}:${PORT}/\n`));
