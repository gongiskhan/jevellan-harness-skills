#!/usr/bin/env node
// The eval runner of the placement policy (the skills brief section 12), ported from the skills repo's evals.ts and
// adapted to read decisions from the ledger instead of a table.
//
//   node evals/run.mjs [--split all|dev|held-out] [--threshold N] [--cases FILE] [--results FILE] [--json]
//   node evals/run.mjs --export <project root>... [--cases FILE] [--json]
//
// A case: {id, kind: placement|workflow, state, questions, expected, source: hand|outcome|failed, split: dev|held-out,
// decisionFile?, note?}. expected maps a question id to the expected answer (a model id, an effort, a provider name,
// or a boolean for a workflow question); null means unlabelled.
//
// Export (--export): from each project's ledger, read through the ledger skill's public script (events --json), every
// task.placed line with source jev and a decisionFile, in ledger order:
// - every fifth such line is held-out, the rest dev. The position counts every such line of that ledger, so a
//   decision keeps its split across exports;
// - skipped: a decision file that cannot be read, one that asked Jev nothing (only-option answers and the models
//   check, D-036: there is no answer to replay), and placed work that has not ended (still running, waiting on a
//   decision or progress, never started) or was stopped;
// - done on the attempt it was placed for: expected is what Jev chose, read from the decision file's answers with
//   the router's resolution (highest probability, ties to Jev's choice), the model option mapped back to its model id
//   through the menu in the stored state; only questions that were asked get an expected value (source outcome);
// - failed, lost, blocked, or done only after a retry: expected null (source failed), kept for a person to label;
// - merge into the cases file: hand cases are kept; an exported case replaces the case with the same decision file
//   name; cases of earlier exports that this export does not contain are kept; a case a person labelled (source
//   failed, expected set) keeps its label when the decision is exported again unlabelled.
//
// Replay (the default): the policy is the SKILL.md next to this folder, as it is now. Each case's questions are
// rebuilt from it: instructions from the policy sections, criteria from the current model descriptions and effort
// guide, the workflow questions from "## questions"; state.rules is replaced by the current rules section and a
// placement state's menu descriptions by the current model descriptions. The provider question (no policy text) is
// asked in a second call, as the router does, with the stored criteria. A case the current policy cannot express (a
// model id with no description line, an effort with no guide line, a question id the policy no longer has) is listed
// as stale and not scored; a case with expected null is listed as unlabelled. Agreement is counted per question and
// split; evals/RESULTS.md records the policy hash, the date, the agreement and every disagreement with Jev's
// probabilities.
//
// Exit codes: 0 at or above the held-out threshold (threshold.json {"heldOut": 0..1}, or --threshold), 1 below it,
// 2 when the run cannot be made (no Jev key, a Jev failure, an invalid cases file), 3 when a project has no ledger.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jevClient } from '../scripts/jev.mjs';
import { loadProviders } from '../scripts/lib/providers-file.mjs';
import { readEvents } from '../scripts/lib/ledger-client.mjs';
import { projectPaths } from '../scripts/lib/project.mjs';
import {
  PROVIDER_INSTRUCTIONS,
  RouteError,
  askJev,
  groupByTask,
  loadRouterPolicy,
  modelOptionKeys,
  placementOutcome,
  resolveChoice,
  resolveNoul,
  stateJson,
} from '../scripts/route.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(HERE, '..');
export const SKILL_NAME = 'jevellan-placement';
export const CASES_FILE = path.join(HERE, 'cases.json');
export const RESULTS_FILE = path.join(HERE, 'RESULTS.md');
export const THRESHOLD_FILE = path.join(HERE, 'threshold.json');

export const CASE_KINDS = ['placement', 'workflow'];
export const CASE_SOURCES = ['hand', 'outcome', 'failed'];
export const SPLITS = ['dev', 'held-out'];

const refused = (message) => new RouteError(message, 2);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asObject = (v) => (isObject(v) ? v : {});

