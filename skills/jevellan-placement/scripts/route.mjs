#!/usr/bin/env node
// Placement (the skills brief 7.2, 7.3 and 7.5): the only code path that chooses a provider, a model and an effort for
// a task step. Ported from the skills repo's route.ts.
//
//   node route.mjs (--task-file <file> | --task T) --step N --duty D [--json]
//   node route.mjs (--task-file <file> | --task T) --step N --duty D --owner <provider>/<model>/<effort> [--json]
//   node route.mjs (--task-file <file> | --task T) --questions [--json]
//
// Placement of a step, in the order of 7.2:
//   1. load the policy (this skill's own SKILL.md), check its six sections, hash its body (the "## Interface" section,
//      which documents the scripts, is not policy: it is neither read nor hashed);
//   2. build the menu: providers that are enabled, whose key or token file has a value, whose login is ready per a
//      probe of the last twelve hours (providers-state.json; a missing or stale entry is probed again through
//      providers.mjs first), under their ceiling, and whose kind can run the duty's needs (the duty skill's jh-needs,
//      mapped onto the kinds the installed runtime skills list in jh-kinds). One entry per model id, named by its
//      best-ranked provider (ported rankProviders); efforts are the union of the models' efforts, mapped onto the
//      chosen model's efforts afterwards (ported mapEffort);
//   3. build the state JSON, capped at 60 000 characters, task text shortened last;
//   4. ask Jev the model and effort questions in one call, then the provider question in a second call with the same
//      state when the chosen model is served by more than one eligible provider. A question with one option cannot be
//      sent (Jev's contract needs two to 255 options) and is recorded as only-option; when no question is left at
//      all, Jev is still reached (GET /v1/models: key, authentication, the configured model listed) before anything
//      is written (the skills repo's D-036);
//   5. resolve (highest probability, ties to Jev's choice), map the effort onto the model's efforts, write the
//      decision file .jevellan/decisions/<task>-s<step>-<time>.json and append task.placed.
//
// No Jev, no placement: every Jev failure is exit 2 with "Jev: <message>" and nothing is written; there is no table
// fallback and no default model anywhere here (the skills repo's D-030). The owner's placement (--owner) is the one
// placement without Jev: it is validated against providers.json and recorded with source "owner".
//
// What is not ported: the reference's owner rules file (rules.json, min and max effort per kind or duty), which this
// harness does not have, the visible flag and its tmux runtime, and the decisions table (a decision is a file next to
// the ledger, and task.placed names it).
//
// The task file is what the ledger skill's `show T --json` prints. It names the task; the task's lines are read from
// the ledger itself, so a task file written before later steps ran cannot give Jev a stale state, and --task and
// --task-file always agree. The project root is found from the working folder through git (or JH_PROJECT).
//
// The ledger is reached only through the ledger skill's public script, run as a process (lib/ledger-client.mjs):
// `show T --json` gives the task, its lines and each step's view since its last retry reset, `events --json` the
// placements of the project for the history, and `record task.placed` appends the placement (it refuses, exit 3, a
// task that is not in the ledger). The duty and runtime skills are read by their SKILL.md frontmatter (jh-needs,
// jh-kinds). Ids, the project folder and the redactor are this skill's own copies (lib/ids.mjs, lib/project.mjs,
// lib/redact.mjs).
//
// Exit codes: 0 placed, 2 refused (Jev, the policy, providers.json, the menu, a missing role, the ledger refusing),
// 3 not found.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JevError, STATE_LIMIT, jevClient, jevMessage } from './jev.mjs';
import { EFFORTS, PROVIDER_KINDS, currentUsage, freshProviderState, loadProviders, projectListed, readProvidersState, secretFile, secretPresent } from './lib/providers-file.mjs';
import { loadPolicy, parseIdLines, parseQuestionLines, requireSection } from './lib/policy.mjs';
import { RoleMissing, skillWithRole, skillsWithRole } from './lib/roles.mjs';
import { LedgerCallError, NOT_FOUND, appendLine, readEvents, readTask } from './lib/ledger-client.mjs';
import { compactTime, isTaskId } from './lib/ids.mjs';
import { projectRoot, readProjectJson } from './lib/project.mjs';
import { redactValue } from './lib/redact.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The policy is this skill's own SKILL.md, wherever the skill is installed.
export const POLICY_FILE = path.join(HERE, '..', 'SKILL.md');

export class RouteError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

const refused = (message) => new RouteError(message, 2);
const notFound = (message) => new RouteError(message, 3);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// "Jev: <message>", exit 2.
export function jevRefusal(error) {
  return new RouteError(jevMessage(error), 2);
}

// ---- the policy (section 7.8) -----------------------------------------------------------------------------------

/** The sections placement reads; a missing or empty one is exit 2 naming it. */
export const ROUTER_SECTIONS = ['model', 'model descriptions', 'effort', 'effort guide', 'questions', 'rules'];

export function routerPolicy(policy) {
  for (const name of ROUTER_SECTIONS) requireSection(policy, name);
  const where = (section) => `${policy.file}, "## ${section}"`;
  return {
    file: policy.file,
    hash: policy.hash,
    modelInstructions: requireSection(policy, 'model'),
    modelDescriptions: parseIdLines(requireSection(policy, 'model descriptions'), where('model descriptions')),
    effortInstructions: requireSection(policy, 'effort'),
    effortGuide: parseIdLines(requireSection(policy, 'effort guide'), where('effort guide')),
    questions: parseQuestionLines(requireSection(policy, 'questions'), where('questions')),
    rules: requireSection(policy, 'rules'),
  };
}

export function loadRouterPolicy(file = POLICY_FILE) {
  return routerPolicy(loadPolicy(file));
}

// ---- efforts (ported mapEffort) ---------------------------------------------------------------------------------

export const isEffort = (value) => EFFORTS.includes(value);
const effortIndex = (e) => EFFORTS.indexOf(e);

