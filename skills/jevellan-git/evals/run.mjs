#!/usr/bin/env node
// The evals of the landing policy in this skill's SKILL.md (brief 5.2 and 5.5), ported from the skills repo's
// evals.ts and its landing evals/run.mjs, reading decisions from project ledgers instead of a table:
//
//   node evals/run.mjs [--cases FILE] [--split held-out|dev|all] [--results FILE] [--json]
//   node evals/run.mjs --export [--project DIR]... [--cases FILE] [--json]
//
// A case: {id, kind: "landing", state, questions, expected: {landing_route: <route>} | null, source, decisionId, split}.
//
// Replay (the default): the policy is the SKILL.md next to this folder, as it is now. Each case's question is
// rebuilt from it (instructions from "## landing_route", criteria from "## routes") and its state.rules is replaced
// by the current "## rules", then Jev answers with the key providers.json names (real calls). A case whose expected
// route the policy no longer has, or whose state is over the size limit, is stale; a case with expected null is
// unlabelled; neither is scored. Agreement is counted per split; evals/RESULTS.md (or --results) records the policy
// hash, the date, the table and every disagreement with Jev's probabilities. Exit 0, 1 when held-out agreement is
// below threshold.json {"heldOut": 0..1} (0.6 when the file is missing), 2 when the run cannot be made (no Jev key, a
// Jev failure, an invalid cases file).
//
// Export (--export): every landing.decided line with source "jev" and a decisionFile, in the ledger of each --project
// (default: the project of the working folder), becomes a case from its decision file. Its label is the outcome:
// - success (expected = Jev's route, source outcome): task.landed follows before any later landing decision, so a
//   land or verify-then-land route that landed;
// - failure (expected null, source failed, for a person to label): a landing check failed after it, or the extra
//   verify step of a verify-then-land failed;
// - skipped: an owner decision (source owner, nothing to replay), a decision file that cannot be read, one still
//   pending, or one a later decision replaced or the owner stopped (an ask-owner the owner answered "Land now" or
//   "Leave it" has no outcome of its own, the skills run's D-049).
// Every fifth decision by time is held-out, the rest dev; the position counts every readable decision, so a decision
// keeps its split across exports. Merge rules: hand cases are kept; an exported case replaces the case with the same
// decisionId; a person's label on an unlabelled case survives a re-export that is still unlabelled.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitSkillError, isMain, ledgerRole, parse, print, runCli } from '../scripts/worktree.mjs';
import { LANDING_QUESTION, STATE_LIMIT, landingPolicy, landingQuestions, placementRole, resolveChoice } from '../scripts/land.mjs';

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(EVALS_DIR);
const CASES_FILE = path.join(EVALS_DIR, 'cases.json');
const THRESHOLD_FILE = path.join(EVALS_DIR, 'threshold.json');
const RESULTS_FILE = path.join(EVALS_DIR, 'RESULTS.md');
const CASE_SOURCES = ['override', 'outcome', 'hand', 'failed'];
const SPLITS = ['dev', 'held-out'];
const USAGE = `node evals/run.mjs [--cases FILE] [--split held-out|dev|all] [--results FILE] [--json]
node evals/run.mjs --export [--project DIR]... [--cases FILE] [--json]`;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function skillName() {
  try {
    const text = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const m = /^name:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '');
    if (m) return m[1];
  } catch {}
  return path.basename(SKILL_DIR);
}

// Every fifth case (positions 5, 10, ...) is held out.
export function splitAt(index) {
  return (index + 1) % 5 === 0 ? 'held-out' : 'dev';
}

// ---- the cases file ------------------------------------------------------------------------------------------

function caseProblem(c) {
  if (!isObject(c)) return 'is not an object';
  if (typeof c.id !== 'string' || c.id === '') return 'has no id';
  if (c.kind !== 'landing') return `has kind ${String(c.kind)} (this policy replays landing cases)`;
  if (!isObject(c.state)) return 'has no state object';
  if (!isObject(c.questions)) return 'has no questions object';
  if (c.expected !== null && !isObject(c.expected)) return 'has an expected that is neither an object nor null';
  if (!CASE_SOURCES.includes(c.source)) return `has source ${String(c.source)}`;
  if (!SPLITS.includes(c.split)) return `has split ${String(c.split)} (dev or held-out)`;
  return undefined;
}