/** Every fifth case (positions 5, 10, ...) is held out. */
export function splitAt(index) {
  return (index + 1) % 5 === 0 ? 'held-out' : 'dev';
}

// ---- the cases file ---------------------------------------------------------------------------------------------

function caseProblem(c) {
  if (!isObject(c)) return 'is not an object';
  if (typeof c.id !== 'string' || c.id === '') return 'has no id';
  if (!CASE_KINDS.includes(c.kind)) return `has kind ${String(c.kind)} (placement or workflow)`;
  if (!isObject(c.state)) return 'has no state object';
  if (!isObject(c.questions)) return 'has no questions object';
  if (c.expected !== null && !isObject(c.expected)) return 'has an expected that is neither an object nor null';
  if (!CASE_SOURCES.includes(c.source)) return `has source ${String(c.source)}`;
  if (!SPLITS.includes(c.split)) return `has split ${String(c.split)} (dev or held-out)`;
  return undefined;
}

/** Reads a cases file ({skill, cases} or a bare list). A missing file is an empty list; an invalid one is exit 2. */
export function readCasesFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { skill: SKILL_NAME, cases: [] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refused(`${file} is not valid JSON: ${error.message}`);
  }
  const list = Array.isArray(raw) ? raw : isObject(raw) ? raw.cases : undefined;
  if (!Array.isArray(list)) throw refused(`${file} has no "cases" list`);
  const ids = new Set();
  list.forEach((c, i) => {
    const problem = caseProblem(c);
    if (problem) throw refused(`${file}: case ${i + 1} ${problem}`);
    if (ids.has(c.id)) throw refused(`${file}: the case id ${c.id} is used twice`);
    ids.add(c.id);
  });
  return { skill: isObject(raw) && typeof raw.skill === 'string' ? raw.skill : SKILL_NAME, cases: list };
}

/** Writes a cases file atomically (a temporary file renamed over it). */
export function writeCasesFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// ---- export -------------------------------------------------------------------------------------------------------

/** The model option key of each menu model in a placement state (the router's modelOptionKeys over the stored menu). */
export function stateModelKeys(state) {
  const models = asObject(state.menu).models;
  if (!Array.isArray(models)) return new Map();
  return modelOptionKeys(models.filter((m) => isObject(m) && ['id', 'label', 'provider', 'kind'].every((k) => typeof m[k] === 'string')));
}

/** Jev's answers of a decision, resolved the way the router resolves them, keyed by question id. */
export function jevAnswers(decision, questions, state) {
  const answers = asObject(decision.answers);
  const keys = stateModelKeys(state);
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const answer = answers[id];
    if (!isObject(answer)) continue;
    try {
      if (q.type === 'choice' && answer.type === 'choice') {
        const option = resolveChoice(questions, answers, id).option;
        if (id === 'model') {
          const modelId = keys.get(option);
          if (modelId !== undefined) out[id] = modelId;
        } else out[id] = option;
      } else if (q.type === 'noul' && answer.type === 'noul') out[id] = resolveNoul(answers, id).value;
    } catch {
      // an answer the router could not read gives no expected value
    }
  }
  return out;
}

const ENDED_BADLY = ['failed', 'lost', 'blocked'];

// The ledger finds its project from JH_PROJECT before the working folder; the export names its projects itself, so
// each read runs with JH_PROJECT set to that project root.
function projectEvents(root) {
  const had = Object.hasOwn(process.env, 'JH_PROJECT');
  const previous = process.env.JH_PROJECT;
  process.env.JH_PROJECT = root;
  try {
    return readEvents(root).events;
  } finally {
    if (had) process.env.JH_PROJECT = previous;
    else delete process.env.JH_PROJECT;
  }
}

