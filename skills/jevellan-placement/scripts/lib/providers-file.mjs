// ~/.jevellan-harness/providers.json and providers-state.json: loading, strict validation, and the probe results.
//
// providers.json has the shape of the skills repo's (its D-011 fields), without `home`:
//   { "jev": {keyFile, model, timeoutMs},
//     "providers": [{name, kind, tokenFile?, keyFile?, baseUrl?, codexHome?, ceilingPct?, enabled?, paidUse?,
//                    metered?, models: [{id, label, efforts, maxTokens?}] | "same as <provider>"}] }
// Unknown keys are refused (exit 2 naming the key), so a typo never falls back to a default silently.
//
// providers-state.json is written by providers.mjs check and read by route.mjs: login state and usage per provider,
// and whether Jev answered. It never holds a secret.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROVIDER_KINDS = ['claude-subscription', 'claude-endpoint', 'codex-subscription', 'openai-compatible'];
export const CLAUDE_KINDS = ['claude-subscription', 'claude-endpoint'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const METERED_BY_DEFAULT = ['claude-endpoint', 'openai-compatible'];
const PAID_USE = ['always', 'never', 'when-subscriptions-run-out'];
const PROVIDER_KEYS = ['name', 'kind', 'tokenFile', 'keyFile', 'baseUrl', 'codexHome', 'ceilingPct', 'enabled', 'paidUse', 'metered', 'models'];
const MODEL_KEYS = ['id', 'label', 'efforts', 'maxTokens'];
const JEV_KEYS = ['keyFile', 'model', 'timeoutMs'];
export const STATE_FRESH_MS = 12 * 60 * 60 * 1000;

export class ProvidersError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function ownerHome() {
  try {
    const home = os.userInfo().homedir;
    if (home) return home;
  } catch {}
  return os.homedir();
}

export function harnessHome() {
  return process.env.JH_HARNESS_HOME || path.join(ownerHome(), '.jevellan-harness');
}

export function providersPath() {
  return path.join(harnessHome(), 'providers.json');
}

export function providersStatePath() {
  return path.join(harnessHome(), 'providers-state.json');
}

export function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return ownerHome();
  if (value.startsWith('~/')) return path.join(ownerHome(), value.slice(2));
  return value;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

function refuse(where, message) {
  throw new ProvidersError(`providers.json: ${where} ${message}`);
}

function unknownKeys(object, allowed, where) {
  const extra = Object.keys(object).find((k) => !allowed.includes(k));
  if (extra !== undefined) refuse(where, `has an unknown key "${extra}"`);
}

function validModels(models, where) {
  if (!Array.isArray(models) || models.length === 0) refuse(where, 'models must be a non-empty list or "same as <provider>"');
  const ids = new Set();
  return models.map((m, i) => {
    const at = `${where}.models[${i}]`;
    if (!isObject(m)) refuse(at, 'must be an object');
    unknownKeys(m, MODEL_KEYS, at);
    if (!isText(m.id)) refuse(at, 'needs an id');
    if (ids.has(m.id)) refuse(at, `repeats the model id ${m.id}`);
    ids.add(m.id);
    if (!isText(m.label)) refuse(at, 'needs a label');
    if (!Array.isArray(m.efforts) || m.efforts.length === 0 || !m.efforts.every((e) => EFFORTS.includes(e))) {
      refuse(at, `efforts must be a non-empty list of ${EFFORTS.join(', ')}`);
    }
    if (m.maxTokens !== undefined && !(Number.isInteger(m.maxTokens) && m.maxTokens > 0)) refuse(at, 'maxTokens must be a positive integer');
    return { id: m.id, label: m.label, efforts: [...m.efforts], ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}) };
  });
}