/** The lowest supported effort at or above the requested one, else the highest supported (ported as it is). */
export function mapEffort(requested, supported) {
  if (!isEffort(requested)) throw refused(`unknown effort ${requested} (the efforts are ${EFFORTS.join(', ')})`);
  if (!supported?.length) throw refused('this model has no supported effort levels');
  const unknown = supported.filter((e) => !isEffort(e));
  if (unknown.length) throw refused(`unknown effort ${unknown.join(', ')} (the efforts are ${EFFORTS.join(', ')})`);
  const available = [...new Set(supported)].sort((a, b) => effortIndex(a) - effortIndex(b));
  return available.find((e) => effortIndex(e) >= effortIndex(requested)) ?? available[available.length - 1];
}

// ---- duties and provider kinds (section 7.3) --------------------------------------------------------------------

/** Duties that run as one turn with no tools, whatever their needs (v1 runs them on the Claude runtime). */
export const ONE_TURN_DUTIES = ['answer', 'converse'];
export const KNOWN_NEEDS = ['repo-read', 'repo-write', 'shell', 'browser'];
/** Kinds that can answer in one turn without tools; openai-compatible only once a runtime skill lists it. */
export const ONE_TURN_KINDS = ['claude-subscription', 'claude-endpoint', 'openai-compatible'];
/** Kinds that can work in a repository with a shell and a browser. */
export const AGENT_KINDS = ['claude-subscription', 'claude-endpoint', 'codex-subscription'];

/**
 * A frontmatter value that is a list: `key: []`, `key: [a, b]`, a single value, or a block of "  - item" lines.
 * undefined when the key is absent (ported frontmatterList).
 */
export function frontmatterList(text, key) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return undefined;
  const lines = match[1].split(/\r?\n/);
  const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m || m[1] !== key) continue;
    const inline = m[2].trim();
    if (inline.startsWith('[')) {
      if (!inline.endsWith(']')) throw refused(`frontmatter ${key}: "${inline}" is not a list`);
      const inner = inline.slice(1, -1).trim();
      return inner === '' ? [] : inner.split(',').map(unquote).filter((v) => v !== '');
    }
    if (inline !== '') return [unquote(inline)];
    const out = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = /^\s+-\s+(.+)$/.exec(lines[j]);
      if (item) out.push(unquote(item[1]));
      else if (/^\s*$/.test(lines[j])) continue;
      else break;
    }
    return out;
  }
  return undefined;
}

/** The jh-needs of the installed duty skill for `duty`. Exit 2 when no such skill is installed or it declares none. */
export function dutyNeeds(duty, root) {
  const skill = skillWithRole('duty', { duty }, root);
  const needs = frontmatterList(skill.text, 'jh-needs');
  if (needs === undefined) throw refused(`the duty skill for ${duty} (${skill.name}) declares no jh-needs`);
  const unknown = needs.filter((n) => !KNOWN_NEEDS.includes(n));
  if (unknown.length) throw refused(`the duty skill for ${duty} declares unknown jh-needs: ${unknown.join(', ')} (known: ${KNOWN_NEEDS.join(', ')})`);
  return needs;
}

/** The provider kinds the installed runtime skills can run (the union of their jh-kinds). Exit 2 when there is none. */
export function runtimeKinds(root) {
  const runtimes = skillsWithRole('runtime', {}, root);
  if (!runtimes.length) throw new RoleMissing('runtime');
  const kinds = new Set();
  for (const skill of runtimes) if (Array.isArray(skill.meta['jh-kinds'])) for (const kind of skill.meta['jh-kinds']) kinds.add(kind);
  return kinds;
}

/** The kinds that can run a step of `duty`: what its needs allow, of the kinds some runtime skill lists. */
export function dutyKinds(duty, needs, available) {
  const wanted = ONE_TURN_DUTIES.includes(duty) || needs.length === 0 ? ONE_TURN_KINDS : AGENT_KINDS;
  return PROVIDER_KINDS.filter((kind) => wanted.includes(kind) && available.has(kind));
}

// ---- eligibility (ported rankProviders, itself from Jevellan's rankAccounts) -------------------------------------

/** Whether the provider's key or token file has a value, or it needs none (the value is never read here). */
export function providerKeyReady(provider) {
  const file = secretFile(provider);
  return file === undefined || secretPresent(file);
}

const HAS_WINDOWS = ['claude-subscription', 'codex-subscription'];

/**
 * Ranks providers for a placement. Excluded providers stay in the list with their reason, so the decision file can
 * say why a provider was not in the menu. Reasons, in the order they are tested: unsupported (a kind that cannot run
 * this step), model-not-served, disabled, project-not-listed (its projects list does not name this project),
 * not-offered (placement: false: only the owner's placement uses it), no-key, needs-login (no probe of the last
 * twelve hours said ready),
 * usage-ceiling (a subscription at or over its ceilingPct in either current window), paid-not-allowed. Order:
 * eligible first, then subscriptions before metered providers, then known usage before unknown, then lower effective
 * usage, then lower weekly usage, then name.
 */