/** The cases of one project's ledger (see the header for every rule). */
export function exportProject(root) {
  const ledgerFile = projectPaths(root).ledger;
  if (!fs.existsSync(ledgerFile)) throw new RouteError(`no ledger at ${ledgerFile}`, 3);
  const events = projectEvents(root);
  const tasks = groupByTask(events);
  const skipped = { 'not-ended': 0, stopped: 0, 'nothing-asked': 0, unreadable: 0 };
  const cases = [];
  let position = 0;
  for (const placed of events) {
    if (placed.kind !== 'task.placed' || placed.data?.source !== 'jev' || typeof placed.data?.decisionFile !== 'string') continue;
    const split = splitAt(position);
    position += 1;
    const file = path.resolve(root, placed.data.decisionFile);
    let decision;
    let state;
    try {
      decision = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = typeof decision.state === 'string' ? JSON.parse(decision.state) : decision.state;
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    if (!isObject(decision) || !isObject(state) || !isObject(decision.questions)) {
      skipped.unreadable += 1;
      continue;
    }
    if (Object.keys(decision.questions).length === 0) {
      skipped['nothing-asked'] += 1;
      continue;
    }
    const outcome = placementOutcome(tasks.get(placed.task) ?? [], placed);
    const name = path.basename(file);
    const base = { id: name.replace(/\.json$/, ''), kind: 'placement', state, questions: decision.questions, split, decisionFile: name, project: path.basename(root), task: placed.task, step: placed.data.step };
    if (outcome.outcome === 'done' && outcome.onPlacedAttempt) {
      const expected = jevAnswers(decision, decision.questions, state);
      if (!Object.keys(expected).length) {
        skipped.unreadable += 1;
        continue;
      }
      cases.push({ ...base, expected, source: 'outcome', outcome: 'done' });
    } else if (outcome.outcome === 'done' || ENDED_BADLY.includes(outcome.outcome)) {
      cases.push({ ...base, expected: null, source: 'failed', outcome: outcome.outcome === 'done' ? 'done after a retry' : outcome.outcome });
    } else if (outcome.outcome === 'stopped') skipped.stopped += 1;
    else skipped['not-ended'] += 1;
  }
  return { cases, skipped };
}

/** Merges exported cases into the cases already in the file (see the header). */
export function mergeCases(existing, exported) {
  const fresh = new Map(exported.filter((c) => c.decisionFile).map((c) => [c.decisionFile, c]));
  const out = [];
  const placed = new Set();
  for (const c of existing) {
    const next = c.source !== 'hand' && c.decisionFile ? fresh.get(c.decisionFile) : undefined;
    if (!next) {
      out.push(c);
      continue;
    }
    placed.add(next.decisionFile);
    // A person's label on an unlabelled case survives a re-export that is still unlabelled.
    if (next.expected === null && c.expected !== null) out.push({ ...next, expected: c.expected, ...(c.note ? { note: c.note } : {}) });
    else out.push(c.note ? { ...next, note: c.note } : next);
  }
  for (const c of exported) if (!c.decisionFile || !placed.has(c.decisionFile)) out.push(c);
  return out;
}

export async function exportCases(roots, casesFile = CASES_FILE) {
  const exported = [];
  const skipped = { 'not-ended': 0, stopped: 0, 'nothing-asked': 0, unreadable: 0 };
  for (const root of roots) {
    const r = exportProject(path.resolve(root));
    exported.push(...r.cases);
    for (const [k, v] of Object.entries(r.skipped)) skipped[k] += v;
  }
  const current = readCasesFile(casesFile);
  const cases = mergeCases(current.cases, exported);
  const ids = new Set();
  for (const c of cases) {
    if (ids.has(c.id)) throw refused(`the export would use the case id ${c.id} twice; rename one case in ${casesFile}`);
    ids.add(c.id);
  }
  writeCasesFile(casesFile, { skill: current.skill, cases });
  return {
    casesFile,
    exported: exported.length,
    outcome: exported.filter((c) => c.source === 'outcome').length,
    unlabelled: exported.filter((c) => c.expected === null).length,
    heldOut: exported.filter((c) => c.split === 'held-out').length,
    skipped,
    total: cases.length,
  };
}

// ---- replay -------------------------------------------------------------------------------------------------------

class Stale extends Error {}

// The state text of a rebuilt case; a state the cap cannot bring under the limit is stale, not a failed run.
function cappedState(state) {
  try {
    return stateJson(state);
  } catch (error) {
    throw new Stale(error.message);
  }
}

function storedCriteria(c, id) {
  const q = c.questions[id];
  return isObject(q) && isObject(q.criteria) ? q.criteria : undefined;
}

/** Rebuilds a case's questions and state from the current policy. Throws Stale when the policy cannot express them. */
export function rebuildCase(policy, c) {
  const state = structuredClone(c.state);
  state.rules = policy.rules;
  const decode = {};
  if (c.kind === 'workflow') {
    const questions = {};
    for (const id of Object.keys(c.questions)) {
      const q = policy.questions.get(id);
      if (!q) throw new Stale(`the policy's "## questions" has no ${id}`);
      questions[id] = { type: 'noul', instructions: q.question, criteria: { true: q.true, false: q.false } };
    }
    if (!Object.keys(questions).length) throw new Stale('the case asks no question');
    return { state: cappedState(state), calls: [questions], decode };
  }

  const first = {};
  const menu = asObject(state.menu);
  if (Array.isArray(menu.models)) {
    for (const m of menu.models) if (isObject(m) && typeof m.id === 'string' && policy.modelDescriptions.has(m.id)) m.description = policy.modelDescriptions.get(m.id);
  }
  const storedModel = storedCriteria(c, 'model');
  if (storedModel) {
    const keys = stateModelKeys(state);
    const criteria = {};
    for (const key of Object.keys(storedModel)) {
      const id = keys.get(key);
      if (id === undefined) throw new Stale(`the model option "${key}" is not in the state's menu`);
      const description = policy.modelDescriptions.get(id);
      if (description === undefined) throw new Stale(`the policy's "## model descriptions" has no line for ${id}`);
      criteria[key] = description;
    }
    first.model = { type: 'choice', instructions: policy.modelInstructions, criteria };
    decode.model = (option) => keys.get(option) ?? option;
  }
  const storedEffort = storedCriteria(c, 'effort');
  if (storedEffort) {
    const criteria = {};
    for (const e of Object.keys(storedEffort)) {
      const line = policy.effortGuide.get(e);
      if (line === undefined) throw new Stale(`the policy's "## effort guide" has no line for ${e}`);
      criteria[e] = line;
    }
    first.effort = { type: 'choice', instructions: policy.effortInstructions, criteria };
  }
  const calls = [];
  if (Object.keys(first).length) calls.push(first);
  const storedProvider = storedCriteria(c, 'provider');
  if (storedProvider) {
    const criteria = Object.fromEntries(Object.entries(storedProvider).filter((e) => typeof e[1] === 'string'));
    calls.push({ provider: { type: 'choice', instructions: PROVIDER_INSTRUCTIONS, criteria } });
  }
  if (!calls.length) throw new Stale('the case asks no question');
  return { state: cappedState(state), calls, decode };
}

function normalizeExpected(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** threshold.json {"heldOut": 0..1}; 0.6 when the file is missing. Exit 2 when it is not valid. */
export function readThreshold(file = THRESHOLD_FILE) {
  if (!fs.existsSync(file)) return 0.6;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw refused(`${file} is not valid JSON: ${error.message}`);
  }
  const value = asObject(raw).heldOut;
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw refused(`${file} needs {"heldOut": <number from 0 to 1>}`);
  return value;
}

async function replayCase(policy, c, ask) {
  const base = { id: c.id, kind: c.kind, split: c.split, source: c.source };
  if (c.expected === null) return { ...base, status: 'unlabelled', results: [] };
  let rebuilt;
  try {
    rebuilt = rebuildCase(policy, c);
  } catch (error) {
    if (error instanceof Stale) return { ...base, status: 'stale', reason: error.message, results: [] };
    throw error;
  }
  const asked = new Set(rebuilt.calls.flatMap((q) => Object.keys(q)));
  const scored = Object.keys(c.expected).filter((id) => asked.has(id));
  if (!scored.length) return { ...base, status: 'stale', reason: `no expected answer for the questions asked (${[...asked].join(', ')})`, results: [] };
  let exchange = null;
  for (const questions of rebuilt.calls) exchange = await ask(rebuilt.state, questions, exchange);
  const results = scored.map((id) => {
    const expected = normalizeExpected(c.expected[id]);
    const q = exchange.questions[id];
    if (q.type === 'noul') {
      const r = resolveNoul(exchange.answers, id);
      return { question: id, expected, got: r.value, agree: r.value === expected, probabilities: { true: r.probability } };
    }
    const r = resolveChoice(exchange.questions, exchange.answers, id);
    const dec = rebuilt.decode[id] ?? ((o) => o);
    const got = dec(r.option);
    const probabilities = Object.fromEntries(Object.entries(r.probabilities).map(([k, p]) => [dec(k), p]));
    return { question: id, expected, got, agree: got === expected, probabilities };
  });
  return { ...base, status: 'scored', results, jevModel: exchange.calls[exchange.calls.length - 1]?.model ?? exchange.jevModel };
}

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

/** Replays the current policy against the cases through Jev. Jev failures are exit 2. */
export async function runEvals({ casesFile = CASES_FILE, split = 'all', threshold, policyFile = path.join(SKILL_DIR, 'SKILL.md'), concurrency = 4, now = new Date() } = {}) {
  const policy = loadRouterPolicy(policyFile);
  if (!fs.existsSync(casesFile)) throw refused(`no cases file at ${casesFile}`);
  const limit = threshold ?? readThreshold();
  const all = readCasesFile(casesFile).cases;
  const cases = split === 'all' ? all : all.filter((c) => c.split === split);
  const config = loadProviders();
  const client = jevClient(config.jev, { home: config.ownerHome });
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
  const ask = async (state, questions, into) => {
    const ex = await askJev(client, config.jev, state, questions, into);
    const call = ex.calls[ex.calls.length - 1];
    usage.calls += 1;
    usage.input_tokens += call.usage.input_tokens;
    usage.output_tokens += call.usage.output_tokens;
    return ex;
  };
  const results = await pool(cases, concurrency, (c) => replayCase(policy, c, ask));
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
    skill: SKILL_NAME,
    hash: policy.hash,
    date: now.toISOString(),
    casesFile,
    split,
    jevModel: config.jev.model,
    answeredBy: [...new Set(results.flatMap((r) => (r.jevModel ? [r.jevModel] : [])))],
    cases: results,
    agreement,
    threshold: limit,
    heldOut: { rate, pass: rate === null ? null : rate >= limit },
    usage,
  };
}