// Validates and resolves the file. Returns {file, ownerHome, jev, providers}, every path in it expanded and every
// "same as" list resolved.
export function parseProviders(raw, file = providersPath()) {
  if (!isObject(raw)) throw new ProvidersError(`${file} must hold one JSON object`);
  unknownKeys(raw, ['jev', 'providers'], 'the file');
  if (!isObject(raw.jev)) refuse('jev', 'is required');
  unknownKeys(raw.jev, JEV_KEYS, 'jev');
  if (!isText(raw.jev.keyFile)) refuse('jev.keyFile', 'is required');
  if (!isText(raw.jev.model)) refuse('jev.model', 'is required');
  const timeoutMs = raw.jev.timeoutMs ?? 4000;
  if (!(Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) refuse('jev.timeoutMs', 'must be a positive integer');
  if (!Array.isArray(raw.providers) || raw.providers.length === 0) refuse('providers', 'must be a non-empty list');
  const names = new Set();
  const first = raw.providers.map((p, i) => {
    const at = `providers[${i}]`;
    if (!isObject(p)) refuse(at, 'must be an object');
    unknownKeys(p, PROVIDER_KEYS, `${at} (${p.name ?? '?'})`);
    if (!isText(p.name) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.name)) refuse(at, 'needs a name of letters, digits, dot, dash or underscore');
    if (names.has(p.name)) refuse(at, `repeats the name ${p.name}`);
    names.add(p.name);
    const where = `providers.${p.name}`;
    if (!PROVIDER_KINDS.includes(p.kind)) refuse(where, `kind must be one of ${PROVIDER_KINDS.join(', ')}`);
    const ceilingPct = p.ceilingPct ?? 90;
    if (!(typeof ceilingPct === 'number' && ceilingPct > 0 && ceilingPct <= 100)) refuse(where, 'ceilingPct must be a number from 1 to 100');
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') refuse(where, 'enabled must be true or false');
    if (p.metered !== undefined && typeof p.metered !== 'boolean') refuse(where, 'metered must be true or false');
    if (p.paidUse !== undefined && !PAID_USE.includes(p.paidUse)) refuse(where, `paidUse must be one of ${PAID_USE.join(', ')}`);
    for (const key of ['tokenFile', 'keyFile', 'baseUrl', 'codexHome']) if (p[key] !== undefined && !isText(p[key])) refuse(where, `${key} must be a text`);
    if (p.kind === 'claude-endpoint' || p.kind === 'openai-compatible') {
      if (!isText(p.baseUrl) || !/^https?:\/\//.test(p.baseUrl)) refuse(where, 'needs a baseUrl (http or https)');
    }
    if (p.kind === 'codex-subscription' && (p.tokenFile || p.keyFile)) refuse(where, 'a codex-subscription logs in through its CODEX_HOME, not a token or key file');
    return {
      name: p.name,
      kind: p.kind,
      tokenFile: p.tokenFile ? expandHome(p.tokenFile) : undefined,
      keyFile: p.keyFile ? expandHome(p.keyFile) : undefined,
      baseUrl: p.baseUrl,
      codexHome: p.codexHome ? expandHome(p.codexHome) : undefined,
      ceilingPct,
      enabled: p.enabled ?? true,
      paidUse: p.paidUse ?? 'always',
      metered: p.metered ?? METERED_BY_DEFAULT.includes(p.kind),
      rawModels: p.models,
    };
  });
  const providers = first.map((p) => {
    let models = p.rawModels;
    if (typeof models === 'string') {
      const same = /^same as (\S+)$/.exec(models);
      const other = same && first.find((q) => q.name === same[1]);
      if (!other || typeof other.rawModels === 'string') refuse(`providers.${p.name}`, `models "${models}" must name a provider with its own list`);
      models = other.rawModels;
    }
    const { rawModels, ...rest } = p;
    return { ...rest, models: validModels(models, `providers.${p.name}`) };
  });
  return {
    file,
    ownerHome: ownerHome(),
    jev: { keyFile: expandHome(raw.jev.keyFile), model: raw.jev.model, timeoutMs },
    providers,
  };
}

export function loadProviders(file = providersPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ProvidersError(`cannot read ${file}: ${error.code ?? error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProvidersError(`${file} is not JSON: ${error.message}`);
  }
  return parseProviders(raw, file);
}

export function findProvider(config, name) {
  return config.providers.find((p) => p.name === name) ?? null;
}

export function secretFile(provider) {
  return provider.kind === 'claude-subscription' ? provider.tokenFile : provider.keyFile;
}

// Whether a key or token file has a value; never returns the value.
export function secretPresent(file) {
  if (!file) return false;
  try {
    return fs.readFileSync(file, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

// ---- providers-state.json --------------------------------------------------------------------------------------
// { checkedAt, jev: {ok, models, configured, detail, checkedAt},
//   providers: { <name>: {auth: "ready"|"needs-login"|"unknown", detail, weeklyPct, fiveHourPct, weeklyResetsAt,
//                         fiveHourResetsAt, observedAt} } }

export function readProvidersState(file = providersStatePath()) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(state) ? { jev: null, providers: {}, ...state } : { jev: null, providers: {} };
  } catch {
    return { jev: null, providers: {} };
  }
}

export function writeProvidersState(state, file = providersStatePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// A provider's recorded state, or null when it was never probed or the probe is older than 12 hours.
export function freshProviderState(state, name, now = Date.now()) {
  const entry = state?.providers?.[name];
  if (!entry?.observedAt) return null;
  return now - Date.parse(entry.observedAt) < STATE_FRESH_MS ? entry : null;
}

// The usage percentages that still apply: a percentage counts only until its window resets.
export function currentUsage(entry, now = Date.now()) {
  if (!entry) return { weeklyPct: null, fiveHourPct: null };
  const live = (pct, resetsAt) => (typeof pct === 'number' && !(resetsAt && Date.parse(resetsAt) <= now) ? pct : null);
  return { weeklyPct: live(entry.weeklyPct, entry.weeklyResetsAt), fiveHourPct: live(entry.fiveHourPct, entry.fiveHourResetsAt) };
}