export function rankProviders({ providers, state, kinds, model, project, keyReady = providerKeyReady, now = Date.now() }) {
  const base = providers.map((provider) => {
    const entry = freshProviderState(state, provider.name, now);
    const usage = currentUsage(entry, now);
    const hasWindows = HAS_WINDOWS.includes(provider.kind);
    const windows = hasWindows ? [usage.fiveHourPct, usage.weeklyPct].filter((v) => typeof v === 'number') : [];
    let reason = 'eligible';
    if (kinds && !kinds.includes(provider.kind)) reason = 'unsupported';
    else if (model && !provider.models.some((m) => m.id === model)) reason = 'model-not-served';
    else if (!provider.enabled) reason = 'disabled';
    else if (!projectListed(provider, project)) reason = 'project-not-listed';
    else if (provider.placement === false) reason = 'not-offered';
    else if (!keyReady(provider)) reason = 'no-key';
    else if (entry?.auth !== 'ready') reason = 'needs-login';
    else if (windows.some((value) => value >= provider.ceilingPct)) reason = 'usage-ceiling';
    return {
      provider,
      entry,
      usage,
      eligible: reason === 'eligible',
      reason,
      knownUsage: windows.length > 0,
      effectivePct: windows.length ? Math.max(...windows) : 0,
      weeklyPct: hasWindows ? (usage.weeklyPct ?? 0) : 0,
    };
  });
  // Paid use follows the provider's paidUse: never, or only when no subscription is eligible.
  const subscriptionReady = base.some((r) => r.eligible && !r.provider.metered);
  for (const r of base) {
    if (!r.eligible || !r.provider.metered) continue;
    if (r.provider.paidUse === 'never' || (r.provider.paidUse === 'when-subscriptions-run-out' && subscriptionReady)) {
      r.eligible = false;
      r.reason = 'paid-not-allowed';
    }
  }
  return base.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible)
      || Number(a.provider.metered) - Number(b.provider.metered)
      || Number(b.knownUsage) - Number(a.knownUsage)
      || a.effectivePct - b.effectivePct
      || a.weeklyPct - b.weeklyPct
      || a.provider.name.localeCompare(b.provider.name),
  );
}

/**
 * Probes again, through providers.mjs, the providers whose login state is missing or older than twelve hours and
 * that could otherwise be in the menu. A failure of the probe itself is kept as a reason, not thrown: those providers
 * then count as needs-login.
 */
export async function refreshStale(config, state, kinds, now = Date.now()) {
  const names = config.providers
    .filter((p) => kinds.includes(p.kind) && p.enabled && p.placement !== false && providerKeyReady(p) && !freshProviderState(state, p.name, now))
    .map((p) => p.name);
  if (!names.length) return { state, probed: [], probeError: null };
  try {
    const { checkProviders } = await import('./providers.mjs');
    const written = await checkProviders({ only: names, jev: false });
    const reread = readProvidersState();
    const providers = { ...(isObject(reread.providers) ? reread.providers : {}) };
    for (const name of names) {
      if (!freshProviderState(reread, name, now) && isObject(written?.providers?.[name])) providers[name] = written.providers[name];
    }
    return { state: { ...reread, providers }, probed: names, probeError: null };
  } catch (error) {
    return { state, probed: names, probeError: error?.message ?? String(error) };
  }
}

// ---- the menu ----------------------------------------------------------------------------------------------------

/**
 * The menu of 7.2 step 2: one entry per model id, attributed to its best-ranked eligible provider. Exit 2 when it is
 * empty or a menu model has no description line.
 */
export function buildMenu({ config, state, kinds, policy, keyReady, project, now = Date.now(), probeError = null }) {
  const ranking = rankProviders({ providers: config.providers, state, kinds, project, ...(keyReady ? { keyReady } : {}), now });
  const eligible = ranking.filter((r) => r.eligible);
  if (!eligible.length) {
    const why = ranking.map((r) => `${r.provider.name} ${r.reason}`).join(', ');
    throw refused(`no provider can run this step (kinds ${kinds.join(', ') || 'none'}): ${why}${probeError ? `; the login probe failed: ${probeError}` : ''}`);
  }
  const models = [];
  const servedBy = new Map();
  const missing = [];
  for (const r of eligible) {
    for (const m of r.provider.models) {
      const list = servedBy.get(m.id);
      if (list) {
        list.push(r.provider.name);
        continue;
      }
      servedBy.set(m.id, [r.provider.name]);
      const description = policy.modelDescriptions.get(m.id);
      if (description === undefined) missing.push(m.id);
      models.push({ id: m.id, label: m.label, provider: r.provider.name, kind: r.provider.kind, efforts: [...m.efforts], description: description ?? '' });
    }
  }
  if (missing.length) {
    throw refused(`the placement policy (${policy.file}) has no line in "## model descriptions" for ${missing.join(', ')}; add "<model id>: <text>" lines`);
  }
  const offered = new Set(models.flatMap((m) => m.efforts));
  const providers = eligible.map((r) => ({
    name: r.provider.name,
    kind: r.provider.kind,
    weeklyPct: r.usage.weeklyPct ?? null,
    fiveHourPct: r.usage.fiveHourPct ?? null,
    ceilingPct: r.provider.ceilingPct,
    observedAt: r.entry?.observedAt ?? null,
  }));
  return { models, providers, efforts: EFFORTS.filter((e) => offered.has(e)), ranking, servedBy };
}

/** Every provider and why it was or was not in the menu (ported account choice candidates). */
export function candidates(ranking) {
  return ranking.map((r) => ({
    name: r.provider.name,
    kind: r.provider.kind,
    eligible: r.eligible,
    reason: r.reason,
    ceilingPct: r.provider.ceilingPct,
    weeklyPct: r.usage.weeklyPct ?? null,
    fiveHourPct: r.usage.fiveHourPct ?? null,
  }));
}

// ---- state (7.2 step 3) -------------------------------------------------------------------------------------------

// The size limit of Jev's state is Jev's contract, kept with the client.
export { STATE_LIMIT };
export const TASK_SHORTENED = '[Task shortened.]';
export const PREVIOUS_SUMMARY_CHARS = 600;
export const HISTORY_LIMIT = 10;
export const SKIP_REASON = 'Jev: not needed';

/**
 * The state as JSON of at most `limit` characters. Shrinks, in order: history entries (oldest first), earlier-step
 * summaries (oldest first), then the task text, cut with the marker "[Task shortened.]". Still too large is exit 2
 * with Jev's state-too-large message.
 */