// ---- reporting ----------------------------------------------------------------------------------------------------

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

/** Question ids in a stable order: the router's first, then the workflow questions, "all" last. */
function questionOrder(run) {
  const known = ['model', 'effort', 'provider'];
  const ids = Object.keys(run.agreement).filter((q) => q !== 'all');
  return [...known.filter((q) => ids.includes(q)), ...ids.filter((q) => !known.includes(q)).sort(), ...(run.agreement.all ? ['all'] : [])];
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

const rateText = (t) => (t && t.total ? `${Math.round((t.agreed / t.total) * 100)}%` : 'n/a');

/** The text a run prints. */
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
  // Machine-readable lines, "<split> agreement: <n>%" per split ("tuning" is Skillio's name for dev), then the bare
  // "agreement:" line for the split this run was asked for.
  const overall = run.agreement.all;
  lines.push(
    `held-out agreement: ${rateText(overall?.['held-out'])}`,
    `dev agreement: ${rateText(overall?.dev)}`,
    `tuning agreement: ${rateText(overall?.dev)}`,
    `all agreement: ${rateText(overall?.all)}`,
    `agreement: ${rateText(run.split === 'dev' ? overall?.dev : run.split === 'held-out' ? overall?.['held-out'] : overall?.all)}`,
  );
  return lines.join('\n');
}

