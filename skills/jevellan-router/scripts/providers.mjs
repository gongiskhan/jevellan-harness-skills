#!/usr/bin/env node
// providers.mjs check [--json] [--only <name>]...: the login and usage probes of every provider, and whether Jev
// answers. The result goes to ~/.jevellan-harness/providers-state.json (the shape is the comment in
// lib/providers-file.mjs), which route.mjs reads to build the placement menu; route.mjs also imports checkProviders
// to refresh an entry that is missing or older than twelve hours.
//
// Ported from the skills repo's commands/providers.ts (checkOne, checkJev, formatCheckResult), claude-control.ts
// (claudeUsage, probeClaude, themselves from Jevellan's runtimes/claude/src/control.ts) and codex-control.ts
// (CodexControl, codexUsage, isAuthError, probeCodex, from Jevellan's runtimes/codex/src/control.ts), with doctor.ts's
// probe environment. Per provider, in this order:
//
// - disabled in providers.json: not probed, reported disabled;
// - a kind that no installed runtime skill lists in its jh-kinds (openai-compatible tonight, and Codex until its
//   runtime is installed): not probed, reported "no runtime skill for kind <kind>", since placement could not start
//   a step there anyway;
// - claude-subscription: the cheap header probe, a one-token Messages call with the provider's OAuth token from its
//   tokenFile, read at the moment of use and sent only in the Authorization header. 401 or 403 is needs-login, 2xx or
//   429 is ready, anything else unknown; the anthropic-ratelimit-unified-* response headers give the five-hour and
//   weekly percentages and their reset times. Without a tokenFile the provider needs a login: workers sign in with a
//   token file only (the owner's own login is never borrowed);
// - claude-endpoint (and openai-compatible, once a runtime lists it): not probed; ready when its key file has a value;
// - codex-subscription: `codex app-server` over stdio JSON-RPC under CODEX_HOME = the provider's codexHome or the
//   owner's ~/.codex: initialize, account/read with refreshToken false (a check must never rotate the login: the
//   refresh token is shared with every other Codex client of that home), then account/rateLimits/read, which goes to
//   the server with the stored access token, so a revoked or rotated login answers 401 there (needs-login, fix
//   "codex login"). auth.json is never read, copied or written by this script. The weekly percentage is the limit
//   whose window is 10080 minutes, the five-hour one the 300-minute window (window duration, not position, decides).
//
// Then Jev: the key file (present and mode 600, as the reference checks), GET /v1/models, the configured model listed.
//
// Differences from the reference, with reasons: no store (the state file is the record, merged so providers outside
// --only keep their entries); no model-list filling from supportedModels() or model/list (providers.json is the
// owner's, and every menu model needs a line in the router policy); no login command (a Claude worker logs in with a
// token file, Codex with `codex login`, and the fix says which); no local usage rows for openai-compatible providers
// (no runtime runs them yet). Errors are short fixed sentences: no server body, header value or credential ever
// reaches the state file, the output or an error. As a last line of defence the state and the output pass through the
// ledger skill's redactor when that skill is installed.
//
// JH_ANTHROPIC_URL overrides the Messages API base for tests with a fake server; it is accepted only for an http URL
// on the loopback interface, so a token can never be sent anywhere but the real API or this machine.
//
// Exit codes: 0 when Jev answered with the configured model listed and at least one checked provider is ready; 2
// otherwise, or when providers.json is invalid, with the reason on stderr; 3 when --only names no provider.

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import {
  ProvidersError,
  currentUsage,
  freshProviderState,
  loadProviders,
  providersStatePath,
  readProvidersState,
  secretPresent,
  writeProvidersState,
} from './lib/providers-file.mjs';
import { jevClient, JevError } from './jev.mjs';
import { importFromRole, RoleMissing, SKILLS_ROOT, skillsWithRole } from './lib/roles.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const BASE_ENV_KEYS = ['PATH', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR'];
const PROBE_TIMEOUT_MS = 20_000;
const CODEX_REQUEST_TIMEOUT_MS = 15_000;