export function stateJson(state, limit = STATE_LIMIT) {
  const s = structuredClone(state);
  const text = () => JSON.stringify(s);
  if (text().length <= limit) return text();
  if (isObject(s.history) && Array.isArray(s.history.recent)) while (text().length > limit && s.history.recent.length) s.history.recent.shift();
  if (isObject(s.step) && Array.isArray(s.step.previous)) while (text().length > limit && s.step.previous.length) s.step.previous.shift();
  if (text().length <= limit) return text();
  const full = String(s.task?.text ?? '');
  const withCut = (n) => {
    let end = n;
    const code = full.charCodeAt(end - 1);
    if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1; // never split a surrogate pair
    s.task.text = `${full.slice(0, end)}${TASK_SHORTENED}`;
    return text().length;
  };
  if (!isObject(s.task) || withCut(0) > limit) throw jevRefusal(new JevError('state-too-large'));
  let lo = 0;
  let hi = full.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (withCut(mid) <= limit) lo = mid;
    else hi = mid - 1;
  }
  withCut(lo);
  return text();
}

// ---- reading the task from the ledger -------------------------------------------------------------------------
// A task here is what lib/ledger-client.mjs readTask returns: the ledger's show --json (created, events, lastSeq, the
// projection's fields) with view(ordinal), the step's view since its last retry reset, whose started, end, done,
// lastReport and placed are the lines themselves.