/** evals/RESULTS.md of a run. */
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

// ---- command line ---------------------------------------------------------------------------------------------

export const USAGE = `usage: node evals/run.mjs [--split all|dev|held-out] [--threshold N] [--cases FILE] [--results FILE] [--json]
       node evals/run.mjs --export <project root>... [--cases FILE] [--json]`;

export function parseRunArgs(argv) {
  const out = { split: 'all', exportRoots: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const value = () => {
      if (eq > 0) return a.slice(eq + 1);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw refused(`${name} needs a value\n${USAGE}`);
      i += 1;
      return v;
    };
    if (name === '--split') {
      const raw = value();
      const v = raw === 'tuning' ? 'dev' : raw;
      if (v !== 'all' && !SPLITS.includes(v)) throw refused(`--split is all, dev (tuning) or held-out, not ${raw}`);
      out.split = v;
    } else if (name === '--threshold') {
      const raw = value();
      const n = Number(raw);
      if (raw.trim() === '' || !(n >= 0 && n <= 1)) throw refused(`--threshold is a number from 0 to 1, not ${raw}`);
      out.threshold = n;
    } else if (name === '--cases') out.cases = value();
    else if (name === '--results') out.results = value();
    else if (name === '--export') {
      out.exportRoots ??= [];
      if (eq > 0) out.exportRoots.push(a.slice(eq + 1));
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        out.exportRoots.push(argv[i + 1]);
        i += 1;
      }
      if (!out.exportRoots.length) throw refused(`--export needs at least one project root\n${USAGE}`);
    } else if (name === '--json') out.json = true;
    else if (name === '--help' || name === '-h') out.help = true;
    else throw refused(`unknown argument ${a}\n${USAGE}`);
  }
  return out;
}