// The trimmed value of a key or token file, or undefined. It goes straight into an HTTP header and nowhere else.
function readSecretValue(file) {
  if (!file) return undefined;
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

// ---- Claude: the usage header probe --------------------------------------------------------------------------------

export const ANTHROPIC_API = 'https://api.anthropic.com';
// The identity line the subscription's OAuth beta requires as the system prompt of a request made with an OAuth
// token; a protocol constant, sent verbatim.
const SUBSCRIPTION_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA = 'oauth-2025-04-20';
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

// The Messages API base: the real API, or a loopback test server named by JH_ANTHROPIC_URL.
export function anthropicBase(env = process.env) {
  const override = env.JH_ANTHROPIC_URL;
  if (override === undefined || override === '') return ANTHROPIC_API;
  let url;
  try {
    url = new URL(override);
  } catch {
    throw new ProvidersError('JH_ANTHROPIC_URL is not a URL');
  }
  if (url.protocol !== 'http:' || !LOOPBACK.includes(url.hostname)) {
    throw new ProvidersError('JH_ANTHROPIC_URL must be an http URL on 127.0.0.1 or localhost (it exists for tests, and a token may only go to the real API or this machine)');
  }
  return override.replace(/\/+$/, '');
}

// The model the probe asks for one token: the provider's cheapest (a Haiku, else the last of its list).
export function cheapestModel(provider) {
  return provider.models.find((m) => /haiku/i.test(m.id)) ?? provider.models[provider.models.length - 1];
}

// The account's five-hour and seven-day windows from the anthropic-ratelimit-unified-* response headers:
// utilization is a fraction (0.345 is 34.5 percent), reset is unix seconds.
export function claudeUsage(headers) {
  const window = (prefix) => {
    const raw = headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`);
    const value = raw === null || !raw.trim() ? NaN : Number(raw);
    const reset = headers.get(`anthropic-ratelimit-unified-${prefix}-reset`);
    const seconds = reset === null || !reset.trim() ? NaN : Number(reset);
    return {
      pct: Number.isFinite(value) && value >= 0 ? Math.min(100, Math.round(value * 1000) / 10) : null,
      reset: Number.isFinite(seconds) && seconds >= 0 && seconds < 8.64e12 ? new Date(seconds * 1000).toISOString() : null,
    };
  };
  const five = window('5h');
  const week = window('7d');
  if (five.pct === null && week.pct === null) return null;
  return {
    weeklyPct: week.pct,
    fiveHourPct: five.pct,
    weeklyResetsAt: week.pct === null ? null : week.reset,
    fiveHourResetsAt: five.pct === null ? null : five.reset,
  };
}

// One-token Messages call that proves the login and reads the usage windows. The response body is never read: it
// can echo request details.
export async function probeClaude({ token, model, fetch: fetchImpl = globalThis.fetch, base = ANTHROPIC_API, timeoutMs = PROBE_TIMEOUT_MS }) {
  try {
    const response = await fetchImpl(`${base}/v1/messages`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': OAUTH_BETA,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model, max_tokens: 1, system: SUBSCRIPTION_IDENTITY, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const usage = claudeUsage(response.headers);
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) return { auth: 'needs-login', usage: null, error: 'the provider refused this token' };
    if (response.ok) return { auth: 'ready', usage, error: null };
    if (response.status === 429) return { auth: 'ready', usage, error: null, limited: true };
    return { auth: 'unknown', usage, error: `the probe returned HTTP ${response.status}` };
  } catch {
    return { auth: 'unknown', usage: null, error: 'the probe could not connect' };
  }
}

// ---- Codex: the app-server control channel -------------------------------------------------------------------------

// Jevellan's classifyRuntimeError "auth" rule, plus the phrasings Claude Code and Codex print for a refused login.
export function isAuthError(message) {
  return /401|403|authentication|unauthori[sz]ed|needs.login|token.*(?:expired|revoked)|not.logged.in|sign(?:ing)? in again|run \/login|invalid (?:api key|token|bearer)/i.test(
    String(message ?? ''),
  );
}

export class CodexControlError extends Error {
  constructor(message, kind = 'other') {
    super(message);
    this.name = 'CodexControlError';
    this.kind = kind;
  }
}

const MAX_RESET_SECONDS = 253_402_300_799;

function rateWindow(raw) {
  if (raw === null || raw === undefined) return null;
  const valid = isObject(raw)
    && typeof raw.usedPercent === 'number' && Number.isFinite(raw.usedPercent) && raw.usedPercent >= 0
    && (raw.windowDurationMins === null || raw.windowDurationMins === undefined || (Number.isInteger(raw.windowDurationMins) && raw.windowDurationMins > 0))
    && (raw.resetsAt === null || raw.resetsAt === undefined || (Number.isInteger(raw.resetsAt) && raw.resetsAt >= 0 && raw.resetsAt <= MAX_RESET_SECONDS));
  if (!valid) throw new CodexControlError('the rate limits reply was not understood');
  return { usedPercent: raw.usedPercent, windowDurationMins: raw.windowDurationMins ?? null, resetsAt: raw.resetsAt ?? null };
}

function rateSnapshot(raw) {
  if (!isObject(raw)) throw new CodexControlError('the rate limits reply was not understood');
  if (raw.limitId !== undefined && raw.limitId !== null && typeof raw.limitId !== 'string') throw new CodexControlError('the rate limits reply was not understood');
  return { limitId: raw.limitId ?? null, primary: rateWindow(raw.primary), secondary: rateWindow(raw.secondary) };
}

// The account's five-hour and weekly windows from an account/rateLimits/read reply: the `codex` limit when the
// reply lists limits by id, else the single-bucket view. Window duration, not position, decides: primary is weekly on
// some subscriptions.
export function codexUsage(raw) {
  if (!isObject(raw)) throw new CodexControlError('the rate limits reply was not understood');
  const byId = isObject(raw.rateLimitsByLimitId) ? raw.rateLimitsByLimitId : null;
  const snapshot = rateSnapshot(byId?.codex ?? raw.rateLimits);
  if (snapshot.limitId && snapshot.limitId !== 'codex') return null;
  const windows = [snapshot.primary, snapshot.secondary];
  const five = windows.find((w) => w?.windowDurationMins === 300);
  const week = windows.find((w) => w?.windowDurationMins === 10080);
  if (!five && !week) return null;
  const at = (w) => (w && w.resetsAt !== null ? new Date(w.resetsAt * 1000).toISOString() : null);
  return {
    weeklyPct: week ? Math.min(100, week.usedPercent) : null,
    fiveHourPct: five ? Math.min(100, five.usedPercent) : null,
    weeklyResetsAt: at(week),
    fiveHourResetsAt: at(five),
  };
}

function parseAccount(raw) {
  if (!isObject(raw) || !('account' in raw)) throw new CodexControlError('the Codex account reply was not understood');
  if (raw.account === null) return null;
  if (!isObject(raw.account) || typeof raw.account.type !== 'string') throw new CodexControlError('the Codex account reply was not understood');
  return { type: raw.account.type, planType: typeof raw.account.planType === 'string' ? raw.account.planType : null };
}

// Line-delimited JSON-RPC with `codex app-server` on stdio. Only replies to our own requests are read; notifications
// and requests from the server (lines with a method) are ignored. A refusal's text can name URLs and server bodies,
// so only its class leaves this class.
export class CodexControl {
  #id = 0;
  #pending = new Map();
  #closed = false;
  #child;
  #timeoutMs;

  constructor(child, timeoutMs) {
    this.#child = child;
    this.#timeoutMs = timeoutMs;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        this.#fail(new CodexControlError('Codex control returned an invalid response.'));
        return;
      }
      if (!isObject(reply) || typeof reply.method === 'string' || !Number.isInteger(reply.id)) return;
      const pending = this.#pending.get(reply.id);
      if (!pending) return;
      this.#pending.delete(reply.id);
      if (reply.error !== undefined && reply.error !== null) {
        const auth = isAuthError(isObject(reply.error) ? reply.error.message : '');
        pending.reject(new CodexControlError(auth ? 'Codex refused this login (401).' : 'Codex control request was refused.', auth ? 'auth' : 'other'));
      } else pending.resolve(reply.result);
    });
    child.stderr?.on('data', () => {});
    child.on('close', () => {
      lines.close();
      this.#fail(new CodexControlError('Codex control process closed.'));
    });
    child.on('error', (error) => this.#fail(new CodexControlError(error?.code === 'ENOENT' ? 'codex is not on PATH' : 'Codex control process failed.')));
    child.stdin.on('error', () => this.#fail(new CodexControlError('Codex control channel closed.')));
  }

  #fail(error) {
    for (const request of this.#pending.values()) request.reject(error);
    this.#pending.clear();
  }

  static async open({ spawn = nodeSpawn, env, cwd, timeoutMs = CODEX_REQUEST_TIMEOUT_MS }) {
    let child;
    try {
      child = spawn('codex', ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      throw new CodexControlError(error?.code === 'ENOENT' ? 'codex is not on PATH' : 'Codex control could not start.');
    }
    const control = new CodexControl(child, timeoutMs);
    try {
      await control.request('initialize', { clientInfo: { name: 'jevellan-harness', version: '0.1.0' } });
      control.#write({ method: 'initialized' });
      return control;
    } catch (error) {
      await control.close();
      throw error;
    }
  }

  #write(message) {
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      this.#fail(new CodexControlError('Codex control channel closed.'));
    }
  }

  async request(method, params) {
    if (this.#closed) throw new CodexControlError('Codex control closed.');
    const id = ++this.#id;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new CodexControlError('Codex control request timed out.'));
        }, this.#timeoutMs);
        this.#pending.set(id, { resolve, reject });
        this.#write({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // SIGTERM to the process group, SIGKILL after 2 s; resolves when the process is gone (or after the kill).
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    const pid = child.pid;
    const gone = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null || pid === undefined) resolve();
      else child.once('exit', () => resolve());
    });
    const kill = (signal) => {
      try {
        if (pid !== undefined) process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };
    kill('SIGTERM');
    const hard = setTimeout(() => kill('SIGKILL'), 2000);
    let wait;
    await Promise.race([gone, new Promise((resolve) => { wait = setTimeout(resolve, 3000); })]);
    clearTimeout(hard);
    clearTimeout(wait);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    this.#fail(new CodexControlError('Codex control closed.'));
  }
}

// The login state of a Codex home: account/read (no refresh) says whether a login is stored, and
// account/rateLimits/read proves it against the server. An unreadable quota with a stored login is unknown, not a
// login failure.
export async function probeCodex(options) {
  let control;
  try {
    control = await CodexControl.open(options);
  } catch (error) {
    return { auth: 'unknown', usage: null, error: error instanceof CodexControlError ? error.message : 'Codex control could not start.' };
  }
  try {
    const account = parseAccount(await control.request('account/read', { refreshToken: false }));
    if (!account) return { auth: 'needs-login', usage: null, error: 'no Codex login is stored in this CODEX_HOME' };
    if (account.type === 'amazonBedrock') return { auth: 'unknown', usage: null, error: 'this credential provider is not supported' };
    const plan = account.type === 'chatgpt' ? `ChatGPT ${account.planType ?? 'login'}` : account.type === 'apiKey' ? 'API key login' : `${account.type} login`;
    try {
      const usage = codexUsage(await control.request('account/rateLimits/read', {}));
      return { auth: 'ready', plan, usage, error: null };
    } catch (error) {
      if (error instanceof CodexControlError && error.kind === 'auth') {
        return { auth: 'needs-login', plan, usage: null, error: 'the server refused the stored login (revoked, expired or rotated away)' };
      }
      return { auth: 'unknown', plan, usage: null, error: 'a login is stored, but the usage endpoint could not be read' };
    }
  } catch (error) {
    if (error instanceof CodexControlError && error.kind === 'auth') return { auth: 'needs-login', usage: null, error: 'Codex refused this login' };
    return { auth: 'unknown', usage: null, error: error instanceof CodexControlError ? error.message : 'the Codex account reply was not understood' };
  } finally {
    await control.close();
  }
}

// ---- one provider --------------------------------------------------------------------------------------------------

// The provider kinds some installed runtime skill can run (the union of their jh-kinds).
export function runtimeKinds(root = SKILLS_ROOT) {
  const kinds = new Set();
  for (const skill of skillsWithRole('runtime', {}, root)) {
    if (Array.isArray(skill.meta['jh-kinds'])) for (const kind of skill.meta['jh-kinds']) kinds.add(kind);
  }
  return kinds;
}

function stateEntry(auth, detail, usage, observedAt) {
  return {
    auth,
    detail,
    weeklyPct: usage?.weeklyPct ?? null,
    fiveHourPct: usage?.fiveHourPct ?? null,
    weeklyResetsAt: usage?.weeklyResetsAt ?? null,
    fiveHourResetsAt: usage?.fiveHourResetsAt ?? null,
    observedAt,
  };
}

function codexEnv(base, home, codexHome) {
  const env = {};
  for (const key of BASE_ENV_KEYS) if (base[key] !== undefined) env[key] = base[key];
  env.HOME = home;
  env.CODEX_HOME = codexHome;
  return env;
}

// Probes one provider. Returns {entry, fix, probed}: the state entry, what the owner runs or writes when it is not
// ready (printed, never stored), and whether a probe ran (disabled providers and kinds without a runtime are only
// reported).
async function checkOne(p, ctx) {
  const observedAt = new Date(ctx.now()).toISOString();
  const result = (auth, detail, usage = null, fix = null, probed = true) => ({
    entry: stateEntry(auth, detail, usage, observedAt),
    fix: auth === 'ready' ? null : fix,
    probed,
  });

  if (!p.enabled) return result('unknown', 'disabled in providers.json', null, null, false);
  if (!ctx.kinds.has(p.kind)) return result('unknown', `no runtime skill for kind ${p.kind}`, null, `install a runtime skill whose jh-kinds lists ${p.kind}`, false);

  if (p.kind === 'claude-subscription') {
    const tokenFix = `write a token (claude setup-token prints one) to ${p.tokenFile ?? 'a file'}, mode 600`;
    if (!p.tokenFile) {
      return result('needs-login', 'no tokenFile: write the token to a file and name it in providers.json', null, `write a token (claude setup-token prints one) to a file, mode 600, and name it as tokenFile of ${p.name} in providers.json`);
    }
    const token = readSecretValue(p.tokenFile);
    if (!token) return result('needs-login', `token file missing (${p.tokenFile})`, null, tokenFix);
    const model = cheapestModel(p).id;
    const probe = await probeClaude({ token, model, fetch: ctx.fetch, base: ctx.anthropicBase, timeoutMs: ctx.timeoutMs });
    if (probe.auth === 'ready') return result('ready', probe.limited ? `the probe on ${model} answered (rate limited)` : `the probe on ${model} answered`, probe.usage);
    if (probe.auth === 'needs-login') return result('needs-login', probe.error, null, tokenFix);
    return result('unknown', probe.error, probe.usage, 'check the network and run providers.mjs check again');
  }

  if (p.kind === 'claude-endpoint' || p.kind === 'openai-compatible') {
    if (!p.keyFile) {
      if (p.kind === 'openai-compatible') return result('ready', 'no key needed; not probed');
      return result('needs-login', 'key file missing (none named in providers.json)', null, `name a keyFile for ${p.name} in providers.json and write the key to it, mode 600`);
    }
    if (!secretPresent(p.keyFile)) return result('needs-login', `key file missing (${p.keyFile})`, null, `write the key to ${p.keyFile}, mode 600`);
    return result('ready', 'key file present; not probed');
  }

  if (p.kind === 'codex-subscription') {
    const codexHome = p.codexHome ?? path.join(ctx.home, '.codex');
    const loginFix = p.codexHome ? `CODEX_HOME=${p.codexHome} codex login` : 'codex login';
    if (!fs.existsSync(codexHome)) return result('needs-login', `no Codex login: ${codexHome} does not exist`, null, loginFix);
    const probe = await probeCodex({ spawn: ctx.spawn, env: codexEnv(ctx.env, ctx.home, codexHome), cwd: ctx.home, timeoutMs: ctx.codexTimeoutMs });
    if (probe.auth === 'ready') return result('ready', `${probe.plan} answered account/rateLimits/read`, probe.usage);
    if (probe.auth === 'needs-login') return result('needs-login', probe.error, null, loginFix);
    if (probe.error === 'codex is not on PATH') return result('unknown', probe.error, null, 'install Codex: npm install -g @openai/codex');
    return result('unknown', probe.error, null, `run providers.mjs check again; if it persists, ${loginFix}`);
  }

  return result('unknown', `no probe for kind ${p.kind}`);
}

// ---- Jev -----------------------------------------------------------------------------------------------------------

async function checkJev(config, ctx) {
  const file = config.jev.keyFile;
  const configured = config.jev.model;
  const checkedAt = new Date(ctx.now()).toISOString();
  const keyFix = `write the Jev key to ${file} and run chmod 600 ${file}`;
  const fail = (detail, fix, models = []) => ({ jev: { ok: false, models, configured, detail, checkedAt }, fix });
  let mode;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return fail(`the key file ${file} is not a file`, keyFix);
    mode = stat.mode & 0o777;
  } catch {
    return fail('no key configured', keyFix);
  }
  if (!secretPresent(file)) return fail('no key configured', keyFix);
  if ((mode & 0o077) !== 0) return fail(`the key file ${file} has mode ${mode.toString(8).padStart(3, '0')}, not 600`, `chmod 600 ${file}`);
  try {
    const models = (await jevClient(config.jev, { home: config.ownerHome, fetch: ctx.fetch }).models()).models.map((m) => m.name);
    if (models.includes(configured)) return { jev: { ok: true, models, configured, detail: `reachable, ${configured} listed`, checkedAt }, fix: null };
    return fail(`reachable, but ${configured} is not listed (listed: ${models.join(', ') || 'none'})`, `set jev.model in ${config.file} to a listed model`, models);
  } catch (error) {
    const kind = error instanceof JevError ? error.kind : 'network';
    const detail = error instanceof JevError ? error.message : 'connection failed';
    return fail(detail, kind === 'auth' || kind === 'no-key' ? keyFix : 'check the network and run providers.mjs check again');
  }
}

// ---- the check -----------------------------------------------------------------------------------------------------

async function loadRedactor(root) {
  try {
    const mod = await importFromRole('ledger', 'scripts/lib/redact.mjs', {}, root);
    return { text: (t) => mod.redactText(t), value: (v) => mod.redactValue(v) };
  } catch (error) {
    if (!(error instanceof RoleMissing)) throw error;
    return { text: (t) => t, value: (v) => v };
  }
}

// Every probe, the merge and the write. Returns the state and what the command line prints with it: the providers
// checked, their fixes, which were probed, the Jev fix, the runtime kinds and the clock (for formatCheck and checkJson).
export async function runCheck({ only = [], deps = {}, jev: withJev = true } = {}) {
  const config = loadProviders();
  const names = [...new Set(only)];
  for (const name of names) {
    if (!config.providers.some((p) => p.name === name)) throw new ProvidersError(`no provider "${name}" in ${config.file}`, 3);
  }
  const env = deps.env ?? process.env;
  const root = deps.skillsRoot ?? SKILLS_ROOT;
  const ctx = {
    fetch: deps.fetch ?? globalThis.fetch,
    spawn: deps.spawn ?? nodeSpawn,
    env,
    home: deps.home ?? config.ownerHome,
    now: deps.now ?? Date.now,
    timeoutMs: deps.timeoutMs ?? PROBE_TIMEOUT_MS,
    codexTimeoutMs: deps.codexTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS,
    anthropicBase: anthropicBase(env),
    kinds: runtimeKinds(root),
  };
  const redact = await loadRedactor(root);
  const chosen = names.length ? config.providers.filter((p) => names.includes(p.name)) : config.providers;
  const [results, jevResult] = await Promise.all([
    Promise.all(chosen.map(async (p) => [p.name, await checkOne(p, ctx)])),
    withJev ? checkJev(config, ctx) : Promise.resolve(null),
  ]);
  // Read again after the probes, so a concurrent writer's entries for other providers are kept.
  const file = providersStatePath();
  const previous = readProvidersState(file);
  const fresh = Object.fromEntries(results.map(([name, r]) => [name, r.entry]));
  const state = redact.value({
    ...previous,
    checkedAt: new Date(ctx.now()).toISOString(),
    jev: jevResult ? jevResult.jev : (previous.jev ?? null),
    providers: { ...(isObject(previous.providers) ? previous.providers : {}), ...fresh },
  });
  writeProvidersState(state, file);
  return {
    state,
    config,
    checked: chosen.map((p) => p.name),
    fixes: Object.fromEntries(results.map(([name, r]) => [name, r.fix])),
    probed: Object.fromEntries(results.map(([name, r]) => [name, r.probed])),
    jevFix: jevResult?.fix ?? null,
    kinds: ctx.kinds,
    now: ctx.now(),
    redact,
  };
}

// The probes for every provider (or those named in `only`), merged into providers-state.json; returns the state
// object written. deps (all optional): fetch (Claude probe and Jev), spawn (starts `codex app-server`, called as
// spawn('codex', ['app-server'], options)), env (where the Codex child's PATH and locale come from, and
// JH_ANTHROPIC_URL), home (the owner home for the default CODEX_HOME), skillsRoot (where runtime skills are looked
// up), now (a clock in milliseconds), timeoutMs, codexTimeoutMs. `jev: false` leaves the recorded Jev state as it is.
export async function checkProviders({ only = [], deps = {}, jev = true } = {}) {
  return (await runCheck({ only, deps, jev })).state;
}

// ---- the menu ------------------------------------------------------------------------------------------------------

// What a provider contributes to the placement menu, by the same rules route.mjs applies before duty needs: enabled,
// a runtime for its kind, a login that is ready per a probe of the last twelve hours, and usage below its ceiling on
// both windows (a window counts until it resets). Returns {models: [{id, efforts}], excluded: null | slug, detail}.
export function menuFor(provider, state, { kinds, now = Date.now() } = {}) {
  const none = (excluded, detail) => ({ models: [], excluded, detail });
  if (!provider) return none('not-configured', 'not in providers.json');
  if (!provider.enabled) return none('disabled', 'disabled in providers.json');
  if (kinds && !kinds.has(provider.kind)) return none('no-runtime', `no runtime skill for kind ${provider.kind}`);
  const entry = freshProviderState(state, provider.name, now);
  if (!entry) return none('not-probed', 'no probe in the last 12 hours');
  if (entry.auth === 'needs-login') return none('needs-login', entry.detail);
  if (entry.auth !== 'ready') return none('login-unknown', entry.detail);
  const usage = currentUsage(entry, now);
  for (const [label, pct] of [['weekly', usage.weeklyPct], ['five-hour', usage.fiveHourPct]]) {
    if (pct !== null && pct >= provider.ceilingPct) return none('usage-ceiling', `${label} usage ${pct}% is at or above the ${provider.ceilingPct}% ceiling`);
  }
  return { models: provider.models.map((m) => ({ id: m.id, efforts: [...m.efforts] })), excluded: null, detail: null };
}

// ---- output --------------------------------------------------------------------------------------------------------

const pct = (value) => (value === null || value === undefined ? 'unknown' : `${value}%`);

function usageText(value, resetsAt) {
  return value === null ? 'unknown' : `${pct(value)}${resetsAt ? ` (resets ${resetsAt})` : ''}`;
}

export function formatCheck(view) {
  const { state, config, checked, fixes, probed, jevFix, kinds, now } = view;
  const blocks = [];
  for (const name of checked) {
    const p = config.providers.find((x) => x.name === name);
    const entry = state.providers[name];
    const menu = menuFor(p, state, { kinds, now });
    const usage = currentUsage(entry, now);
    const login = probed?.[name] === false ? 'not probed' : entry.auth;
    const lines = [
      `${name} (${p.kind})`,
      `  login: ${login} (${entry.detail})`,
      `  usage: weekly ${usageText(usage.weeklyPct, entry.weeklyResetsAt)}, five hours ${usageText(usage.fiveHourPct, entry.fiveHourResetsAt)}; ceiling ${p.ceilingPct}%`,
      menu.excluded
        ? `  menu: none (excluded: ${menu.excluded}${menu.excluded === 'usage-ceiling' ? `, ${menu.detail}` : ''})`
        : `  menu: ${menu.models.map((m) => `${m.id} (${m.efforts.join(', ')})`).join(', ')}`,
    ];
    if (fixes[name]) lines.push(`  fix: ${fixes[name]}`);
    blocks.push(lines.join('\n'));
  }
  const jev = state.jev;
  const models = jev?.models?.length ? `; models: ${jev.models.join(', ')}` : '';
  const jevLine = !jev
    ? 'Jev: not checked'
    : `Jev: ${jev.ok ? 'ready' : 'not ready'} (${jev.detail}${models})${!jev.ok && jevFix ? `; fix: ${jevFix}` : ''}`;
  blocks.push(jevLine);
  return `${blocks.join('\n\n')}\n`;
}

// The state with each provider's kind, menu and (for the providers just checked) fix.
export function checkJson(view) {
  const { state, config, fixes, jevFix, kinds, now } = view;
  const providers = {};
  for (const [name, entry] of Object.entries(state.providers)) {
    const p = config.providers.find((x) => x.name === name) ?? null;
    providers[name] = { ...entry, kind: p?.kind ?? null, menu: menuFor(p, state, { kinds, now }), ...(fixes[name] ? { fix: fixes[name] } : {}) };
  }
  return { ...state, jev: state.jev ? { ...state.jev, ...(jevFix && !state.jev.ok ? { fix: jevFix } : {}) } : null, providers };
}

// Why the check failed, or null: Jev must answer with the configured model listed, and one checked provider must be
// ready.
function failure(view) {
  const reasons = [];
  if (!view.state.jev?.ok) reasons.push(view.state.jev ? `Jev: ${view.state.jev.detail}` : 'Jev: not checked');
  if (!view.checked.some((name) => view.state.providers[name]?.auth === 'ready')) reasons.push('no provider is ready');
  return reasons.length ? reasons.join('; ') : null;
}

const USAGE = 'usage: node providers.mjs check [--json] [--only <name>]...';

async function main(argv) {
  let args;
  try {
    args = parseArgs({ args: argv, options: { json: { type: 'boolean' }, only: { type: 'string', multiple: true } }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new ProvidersError(`${String(error.message).replace(/^TypeError \[[A-Z_]+\]: /, '')}\n${USAGE}`);
  }
  if (args.positionals.length !== 1 || args.positionals[0] !== 'check') throw new ProvidersError(USAGE);
  const json = args.values.json === true;
  const view = await runCheck({ only: args.values.only ?? [] });
  const reason = failure(view);
  if (json) {
    const out = { ...checkJson(view), ok: reason === null, ...(reason ? { error: reason, exitCode: 2 } : {}) };
    process.stdout.write(`${view.redact.text(JSON.stringify(out, null, 2))}\n`);
  } else {
    process.stdout.write(view.redact.text(formatCheck(view)));
  }
  if (reason) process.stderr.write(`${view.redact.text(`providers check: ${reason}`)}\n`);
  return reason ? 2 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  const json = process.argv.includes('--json');
  main(process.argv.slice(2)).then(
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