/** The task id a task file names (what `show T --json` prints: {"task": "T...", ...}). Needs no other skill. */
export function taskIdFromFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw refused(`cannot read --task-file ${file}: ${error.code ?? error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refused(`--task-file ${file} is not JSON: ${error.message}`);
  }
  if (!isObject(raw)) throw refused(`--task-file ${file} must hold one JSON object (what the ledger's show --json prints)`);
  const id = typeof raw.task === 'string' ? raw.task : raw.id;
  if (!isTaskId(id)) throw refused(`--task-file ${file} names no task id (a "task" field of T and six characters)`);
  return id;
}

function lastOf(events, predicate) {
  for (let i = events.length - 1; i >= 0; i -= 1) if (predicate(events[i])) return events[i];
  return null;
}

/** The task's workflow steps: one step for a single task, the latest task.workflow otherwise ([] before it). */
export function workflowOf(task) {
  const created = task.created.data ?? {};
  if (created.kind === 'single') return { steps: [{ ordinal: 1, duty: created.duty, instructions: '' }], skipped: [] };
  const workflow = lastOf(task.events, (e) => e.kind === 'task.workflow');
  return { steps: Array.isArray(workflow?.data?.steps) ? workflow.data.steps : [], skipped: Array.isArray(workflow?.data?.skipped) ? workflow.data.skipped : [] };
}

/** Retries that went back to `ordinal` (step.retrying with that gotoOrdinal), before `seq` when given. */
function retriesBack(events, ordinal, seq = Infinity) {
  return events.filter((e) => e.kind === 'step.retrying' && e.data?.gotoOrdinal === ordinal && e.seq < seq);
}

const END_KINDS = ['step.report', 'step.failed', 'step.lost', 'step.stopped'];

/** Why a retry happened: the failing step's last end before it (its report summary, or the failure), else the retry's reason. */
function failureOf(events, retry) {
  const failing = Number.isInteger(retry.step) ? retry.step : retry.data?.ordinal;
  const end = lastOf(events, (e) => e.seq < retry.seq && e.step === failing && END_KINDS.includes(e.kind));
  if (end?.kind === 'step.report' && typeof end.data?.summary === 'string' && end.data.summary.trim()) return end.data.summary;
  if (end?.kind === 'step.failed' && typeof end.data?.reason === 'string' && end.data.reason.trim()) return end.data.reason;
  if (end?.kind === 'step.lost') return `step ${failing} lost (pid ${end.data?.pid ?? '?'} gone)`;
  return typeof retry.data?.reason === 'string' ? retry.data.reason : '';
}

/**
 * The step part of the state: instructions from the workflow (empty for a single task), the attempt (1 + every retry
 * that went back to this step), the earlier steps with their status and summary (first 600 characters), and on a
 * retry the failure that sent the task back here. Refuses a duty that is not the workflow's for that step, and a
 * skipped step.
 */
export function stepState(task, ordinal, duty) {
  const events = task.events;
  const { steps, skipped } = workflowOf(task);
  const spec = steps.find((s) => s.ordinal === ordinal);
  if (spec && spec.duty !== duty) throw refused(`step ${ordinal} of ${task.created.task} is duty ${spec.duty}, not ${duty}`);
  if (skipped.includes(ordinal)) throw refused(`step ${ordinal} of ${task.created.task} is skipped by its workflow`);
  const retries = retriesBack(events, ordinal);
  const attempt = 1 + retries.length;
  const ordinals = new Set(steps.map((s) => s.ordinal));
  for (const e of events) if (e.kind === 'step.started' && Number.isInteger(e.step)) ordinals.add(e.step);
  const previous = [];
  for (const o of [...ordinals].filter((o) => o < ordinal).sort((a, b) => a - b)) {
    const oSpec = steps.find((s) => s.ordinal === o);
    // The ledger's view of step o since its last retry reset: an earlier attempt's end does not count.
    const view = task.view(o);
    const oDuty = oSpec?.duty ?? view.started?.data?.duty ?? '';
    if (skipped.includes(o)) {
      previous.push({ duty: oDuty, status: 'skipped', summary: SKIP_REASON });
      continue;
    }
    let status = null;
    if (view.done) status = 'done';
    else if (view.end?.kind === 'step.report') status = view.end.data?.status ?? 'unknown';
    else if (view.end) status = view.end.kind.slice('step.'.length);
    else if (view.started) status = 'running';
    if (status === null) continue;
    const summary = view.lastReport?.data?.summary ?? view.end?.data?.reason ?? '';
    previous.push({ duty: oDuty, status, summary: String(summary).slice(0, PREVIOUS_SUMMARY_CHARS) });
  }
  const step = { ordinal, duty, instructions: typeof spec?.instructions === 'string' ? spec.instructions : '', attempt, previous };
  if (attempt > 1) step.failure = failureOf(events, retries[retries.length - 1]);
  return step;
}

function reportOutcome(data) {
  if (data?.status === 'done' && data?.testsRun?.passed === false) return 'failed';
  return typeof data?.status === 'string' ? data.status : 'unknown';
}

/**
 * How the work a task.placed line placed ended, from the task's lines after it up to the next placement of the same
 * step: done (a done report or step.done), failed (step.failed, a retry from this step, or a done report with failing
 * tests), lost, stopped, blocked, needs-decision, progress, running (started, nothing after) or pending (never
 * started). The last of them wins (a blocked step the owner unblocked and that then finished is done). `attempts` is
 * the step's attempt when that outcome happened (1 + retries that went back to it), null while nothing ended;
 * `onPlacedAttempt` says whether it ended on the attempt it was placed for.
 */
export function placementOutcome(taskEvents, placed) {
  const step = placed.data?.step;
  let outcome = 'pending';
  let at = null;
  for (const e of taskEvents) {
    if (e.seq <= placed.seq) continue;
    if (e.kind === 'task.placed' && e.data?.step === step) break;
    if (e.step !== step) continue;
    if (e.kind === 'step.started') {
      outcome = 'running';
      at = null;
    } else if (e.kind === 'step.report') {
      outcome = reportOutcome(e.data);
      at = e;
    } else if (e.kind === 'step.done') {
      outcome = 'done';
      at = e;
    } else if (e.kind === 'step.failed' || e.kind === 'step.retrying') {
      outcome = 'failed';
      at = e;
    } else if (e.kind === 'step.lost' || e.kind === 'step.stopped') {
      outcome = e.kind.slice('step.'.length);
      at = e;
    }
  }
  const placedAttempt = Number.isInteger(placed.data?.attempt) ? placed.data.attempt : 1 + retriesBack(taskEvents, step, placed.seq).length;
  const attempts = at ? 1 + retriesBack(taskEvents, step, at.seq).length : null;
  return { outcome, attempts, placedAttempt, onPlacedAttempt: attempts !== null && attempts <= placedAttempt };
}

/** Lines grouped by their task, in ledger order: task id -> that task's lines. */
export function groupByTask(events) {
  const tasks = new Map();
  for (const e of events) {
    if (typeof e?.task !== 'string') continue;
    if (!tasks.has(e.task)) tasks.set(e.task, []);
    tasks.get(e.task).push(e);
  }
  return tasks;
}

/** Each placement of `placed` with how its work ended, read from `events` (every line of the placements' tasks). */
export function historyOf(placed, events) {
  const tasks = groupByTask(events);
  return placed.map((p) => {
    const { outcome, attempts } = placementOutcome(tasks.get(p.task) ?? [], p);
    return { duty: p.data?.duty ?? '', model: p.data?.model ?? '', effort: p.data?.effort ?? '', outcome, attempts };
  });
}

/**
 * The last task.placed lines of the project's ledger, newest last: what ran and how it ended. Two reads through the
 * ledger skill: the placements, then every line of the tasks the last `limit` of them belong to.
 */
export function recentHistory(root, limit = HISTORY_LIMIT) {
  const placed = readEvents(root, { kinds: ['task.placed'] }).events.slice(-limit);
  if (!placed.length) return [];
  const { events } = readEvents(root, { tasks: [...new Set(placed.map((e) => e.task))] });
  return historyOf(placed, events);
}

export function projectState(root) {
  const json = readProjectJson(root);
  return {
    name: typeof json.name === 'string' && json.name.trim() ? json.name : path.basename(root),
    guidance: typeof json.guidance === 'string' ? json.guidance : '',
  };
}

export function taskState(task) {
  const d = task.created.data ?? {};
  return { id: task.created.task, kind: d.kind ?? '', title: d.title ?? '', text: d.text ?? '', parent: d.parent ?? null };
}

// ---- questions and answers ----------------------------------------------------------------------------------------

/** The model question's criterion key of a menu model: "<label> via <provider> (<kind>)". */
export function modelOptionKey(m) {
  return `${m.label} via ${m.provider} (${m.kind})`;
}

/** Criterion keys per menu model; keys that would repeat get " [<model id>]" so every option is distinct. */
export function modelOptionKeys(models) {
  const base = models.map((m) => modelOptionKey(m));
  const count = new Map();
  for (const k of base) count.set(k, (count.get(k) ?? 0) + 1);
  const out = new Map();
  models.forEach((m, i) => out.set(count.get(base[i]) > 1 ? `${base[i]} [${m.id}]` : base[i], m.id));
  return out;
}

/**
 * The model and effort questions (7.2 step 4). A question with a single option is not asked; the caller records it
 * as only-option and, when no question is left, still checks that Jev answers before writing anything.
 */
export function placementQuestions(policy, menu) {
  const modelKeys = modelOptionKeys(menu.models);
  const questions = {};
  if (menu.models.length > 1) {
    questions.model = {
      type: 'choice',
      instructions: policy.modelInstructions,
      criteria: Object.fromEntries([...modelKeys].map(([key, id]) => [key, menu.models.find((m) => m.id === id).description])),
    };
  }
  const missing = menu.efforts.filter((e) => !policy.effortGuide.has(e));
  if (missing.length) throw refused(`the placement policy (${policy.file}) has no line in "## effort guide" for ${missing.join(', ')}`);
  if (menu.efforts.length > 1) {
    questions.effort = {
      type: 'choice',
      instructions: policy.effortInstructions,
      criteria: Object.fromEntries(menu.efforts.map((e) => [e, policy.effortGuide.get(e)])),
    };
  }
  return { questions, modelKeys };
}

function pctText(value) {
  return value === null || value === undefined ? 'unknown' : `${Number(value.toFixed(1))}%`;
}

/** The provider criterion: "<name>: week <pct>% of <ceiling>%, five hours <pct>%" ("unknown" when not known). */
export function providerCriterion(p) {
  return `${p.name}: week ${pctText(p.weeklyPct)} of ${p.ceilingPct}%, five hours ${pctText(p.fiveHourPct)}`;
}

/** Instructions of the provider question, adapted from Jevellan's account question (account-choice.ts). */
export const PROVIDER_INSTRUCTIONS =
  'Choose the provider account for this step. Respect the owner routing rules. Prefer known usage with headroom below the ceiling in both the weekly and the five-hour window. Earlier options have the better resource rank.';

/** The provider question; undefined when the model has a single eligible provider. Options in rank order. */
export function providerQuestion(menu, modelId, instructions = PROVIDER_INSTRUCTIONS) {
  const names = menu.servedBy.get(modelId) ?? [];
  if (names.length < 2) return undefined;
  return {
    type: 'choice',
    instructions,
    criteria: Object.fromEntries(names.map((n) => [n, providerCriterion(menu.providers.find((p) => p.name === n))])),
  };
}

/**
 * The highest-probability option; an exact tie goes to Jev's choice, else to the first tied option in criteria order
 * (ported resolveChoice). Exit 2 (invalid response) when the answer is missing or not a choice.
 */
export function resolveChoice(questions, answers, id) {
  const question = questions[id];
  const answer = answers?.[id];
  if (question?.type !== 'choice' || answer?.type !== 'choice' || !isObject(answer.probabilities)) throw jevRefusal(new JevError('invalid-response'));
  const keys = Object.keys(question.criteria);
  const p = (key) => answer.probabilities[key] ?? 0;
  const max = Math.max(...keys.map(p));
  return { option: p(answer.choice) === max ? answer.choice : keys.find((key) => p(key) === max), probabilities: answer.probabilities };
}

/** A noul answer as a boolean: true when its probability is 0.5 or more. */
export function resolveNoul(answers, id) {
  const answer = answers?.[id];
  if (answer?.type !== 'noul' || typeof answer.noul !== 'number') throw jevRefusal(new JevError('invalid-response'));
  return { value: answer.noul >= 0.5, probability: answer.noul };
}

// ---- Jev calls ----------------------------------------------------------------------------------------------------

/**
 * Asks Jev `questions` over the state text. `into` continues an exchange (same state; the new questions, answers and
 * call are added). Every Jev failure is exit 2 with the JevError message.
 */
export async function askJev(client, jev, state, questions, into = null) {
  if (state.length > STATE_LIMIT) throw jevRefusal(new JevError('state-too-large'));
  const started = Date.now();
  let response;
  try {
    response = await client.decide({ model: jev.model, state, questions });
  } catch (error) {
    if (error instanceof JevError) throw jevRefusal(error);
    throw error;
  }
  const latencyMs = Date.now() - started;
  const call = { questions: Object.keys(questions), model: response.model, latencyMs, usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens } };
  return {
    jevModel: jev.model,
    state,
    questions: { ...(into?.questions ?? {}), ...questions },
    answers: { ...(into?.answers ?? {}), ...response.answers },
    calls: [...(into?.calls ?? []), call],
    latencyMs: (into?.latencyMs ?? 0) + latencyMs,
    response,
  };
}