// Reads a cases file ({skill, cases} or a bare list). Missing is an empty list when `missingOk`; invalid is exit 2.
export function readCasesFile(file, { missingOk = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (missingOk && error.code === 'ENOENT') return { skill: skillName(), cases: [] };
    throw new GitSkillError(`cannot read the cases file ${file}: ${error.code ?? error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new GitSkillError(`${file} is not valid JSON: ${error.message}`);
  }
  const list = Array.isArray(raw) ? raw : isObject(raw) ? raw.cases : undefined;
  if (!Array.isArray(list)) throw new GitSkillError(`${file} has no "cases" list`);
  const ids = new Set();
  list.forEach((c, i) => {
    const problem = caseProblem(c);
    if (problem) throw new GitSkillError(`${file}: case ${i + 1} ${problem}`);
    if (ids.has(c.id)) throw new GitSkillError(`${file}: the case id ${c.id} is used twice`);
    ids.add(c.id);
  });
  return { skill: isObject(raw) && typeof raw.skill === 'string' ? raw.skill : skillName(), cases: list };
}

function writeCasesFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function readThreshold(file = THRESHOLD_FILE) {
  if (!fs.existsSync(file)) return 0.6;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  const value = isObject(raw) ? raw.heldOut : undefined;
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new GitSkillError(`${file} needs {"heldOut": <number 0..1>}`);
  return value;
}

// ---- export --------------------------------------------------------------------------------------------------

// How the landing a decision chose ended (see the header).
export function verdictOf(info, decided) {
  const after = info.events.filter((e) => e.seq > decided.seq);
  const next = after.findIndex((e) => e.kind === 'landing.decided');
  const window = next < 0 ? after : after.slice(0, next);
  if (window.some((e) => e.kind === 'task.landed')) return 'success';
  if (window.some((e) => e.kind === 'landing.checked' && e.data?.passed === false)) return 'failure';
  if (decided.data?.route === 'verify-then-land') {
    const verify = new Set(window.filter((e) => e.kind === 'step.started' && e.data?.duty === 'verify').map((e) => e.step));
    const failed = window.some(
      (e) => verify.has(e.step) && (['step.failed', 'step.lost', 'step.retrying'].includes(e.kind) || (e.kind === 'step.report' && e.data?.testsRun?.passed === false)),
    );
    if (failed) return 'failure';
  }
  if (next >= 0 || window.some((e) => e.kind === 'step.stopped')) return 'stopped';
  return 'pending';
}

function readDecision(root, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  try {
    const decision = JSON.parse(fs.readFileSync(path.resolve(root, rel), 'utf8'));
    if (!isObject(decision) || typeof decision.id !== 'string' || !isObject(decision.state) || !isObject(decision.questions)) return null;
    if (!isObject(decision.questions[LANDING_QUESTION])) return null;
    return decision;
  } catch {
    return null;
  }
}

export async function exportCases(projects) {
  const L = await ledgerRole();
  const roots = [];
  for (const dir of projects.length ? projects : [process.cwd()]) {
    const root = L.project.gitLocate(path.resolve(dir))?.root;
    if (!root) throw new GitSkillError(`${path.resolve(dir)} is not inside a git repository`, 3);
    if (!roots.includes(root)) roots.push(root);
  }
  const skipped = { owner: 0, unreadable: 0, pending: 0, stopped: 0 };
  const warnings = [];
  const found = [];
  for (const root of roots) {
    if (!L.ledger.ledgerExists(root)) {
      warnings.push(`${root} has no ledger`);
      continue;
    }
    const { events } = L.ledger.readEvents(root);
    for (const info of L.ledger.groupByTask(events).values()) {
      for (const event of info.events) {
        if (event.kind !== 'landing.decided') continue;
        if (event.data?.source !== 'jev') {
          skipped.owner += 1;
          continue;
        }
        const decision = readDecision(root, event.data?.decisionFile);
        if (!decision) {
          skipped.unreadable += 1;
          continue;
        }
        found.push({ root, info, event, decision });
      }
    }
  }
  found.sort((a, b) => a.event.t.localeCompare(b.event.t) || a.decision.id.localeCompare(b.decision.id));
  const cases = [];
  found.forEach((f, index) => {
    const split = splitAt(index);
    const verdict = verdictOf(f.info, f.event);
    if (verdict === 'pending' || verdict === 'stopped') {
      skipped[verdict] += 1;
      return;
    }
    const base = { id: f.decision.id, kind: 'landing', state: f.decision.state, questions: f.decision.questions, decisionId: f.decision.id, split };
    if (verdict === 'failure') cases.push({ ...base, expected: null, source: 'failed' });
    else cases.push({ ...base, expected: { [LANDING_QUESTION]: f.decision.chosen?.route ?? f.event.data.route }, source: 'outcome' });
  });
  return { cases, skipped, warnings, projects: roots };
}

// Merges exported cases into the cases already in the file (see the header).
export function mergeCases(existing, exported) {
  const fresh = new Map(exported.filter((c) => c.decisionId).map((c) => [c.decisionId, c]));
  const out = [];
  const placed = new Set();
  for (const c of existing) {
    const next = c.source !== 'hand' && c.decisionId ? fresh.get(c.decisionId) : undefined;
    if (!next) {
      out.push(c);
      continue;
    }
    placed.add(next.decisionId);
    if (next.expected === null && c.expected !== null) out.push({ ...next, expected: c.expected, ...(c.note ? { note: c.note } : {}) });
    else out.push(c.note ? { ...next, note: c.note } : next);
  }
  for (const c of exported) if (!c.decisionId || !placed.has(c.decisionId)) out.push(c);
  return out;
}

// ---- replay --------------------------------------------------------------------------------------------------

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return out;
}

export async function runEvals({ casesFile = CASES_FILE, split = 'all', thresholdFile = THRESHOLD_FILE, concurrency = 4, now = new Date() } = {}) {
  const P = await placementRole();
  const lp = landingPolicy(P.policy);
  const threshold = readThreshold(thresholdFile);
  const all = readCasesFile(casesFile).cases;
  const cases = split === 'all' ? all : all.filter((c) => c.split === split);
  const config = P.providers.loadProviders();
  const client = P.jev.jevClient(config.jev, { home: config.ownerHome });
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
  const answeredBy = new Set();

  const replay = async (c) => {
    const base = { id: c.id, split: c.split, source: c.source };
    if (c.expected === null) return { ...base, status: 'unlabelled', results: [] };
    const expected = c.expected[LANDING_QUESTION];
    if (typeof expected !== 'string') return { ...base, status: 'stale', reason: `no expected ${LANDING_QUESTION}`, results: [] };
    if (!lp.routes.has(expected)) return { ...base, status: 'stale', reason: `the policy has no route ${expected}`, results: [] };
    const state = JSON.stringify({ ...structuredClone(c.state), rules: lp.rules });
    if (state.length > STATE_LIMIT) return { ...base, status: 'stale', reason: `the state is over ${STATE_LIMIT} characters`, results: [] };
    const questions = landingQuestions(lp);
    let response;
    try {
      response = await client.decide({ model: config.jev.model, state, questions });
    } catch (error) {
      if (error instanceof P.jev.JevError) throw new GitSkillError(`${P.jev.jevMessage(error)} (case ${c.id})`);
      throw error;
    }
    usage.calls += 1;
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    answeredBy.add(response.model);
    const { option, probabilities } = resolveChoice(questions[LANDING_QUESTION], response.answers[LANDING_QUESTION]);
    return { ...base, status: 'scored', results: [{ question: LANDING_QUESTION, expected, got: option, agree: option === expected, probabilities }] };
  };
  const results = await pool(cases, concurrency, replay);

  const agreement = {};
  const tally = (q, s, agree) => {
    agreement[q] ??= { dev: { agreed: 0, total: 0 }, 'held-out': { agreed: 0, total: 0 }, all: { agreed: 0, total: 0 } };
    agreement[q][s].total += 1;
    if (agree) agreement[q][s].agreed += 1;
  };
  for (const r of results) {
    for (const q of r.results) {
      for (const key of [q.question, 'all']) {
        tally(key, r.split, q.agree);
        tally(key, 'all', q.agree);
      }
    }
  }
  const held = agreement.all?.['held-out'];
  const rate = held && held.total ? held.agreed / held.total : null;
  return {
    skill: skillName(),
    hash: lp.policy.hash,
    date: now.toISOString(),
    casesFile,
    split,
    jevModel: config.jev.model,
    answeredBy: [...answeredBy],
    cases: results,
    agreement,
    threshold,
    heldOut: { rate, pass: rate === null ? null : rate >= threshold },
    usage,
  };
}

// ---- reporting -----------------------------------------------------------------------------------------------

function pct(t) {
  if (!t || t.total === 0) return '-';
  return `${t.agreed}/${t.total} (${Math.round((t.agreed / t.total) * 100)}%)`;
}

function topProbabilities(p, n = 4) {
  return Object.entries(p)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(', ');
}

function questionOrder(run) {
  const ids = Object.keys(run.agreement).filter((q) => q !== 'all').sort();
  return [...ids, ...(run.agreement.all ? ['all'] : [])];
}

function disagreements(run) {
  return run.cases.flatMap((c) =>
    c.results
      .filter((r) => !r.agree)
      .map((r) => `${c.id} (${c.split}, ${c.source}) ${r.question}: expected ${String(r.expected)}, Jev ${String(r.got)} [${topProbabilities(r.probabilities)}]`),
  );
}

function verdictLine(run) {
  if (run.heldOut.rate === null) return `Held-out agreement: no held-out case scored (threshold ${Math.round(run.threshold * 100)}%)`;
  return `Held-out agreement: ${Math.round(run.heldOut.rate * 100)}% (threshold ${Math.round(run.threshold * 100)}%): ${run.heldOut.pass ? 'pass' : 'FAIL'}`;
}

function counts(run) {
  const n = (s) => run.cases.filter((c) => c.status === s).length;
  return `${run.cases.length} cases (${n('scored')} scored, ${n('unlabelled')} unlabelled, ${n('stale')} stale), split ${run.split}`;
}

export function formatRun(run) {
  const lines = [`${run.skill} ${run.hash.slice(0, 12)}: ${counts(run)}`, ''];
  const rows = questionOrder(run).map((q) => [q === 'all' ? 'all questions' : q, pct(run.agreement[q]?.dev), pct(run.agreement[q]?.['held-out']), pct(run.agreement[q]?.all)]);
  const table = [['question', 'dev', 'held-out', 'all'], ...rows];
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
  for (const r of table) lines.push(`  ${r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()}`);
  const dis = disagreements(run);
  lines.push('', dis.length ? 'Disagreements:' : 'Disagreements: none');
  for (const d of dis) lines.push(`  ${d}`);
  const unlabelled = run.cases.filter((c) => c.status === 'unlabelled');
  if (unlabelled.length) lines.push('', `Unlabelled (not scored; set "expected" to label): ${unlabelled.map((c) => c.id).join(', ')}`);
  const stale = run.cases.filter((c) => c.status === 'stale');
  if (stale.length) {
    lines.push('', 'Stale (the current policy cannot ask them; not scored):');
    for (const c of stale) lines.push(`  ${c.id}: ${c.reason}`);
  }
  lines.push('', verdictLine(run));
  // Machine-readable lines for Skillio's runner contract: "<split> agreement: <n>%" per split, then the bare
  // "agreement:" line for the split this run was asked for.
  const rate = (t) => (t && t.total ? `${Math.round((t.agreed / t.total) * 100)}%` : 'n/a');
  const overall = run.agreement.all;
  lines.push(`held-out agreement: ${rate(overall?.['held-out'])}`, `tuning agreement: ${rate(overall?.dev)}`, `all agreement: ${rate(overall?.all)}`);
  lines.push(`agreement: ${rate(run.split === 'dev' ? overall?.dev : run.split === 'held-out' ? overall?.['held-out'] : overall?.all)}`);
  return lines.join('\n');
}

export function resultsMarkdown(run, relativeTo) {
  const casesFile = relativeTo ? path.relative(relativeTo, run.casesFile) || run.casesFile : run.casesFile;
  const lines = [
    `# Eval results: ${run.skill}`,
    '',
    `- Date: ${run.date}`,
    `- Policy hash: \`${run.hash}\``,
    `- Cases: ${counts(run)} from \`${casesFile}\``,
    `- Jev: ${run.jevModel}${run.answeredBy.length ? ` (answered by ${run.answeredBy.join(', ')})` : ''}, ${run.usage.calls} calls, ${run.usage.input_tokens} input and ${run.usage.output_tokens} output tokens`,
    `- ${verdictLine(run)}`,
    '',
    '## Agreement',
    '',
    '| question | dev | held-out | all |',
    '| --- | --- | --- | --- |',
    ...questionOrder(run).map((q) => `| ${q === 'all' ? '**all questions**' : q} | ${pct(run.agreement[q]?.dev)} | ${pct(run.agreement[q]?.['held-out'])} | ${pct(run.agreement[q]?.all)} |`),
    '',
    '## Disagreements',
    '',
  ];
  const dis = disagreements(run);
  lines.push(...(dis.length ? dis.map((d) => `- ${d}`) : ['None.']));
  const unlabelled = run.cases.filter((c) => c.status === 'unlabelled');
  lines.push('', '## Unlabelled', '', ...(unlabelled.length ? unlabelled.map((c) => `- ${c.id} (${c.split}, ${c.source})`) : ['None.']));
  const stale = run.cases.filter((c) => c.status === 'stale');
  lines.push('', '## Stale', '', ...(stale.length ? stale.map((c) => `- ${c.id}: ${c.reason}`) : ['None.']));
  return `${lines.join('\n')}\n`;
}

// ---- main ----------------------------------------------------------------------------------------------------

async function main(argv) {
  const { values } = parse(argv, {
    cases: { type: 'string' },
    split: { type: 'string' },
    results: { type: 'string' },
    export: { type: 'boolean' },
    project: { type: 'string', multiple: true },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const casesFile = values.cases ? path.resolve(values.cases) : CASES_FILE;

  if (values.export) {
    if (values.split || values.results) throw new GitSkillError(`--export takes --project and --cases only\n${USAGE}`);
    const result = await exportCases(values.project ?? []);
    const current = readCasesFile(casesFile, { missingOk: true });
    const merged = mergeCases(current.cases, result.cases);
    writeCasesFile(casesFile, { skill: current.skill, cases: merged });
    for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
    const n = (source) => result.cases.filter((c) => c.source === source).length;
    const skippedText = Object.entries(result.skipped).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
    const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    print(values.json, { casesFile, exported: result.cases.length, outcome: n('outcome'), failed: n('failed'), skipped: result.skipped, total: merged.length, projects: result.projects },
      `Exported ${plural(result.cases.length, 'landing decision')} (${n('outcome')} labelled by outcome, ${n('failed')} failed and unlabelled); skipped: ${skippedText}. ${casesFile} now holds ${plural(merged.length, 'case')}.`);
    return 0;
  }

  if (values.project) throw new GitSkillError(`--project is for --export\n${USAGE}`);
  const raw = values.split ?? 'all';
  // Skillio's runner contract names the dev split "tuning".
  const split = raw === 'tuning' ? 'dev' : raw;
  if (split !== 'all' && !SPLITS.includes(split)) throw new GitSkillError(`--split is held-out, dev (tuning) or all, not ${raw}`);
  const run = await runEvals({ casesFile, split });
  const resultsFile = values.results ? path.resolve(values.results) : RESULTS_FILE;
  fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
  fs.writeFileSync(resultsFile, resultsMarkdown(run, path.dirname(resultsFile)));
  if (values.json) print(true, { ...run, resultsFile });
  else print(false, null, `${formatRun(run)}\nWrote ${resultsFile}`);
  return run.heldOut.pass === false ? 1 : 0;
}

if (isMain(import.meta.url)) runCli(main);