export async function main(argv, io = { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) }) {
  const json = argv.includes('--json');
  try {
    const args = parseRunArgs(argv);
    if (args.help) {
      io.out(USAGE);
      return 0;
    }
    const abs = (p) => path.resolve(process.cwd(), p);
    const casesFile = args.cases ? abs(args.cases) : CASES_FILE;
    if (args.exportRoots) {
      const r = await exportCases(args.exportRoots, casesFile);
      if (json) io.out(JSON.stringify(r, null, 2));
      else {
        const skips = Object.entries(r.skipped).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
        io.out(`Exported ${r.exported} cases (${r.outcome} labelled by their outcome, ${r.unlabelled} unlabelled, ${r.heldOut} held-out); skipped: ${skips}. ${casesFile} holds ${r.total} cases.`);
      }
      return 0;
    }
    const run = await runEvals({ casesFile, split: args.split, ...(args.threshold !== undefined ? { threshold: args.threshold } : {}) });
    const resultsFile = args.results ? abs(args.results) : RESULTS_FILE;
    fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
    fs.writeFileSync(resultsFile, resultsMarkdown(run, path.dirname(resultsFile)));
    if (json) io.out(JSON.stringify({ ...run, resultsFile }, null, 2));
    else io.out(`${formatRun(run)}\nWrote ${resultsFile}`);
    return run.heldOut.pass === false ? 1 : 0;
  } catch (error) {
    const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 2;
    const message = error?.message ?? String(error);
    if (json) io.out(JSON.stringify({ error: message, exitCode }));
    io.err(`evals: ${message}`);
    return exitCode;
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