/**
 * A placement with nothing to ask still needs Jev ("No Jev, no placement"): GET /v1/models proves the key, the
 * authentication and the reachability, and the configured model must be listed. Every failure is exit 2 before
 * anything is written. Returns the call for the decision file.
 */
export async function checkJev(client, jev) {
  const started = Date.now();
  let models;
  try {
    models = await client.models();
  } catch (error) {
    if (error instanceof JevError) throw jevRefusal(error);
    throw error;
  }
  const names = models.models.map((m) => m.name);
  if (!names.includes(jev.model)) {
    throw refused(`Jev: the configured model ${jev.model} is not listed by GET /v1/models (listed: ${names.join(', ') || 'none'})`);
  }
  return { questions: [], model: jev.model, latencyMs: Date.now() - started, usage: { input_tokens: 0, output_tokens: 0 }, check: 'GET /v1/models' };
}

function usageOf(calls) {
  return {
    input_tokens: calls.reduce((n, c) => n + c.usage.input_tokens, 0),
    output_tokens: calls.reduce((n, c) => n + c.usage.output_tokens, 0),
  };
}

/** Writes a decision file atomically under <project>/.jevellan/decisions/ and returns its path relative to the root. */
export function writeDecision(root, base, record) {
  const dir = path.join(root, '.jevellan', 'decisions');
  fs.mkdirSync(dir, { recursive: true });
  let name = `${base}.json`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n += 1) name = `${base}-${n}.json`;
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return path.relative(root, file).split(path.sep).join('/');
}

// ---- the commands -----------------------------------------------------------------------------------------------

function requireRoot(cwd) {
  const root = projectRoot(cwd);
  if (!root) throw refused('not inside a git repository: placement records into the ledger at the project root');
  return root;
}

// The task through the ledger skill (show --json). The id is checked here first, so a malformed id is refused without
// the ledger; a task the ledger does not have is exit 3. A missing ledger role is exit 2 (RoleMissing).
function requireTask(root, taskId) {
  if (!isTaskId(taskId)) throw refused(`"${taskId}" is not a task id (T and six characters)`);
  try {
    return readTask(root, taskId);
  } catch (error) {
    if (error instanceof LedgerCallError && error.exitCode === NOT_FOUND) throw notFound(`no task ${taskId} in this project's ledger (${root})`);
    throw error;
  }
}

// Appends task.placed through the ledger skill's record command, which refuses (exit 3) a task the ledger does not
// have, and returns the line as written.
function appendPlaced(root, taskId, step, data) {
  return appendLine(root, 'task.placed', { task: taskId, step, session: process.env.JH_SESSION, data });
}

/** Places step `ordinal` (duty `duty`) of a task through Jev. Returns what the command prints. */
export async function placeStep({ taskId, ordinal, duty, cwd = process.cwd(), now = Date.now() }) {
  const root = requireRoot(cwd);
  const policy = loadRouterPolicy();
  const config = loadProviders();
  const task = requireTask(root, taskId);
  const step = stepState(task, ordinal, duty);
  const needs = dutyNeeds(duty);
  const kinds = dutyKinds(duty, needs, runtimeKinds());
  const refreshed = await refreshStale(config, readProvidersState(), kinds, now);
  const menu = buildMenu({ config, state: refreshed.state, kinds, policy, project: root, now, probeError: refreshed.probeError });
  const state = redactValue({
    project: projectState(root),
    task: taskState(task),
    step,
    duty: { needs: [...needs], kinds: [...kinds] },
    menu: { models: menu.models, providers: menu.providers },
    history: { recent: recentHistory(root) },
    rules: policy.rules,
  });
  const { questions, modelKeys } = placementQuestions(policy, menu);
  const stateText = stateJson(state);
  const client = jevClient(config.jev, { home: config.ownerHome });

  let exchange = null;
  if (Object.keys(questions).length) exchange = await askJev(client, config.jev, stateText, questions);
  // Nothing to ask (one model with one effort, one provider): Jev must still answer before the step may run (D-036).
  const check = exchange || providerQuestion(menu, menu.models[0].id) ? null : await checkJev(client, config.jev);

  const probabilities = {};
  let modelChoice;
  if (questions.model) {
    const r = resolveChoice(exchange.questions, exchange.answers, 'model');
    modelChoice = { source: 'jev', option: r.option, probabilities: r.probabilities };
    probabilities.model = Object.fromEntries(Object.entries(r.probabilities).map(([key, p]) => [modelKeys.get(key) ?? key, p]));
  } else modelChoice = { source: 'only-option', option: [...modelKeys.keys()][0] };
  const model = menu.models.find((m) => m.id === modelKeys.get(modelChoice.option));
  if (!model) throw jevRefusal(new JevError('invalid-response'));

  let effortChoice;
  if (questions.effort) {
    const r = resolveChoice(exchange.questions, exchange.answers, 'effort');
    effortChoice = { source: 'jev', option: r.option, probabilities: r.probabilities };
    probabilities.effort = r.probabilities;
  } else effortChoice = { source: 'only-option', option: menu.efforts[0] };
  if (!isEffort(effortChoice.option)) throw jevRefusal(new JevError('invalid-response'));

  // The provider (ported decideAccount): only-option when one eligible provider serves the model, else Jev.
  const pq = providerQuestion(menu, model.id);
  let providerChoice;
  if (pq) {
    exchange = await askJev(client, config.jev, stateText, { provider: pq }, exchange);
    const r = resolveChoice({ provider: pq }, exchange.answers, 'provider');
    providerChoice = { source: 'jev', option: r.option, probabilities: r.probabilities };
    probabilities.provider = r.probabilities;
  } else providerChoice = { source: 'only-option', option: model.provider };
  const ranked = menu.ranking.find((r) => r.eligible && r.provider.name === providerChoice.option);
  const providerModel = ranked?.provider.models.find((m) => m.id === model.id);
  if (!ranked || !providerModel) throw jevRefusal(new JevError('invalid-response'));
  const effort = mapEffort(effortChoice.option, providerModel.efforts);

  const calls = exchange ? exchange.calls : [check];
  const latencyMs = exchange ? exchange.latencyMs : check.latencyMs;
  const jevModel = calls[0]?.model ?? config.jev.model;
  const chosen = {
    source: 'jev',
    duty,
    provider: ranked.provider.name,
    kind: ranked.provider.kind,
    model: model.id,
    label: model.label,
    effort,
    effortRequested: effortChoice.option,
    attempt: step.attempt,
    choices: { model: modelChoice, effort: effortChoice, provider: providerChoice },
    candidates: candidates(menu.ranking),
    ...(refreshed.probed.length ? { probed: refreshed.probed } : {}),
  };
  // The decision file is written before the ledger line that names it, so task.placed never points at nothing.
  const decisionFile = writeDecision(root, `${taskId}-s${ordinal}-${compactTime(new Date(now).toISOString())}`, {
    kind: 'placement',
    task: taskId,
    step: ordinal,
    state: stateText,
    questions: exchange ? exchange.questions : {},
    answers: exchange ? exchange.answers : {},
    chosen,
    jevModel,
    usage: usageOf(calls),
    latencyMs,
    policyHash: policy.hash,
    calls,
  });
  appendPlaced(root, taskId, ordinal, {
    step: ordinal,
    duty,
    provider: chosen.provider,
    model: chosen.model,
    effort,
    kind: chosen.kind,
    probabilities,
    latencyMs,
    policyHash: policy.hash,
    source: 'jev',
    jevModel,
    decisionFile,
    attempt: step.attempt,
  });
  return { provider: chosen.provider, model: chosen.model, effort, kind: chosen.kind, probabilities, latencyMs, policyHash: policy.hash, step: ordinal, duty, source: 'jev' };
}

/** "<provider>/<model>/<effort>"; the model id may itself hold a slash. */
export function parseOwner(text) {
  const first = text.indexOf('/');
  const last = text.lastIndexOf('/');
  if (first <= 0 || last === first || last === text.length - 1) throw refused(`--owner needs <provider>/<model>/<effort>, not "${text}"`);
  return { provider: text.slice(0, first), model: text.slice(first + 1, last), effort: text.slice(last + 1) };
}

// The reasons the owner cannot override: the provider cannot serve this step at all. Over its ceiling or with a
// stale login probe is the owner's call (ported ownerPlacement).
const HARD_REASONS = {
  unsupported: (r, ctx) => `provider ${r.provider.name} is kind ${r.provider.kind}, which cannot run the duty ${ctx.duty} here (kinds that can: ${ctx.kinds.join(', ') || 'none'})`,
  'model-not-served': (r, ctx) => `provider ${r.provider.name} does not serve the model ${ctx.model} (it serves ${r.provider.models.map((m) => m.id).join(', ')})`,
  disabled: (r) => `provider ${r.provider.name} is disabled in providers.json`,
  'project-not-listed': (r, ctx) => `provider ${r.provider.name} runs only in the projects its projects list in providers.json names, and ${ctx.project} is not one of them`,
  'no-key': (r) => `provider ${r.provider.name} has no value in its key or token file (${secretFile(r.provider)})`,
};

/** The owner's placement: no Jev call, validated against providers.json, task.placed with source owner. */
export async function placeOwner({ taskId, ordinal, duty, owner, cwd = process.cwd() }) {
  const wanted = parseOwner(owner);
  if (!isEffort(wanted.effort)) throw refused(`unknown effort ${wanted.effort} (the efforts are ${EFFORTS.join(', ')})`);
  const root = requireRoot(cwd);
  const config = loadProviders();
  const task = requireTask(root, taskId);
  const step = stepState(task, ordinal, duty);
  const needs = dutyNeeds(duty);
  const kinds = dutyKinds(duty, needs, runtimeKinds());
  const ranking = rankProviders({ providers: config.providers, state: readProvidersState(), kinds, model: wanted.model, project: root });
  const chosen = ranking.find((r) => r.provider.name === wanted.provider);
  if (!chosen) throw notFound(`no provider ${wanted.provider} in ${config.file}`);
  if (HARD_REASONS[chosen.reason]) throw refused(HARD_REASONS[chosen.reason](chosen, { duty, kinds, model: wanted.model, project: root }));
  const providerModel = chosen.provider.models.find((m) => m.id === wanted.model);
  const effort = mapEffort(wanted.effort, providerModel.efforts);
  let policyHash = '';
  try {
    policyHash = loadPolicy(POLICY_FILE).hash;
  } catch {
    // the owner's placement does not read the policy; the hash is informational
  }
  appendPlaced(root, taskId, ordinal, {
    step: ordinal,
    duty,
    provider: chosen.provider.name,
    model: wanted.model,
    effort,
    kind: chosen.provider.kind,
    probabilities: {},
    latencyMs: 0,
    policyHash,
    source: 'owner',
    attempt: step.attempt,
    ...(effort !== wanted.effort ? { effortRequested: wanted.effort } : {}),
    ...(chosen.reason !== 'eligible' ? { providerReason: chosen.reason } : {}),
  });
  return { provider: chosen.provider.name, model: wanted.model, effort, kind: chosen.provider.kind, probabilities: {}, latencyMs: 0, policyHash, step: ordinal, duty, source: 'owner' };
}

/**
 * The workflow questions (7.5): one Jev call with the task state and no step, a noul question per line of the
 * policy's "## questions". Writes a decision file of kind workflow and appends nothing (the coordinator records the
 * resolved steps as task.workflow).
 */
export async function workflowQuestions({ taskId, cwd = process.cwd(), now = Date.now() }) {
  const root = requireRoot(cwd);
  const policy = loadRouterPolicy();
  const config = loadProviders();
  const task = requireTask(root, taskId);
  const questions = {};
  for (const [id, q] of policy.questions) questions[id] = { type: 'noul', instructions: q.question, criteria: { true: q.true, false: q.false } };
  const state = redactValue({ project: projectState(root), task: taskState(task), rules: policy.rules });
  const stateText = stateJson(state);
  const client = jevClient(config.jev, { home: config.ownerHome });
  const exchange = await askJev(client, config.jev, stateText, questions);
  const out = {};
  const probabilities = {};
  const answers = {};
  for (const id of Object.keys(questions)) {
    const r = resolveNoul(exchange.answers, id);
    out[id] = r.value;
    probabilities[id] = r.probability;
    answers[id] = r;
  }
  writeDecision(root, `${taskId}-workflow-${compactTime(new Date(now).toISOString())}`, {
    kind: 'workflow',
    task: taskId,
    state: stateText,
    questions: exchange.questions,
    answers: exchange.answers,
    chosen: { answers },
    jevModel: exchange.calls[0]?.model ?? config.jev.model,
    usage: usageOf(exchange.calls),
    latencyMs: exchange.latencyMs,
    policyHash: policy.hash,
    calls: exchange.calls,
  });
  return { ...out, probabilities, policyHash: policy.hash, latencyMs: exchange.latencyMs };
}

// ---- command line ---------------------------------------------------------------------------------------------

const USAGE = `usage: node route.mjs (--task-file <file> | --task T) --step N --duty D [--owner <provider>/<model>/<effort>] [--json]
       node route.mjs (--task-file <file> | --task T) --questions [--json]`;

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'task-file': { type: 'string' },
        task: { type: 'string' },
        step: { type: 'string' },
        duty: { type: 'string' },
        owner: { type: 'string' },
        questions: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    throw refused(`${error.message}\n${USAGE}`);
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if ((values['task-file'] === undefined) === (values.task === undefined)) throw refused(`give --task-file <file> or --task T, one of them\n${USAGE}`);
  let taskId = values.task;
  if (values['task-file'] !== undefined) taskId = taskIdFromFile(values['task-file']);
  let out;
  if (values.questions) {
    if (values.step !== undefined || values.duty !== undefined || values.owner !== undefined) throw refused(`--questions takes no --step, --duty or --owner\n${USAGE}`);
    out = await workflowQuestions({ taskId });
  } else {
    const ordinal = Number(values.step);
    if (values.step === undefined || !Number.isInteger(ordinal) || ordinal < 1) throw refused(`--step must be a positive integer\n${USAGE}`);
    if (!values.duty) throw refused(`--duty is required\n${USAGE}`);
    out = values.owner !== undefined
      ? await placeOwner({ taskId, ordinal, duty: values.duty, owner: values.owner })
      : await placeStep({ taskId, ordinal, duty: values.duty });
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  main(argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
      const message = error?.message ?? String(error);
      if (json) process.stdout.write(`${JSON.stringify({ error: message, exitCode })}\n`);
      process.stderr.write(`${message}\n`);
      process.exitCode = exitCode;
    },
  );
}

