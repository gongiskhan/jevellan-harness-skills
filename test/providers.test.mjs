// providers.mjs check: the Claude usage header probe (fake fetch and a fake Messages server), the Codex app-server
// probe (a fake app-server speaking line-delimited JSON-RPC through an injected spawner), endpoint key files, disabled
// providers, kinds without a runtime, the usage ceiling, Jev (fake fetch and a fake server), the state merge, and
// that no token or key value ever reaches the state file or the output.
//
// Nothing here reaches the real Messages API, the real Jev API or the owner's ~/.codex: in-process checks get a fake
// fetch, and every Codex provider gets a temporary CODEX_HOME or owner home; command-line runs get loopback fake
// servers through JH_ANTHROPIC_URL and JH_JEV_URL. Each test points JH_HARNESS_HOME at a fresh temporary folder.
//
// In-process checks use a temporary skills folder without the ledger skill, so the redactor is not loaded there and a
// leak in the probe code itself would show; the command-line runs go through the installed skills and the redactor,
// the way a session runs the script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { NODE, REPO, childEnv, tempDir, writeJson } from './helpers/ledger-fixture.mjs';

const ROUTER = path.join(REPO, 'skills', 'jevellan-router');
const PROVIDERS_CLI = path.join(ROUTER, 'scripts', 'providers.mjs');
const providers = await import(pathToFileURL(PROVIDERS_CLI).href);
const { checkProviders, runCheck, formatCheck, checkJson, menuFor, claudeUsage, codexUsage, cheapestModel, anthropicBase } = providers;
const { skillsWithRole } = await import(pathToFileURL(path.join(ROUTER, 'scripts', 'lib', 'roles.mjs')).href);
const { readProvidersState, ProvidersError } = await import(pathToFileURL(path.join(ROUTER, 'scripts', 'lib', 'providers-file.mjs')).href);

delete process.env.JH_JEV_URL;
delete process.env.JH_ANTHROPIC_URL;

const DAY = 24 * 60 * 60;
const secondsFromNow = (seconds) => Math.floor(Date.now() / 1000) + seconds;
const fakeSecret = (prefix) => `${prefix}-${randomBytes(18).toString('hex')}`;

const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low', 'medium'] },
];
const GPT_MODELS = [{ id: 'gpt-6-astra', label: 'GPT', efforts: ['low', 'medium', 'high'] }];

// ---- fixtures ------------------------------------------------------------------------------------------------------

function writeSecret(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${value}\n`, { mode });
  fs.chmodSync(file, mode);
}

// A fresh harness home with providers.json, a Jev key (unless jevKey is false) and the given token files.
function harness({ providerList, jevKey = true, jevModel = 'jev-latest', jevMode = 0o600 }) {
  const home = tempDir('jh-harness-');
  process.env.JH_HARNESS_HOME = home;
  const secrets = path.join(home, 'secrets');
  fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const keyFile = path.join(secrets, 'jev.key');
  const jevValue = fakeSecret('jev');
  if (jevKey) writeSecret(keyFile, jevValue, jevMode);
  writeJson(path.join(home, 'providers.json'), { jev: { keyFile, model: jevModel, timeoutMs: 3000 }, providers: providerList });
  return { home, secrets, keyFile, jevValue, stateFile: path.join(home, 'providers-state.json') };
}

// A skills folder holding runtime skills for the given kind lists, and nothing else (no ledger, so no redactor).
function skillsRoot(kindLists) {
  const root = tempDir('jh-skills-');
  kindLists.forEach((kinds, i) => {
    const dir = path.join(root, `fake-runtime-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: fake-runtime-${i}\ndescription: Runtime for tests.\njh-role: runtime\njh-kinds: [${kinds.join(', ')}]\n---\n\nA runtime for tests.\n`);
  });
  return root;
}

const CLAUDE_ROOT = skillsRoot([['claude-subscription', 'claude-endpoint']]);
const CODEX_ROOT = skillsRoot([['claude-subscription', 'claude-endpoint'], ['codex-subscription']]);

function claudeProvider(name, tokenFile, extra = {}) {
  return { name, kind: 'claude-subscription', ...(tokenFile ? { tokenFile } : {}), ceilingPct: 90, models: CLAUDE_MODELS, ...extra };
}

function usageHeaders({ weekly = '0.345', fiveHour = '0.12', weeklyReset = secondsFromNow(3 * DAY), fiveHourReset = secondsFromNow(3600) } = {}) {
  const h = {};
  if (weekly !== null) {
    h['anthropic-ratelimit-unified-7d-utilization'] = weekly;
    h['anthropic-ratelimit-unified-7d-reset'] = String(weeklyReset);
  }
  if (fiveHour !== null) {
    h['anthropic-ratelimit-unified-5h-utilization'] = fiveHour;
    h['anthropic-ratelimit-unified-5h-reset'] = String(fiveHourReset);
  }
  return h;
}

const JEV_MODELS_BODY = JSON.stringify({
  models: [
    { name: 'jev-latest', description: 'the current model', release_date: '2026-10-22' },
    { name: 'jev-preview', description: 'the preview', release_date: '2026-10-29' },
  ],
});

// A fetch that answers the Messages probe with `claude(call)` and Jev's model list with `jev(call)`; every call is
// recorded with its URL, method, headers and body.
function fakeFetch({ claude = () => new Response('{}', { status: 200, headers: usageHeaders() }), jev = () => new Response(JEV_MODELS_BODY, { status: 200 }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { url: String(url), method: init.method ?? 'GET', headers, body: init.body ?? '' };
    calls.push(call);
    if (call.url.endsWith('/v1/messages')) return claude(call);
    if (call.url.endsWith('/models')) return jev(call);
    throw new TypeError('fetch failed');
  };
  return { fetch: fetchImpl, calls, messages: () => calls.filter((c) => c.url.endsWith('/v1/messages')), jevCalls: () => calls.filter((c) => c.url.endsWith('/models')) };
}

// A fake `codex app-server`: line-delimited JSON-RPC on stdio; it logs every message it receives with the CODEX_HOME
// and HOME it was started with. Scenarios: ready (a weekly window as primary and a five-hour one as secondary),
// unauthorized (401 on account/rateLimits/read), nologin (account null).
const FAKE_CODEX = `
import fs from 'node:fs';
import readline from 'node:readline';
const [configFile, logFile] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(logFile, JSON.stringify({ msg, codexHome: process.env.CODEX_HOME ?? null, home: process.env.HOME ?? null, argv: process.argv.slice(4) }) + '\\n');
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ id: msg.id, result: { userAgent: 'fake-codex/0.0.0' } });
  if (msg.method === 'account/read') {
    send({ method: 'account/updated', params: {} });
    if (config.scenario === 'nologin') return send({ id: msg.id, result: { account: null, requiresOpenaiAuth: true } });
    return send({ id: msg.id, result: { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true } });
  }
  if (msg.method === 'account/rateLimits/read') {
    if (config.scenario === 'unauthorized') {
      return send({ id: msg.id, error: { code: -32603, message: 'failed to fetch codex rate limits: unexpected status 401 Unauthorized: Please try signing in again' } });
    }
    send({ id: msg.id, method: 'item/tool/requestUserInput', params: {} });
    return send({ id: msg.id, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: config.weekReset }, secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: config.fiveReset } }, rateLimitsByLimitId: null } });
  }
  send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
});
`;
const FAKE_CODEX_FILE = path.join(tempDir('jh-fake-codex-'), 'fake-codex-app-server.mjs');
fs.writeFileSync(FAKE_CODEX_FILE, FAKE_CODEX);

// A spawner that runs the fake app-server instead of codex, recording what the probe asked for.
function fakeCodex(scenario) {
  const dir = tempDir('jh-codex-run-');
  const configFile = path.join(dir, 'config.json');
  const logFile = path.join(dir, 'log.jsonl');
  const weekReset = secondsFromNow(4 * DAY);
  const fiveReset = secondsFromNow(2 * 3600);
  writeJson(configFile, { scenario, weekReset, fiveReset });
  const spawns = [];
  const spawner = (command, args, options) => {
    spawns.push({ command, args, options });
    return spawn(NODE, [FAKE_CODEX_FILE, configFile, logFile, ...args], options);
  };
  const log = () => {
    try {
      return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { spawner, spawns, log, weekReset, fiveReset };
}

// A Codex home with a stored login file, whose content and mtime the probe must leave alone.
function codexHome() {
  const dir = path.join(tempDir('jh-codexhome-'), '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const auth = path.join(dir, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({ tokens: { access_token: fakeSecret('codex-access'), refresh_token: fakeSecret('codex-refresh') } }), { mode: 0o600 });
  return { dir, auth, before: { text: fs.readFileSync(auth, 'utf8'), mtimeMs: fs.statSync(auth).mtimeMs } };
}

// ---- command-line fixtures -----------------------------------------------------------------------------------------

async function fakeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const request = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(request);
      handler(request, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

function anthropicServer(goodToken, headers = usageHeaders()) {
  return fakeServer((request, res) => {
    if (request.method === 'POST' && request.url === '/v1/messages' && request.headers.authorization === `Bearer ${goodToken}`) {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end('{"id":"msg_fake","content":[]}');
    } else {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"type":"authentication_error"}}');
    }
  });
}

function jevServer(goodKey) {
  return fakeServer((request, res) => {
    if (request.method === 'GET' && request.url === '/v1/models' && request.headers.authorization === `Bearer ${goodKey}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JEV_MODELS_BODY);
    } else {
      res.writeHead(401);
      res.end();
    }
  });
}

// Runs providers.mjs as a session would; asynchronous, so the fake servers in this process can answer it.
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [PROVIDERS_CLI, ...args], { cwd: REPO, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// Every file under `dir` but the secret files themselves, as one text.
function filesText(dir, skip) {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (skip.includes(file)) continue;
    if (entry.isDirectory()) out += filesText(file, skip);
    else if (entry.isFile()) out += fs.readFileSync(file, 'utf8');
  }
  return out;
}

function assertNoSecret(texts, secrets) {
  for (const secret of secrets) {
    for (const [where, text] of Object.entries(texts)) assert.equal(text.includes(secret), false, `a secret value appears in ${where}`);
  }
}

// ---- pure parts ----------------------------------------------------------------------------------------------------

test('claudeUsage reads the five-hour and weekly windows from the unified rate limit headers', () => {
  const weeklyReset = secondsFromNow(3 * DAY);
  const usage = claudeUsage(new Headers(usageHeaders({ weekly: '0.345', fiveHour: '1.2', weeklyReset })));
  assert.equal(usage.weeklyPct, 34.5);
  assert.equal(usage.fiveHourPct, 100, 'utilization above 1 is capped at 100 percent');
  assert.equal(usage.weeklyResetsAt, new Date(weeklyReset * 1000).toISOString());
  assert.equal(claudeUsage(new Headers({})), null);
  const partial = claudeUsage(new Headers(usageHeaders({ weekly: 'garbage', fiveHour: '0.5' })));
  assert.equal(partial.weeklyPct, null);
  assert.equal(partial.weeklyResetsAt, null);
  assert.equal(partial.fiveHourPct, 50);
});

test('codexUsage decides the windows by duration and prefers the codex limit', () => {
  const week = { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1_800_000_000 };
  const five = { usedPercent: 12, windowDurationMins: 300, resetsAt: null };
  const usage = codexUsage({ rateLimits: { limitId: 'codex', primary: week, secondary: five } });
  assert.deepEqual(usage, { weeklyPct: 41, fiveHourPct: 12, weeklyResetsAt: new Date(1_800_000_000_000).toISOString(), fiveHourResetsAt: null });
  const byId = codexUsage({ rateLimits: { limitId: 'other', primary: five }, rateLimitsByLimitId: { codex: { limitId: 'codex', primary: week } } });
  assert.equal(byId.weeklyPct, 41);
  assert.equal(byId.fiveHourPct, null);
  assert.equal(codexUsage({ rateLimits: { limitId: 'other', primary: week } }), null, 'another limit is not the codex quota');
  assert.equal(codexUsage({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: null } } }), null);
  assert.throws(() => codexUsage({ rateLimits: { primary: { usedPercent: -1 } } }));
});

test('the probe model is the cheapest of the list, and JH_ANTHROPIC_URL is accepted only on the loopback interface', () => {
  assert.equal(cheapestModel({ models: CLAUDE_MODELS }).id, 'claude-haiku-5-5');
  assert.equal(cheapestModel({ models: [{ id: 'a' }, { id: 'b' }] }).id, 'b');
  assert.equal(anthropicBase({}), 'https://api.anthropic.com');
  assert.equal(anthropicBase({ JH_ANTHROPIC_URL: 'http://127.0.0.1:4100/' }), 'http://127.0.0.1:4100');
  assert.throws(() => anthropicBase({ JH_ANTHROPIC_URL: 'https://example.com' }), ProvidersError);
  assert.throws(() => anthropicBase({ JH_ANTHROPIC_URL: 'http://127.0.0.1.example.com' }), ProvidersError);
});

// ---- Claude subscriptions ------------------------------------------------------------------------------------------

test('claude-subscription: ready with usage from the headers; the token travels only in the Authorization header', async () => {
  const tokenFile = path.join(tempDir('jh-tok-'), 'main.token');
  const token = fakeSecret('sk-fake-oauth');
  writeSecret(tokenFile, token);
  const h = harness({ providerList: [claudeProvider('claude-main', tokenFile)] });
  const fake = fakeFetch();
  const state = await checkProviders({ deps: { fetch: fake.fetch, skillsRoot: CLAUDE_ROOT } });
  const entry = state.providers['claude-main'];
  assert.equal(entry.auth, 'ready');
  assert.equal(entry.weeklyPct, 34.5);
  assert.equal(entry.fiveHourPct, 12);
  assert.match(entry.weeklyResetsAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(entry.fiveHourResetsAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Math.abs(Date.parse(entry.observedAt) - Date.now()) < 60_000);
  const [call] = fake.messages();
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, `Bearer ${token}`);
  assert.equal(call.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(call.body);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.max_tokens, 1);
  assert.equal(call.body.includes(token), false);
  assert.equal(call.url.includes(token), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.stateFile, 'utf8')), state, 'the returned state is the state written');
  assert.equal((fs.statSync(h.stateFile).mode & 0o777).toString(8), '600');
});

test('claude-subscription: 401 and 403 need a login, 429 is ready, other statuses and network errors are unknown', async () => {
  const tokenFile = path.join(tempDir('jh-tok-'), 'x.token');
  const token = fakeSecret('sk-fake-oauth');
  writeSecret(tokenFile, token);
  const cases = [
    [() => new Response('{"error":"' + token + '"}', { status: 401 }), 'needs-login', /refused this token/],
    [() => new Response('', { status: 403 }), 'needs-login', /refused this token/],
    [() => new Response('', { status: 429, headers: usageHeaders({ weekly: '1', fiveHour: '1' }) }), 'ready', /rate limited/],
    [() => new Response('', { status: 500 }), 'unknown', /HTTP 500/],
    [() => { throw new TypeError(`fetch failed for ${token}`); }, 'unknown', /^the probe could not connect$/],
  ];
  for (const [claude, auth, detail] of cases) {
    const h = harness({ providerList: [claudeProvider('claude-main', tokenFile)] });
    const view = await runCheck({ deps: { fetch: fakeFetch({ claude }).fetch, skillsRoot: CLAUDE_ROOT } });
    const entry = view.state.providers['claude-main'];
    assert.equal(entry.auth, auth, `${detail}`);
    assert.match(entry.detail, detail);
    if (auth === 'needs-login') assert.match(view.fixes['claude-main'], /write a token .* to .*x\.token, mode 600/);
    if (auth === 'ready') assert.equal(entry.weeklyPct, 100);
    assertNoSecret({ state: fs.readFileSync(h.stateFile, 'utf8'), text: formatCheck(view), json: JSON.stringify(checkJson(view)) }, [token]);
  }
});

test('claude-subscription: no tokenFile, or a missing token file, needs a login without any request', async () => {
  harness({ providerList: [claudeProvider('no-file'), claudeProvider('gone', path.join(tempDir('jh-tok-'), 'absent.token'))] });
  const fake = fakeFetch();
  const view = await runCheck({ deps: { fetch: fake.fetch, skillsRoot: CLAUDE_ROOT } });
  assert.equal(view.state.providers['no-file'].auth, 'needs-login');
  assert.equal(view.state.providers['no-file'].detail, 'no tokenFile: write the token to a file and name it in providers.json');
  assert.equal(view.state.providers.gone.auth, 'needs-login');
  assert.match(view.state.providers.gone.detail, /^token file missing \(.*absent\.token\)$/);
  assert.equal(fake.messages().length, 0);
  assert.match(formatCheck(view), /no-file \(claude-subscription\)\n {2}login: needs-login \(no tokenFile: write the token to a file and name it in providers\.json\)/);
});

// ---- endpoints, disabled providers, kinds without a runtime --------------------------------------------------------

test('claude-endpoint is not probed: ready with a key file, needs-login "key file missing" without one', async () => {
  const dir = tempDir('jh-keys-');
  const key = fakeSecret('glm-key');
  writeSecret(path.join(dir, 'with.key'), key);
  const endpoint = (name, keyFile) => ({ name, kind: 'claude-endpoint', baseUrl: 'https://api.z.ai/api/anthropic', keyFile, models: [{ id: 'glm-5.3', label: 'GLM', efforts: ['low', 'medium'] }] });
  const h = harness({ providerList: [endpoint('with-key', path.join(dir, 'with.key')), endpoint('without-key', path.join(dir, 'missing.key'))] });
  const fake = fakeFetch();
  const view = await runCheck({ deps: { fetch: fake.fetch, skillsRoot: CLAUDE_ROOT } });
  assert.equal(view.state.providers['with-key'].auth, 'ready');
  assert.equal(view.state.providers['with-key'].detail, 'key file present; not probed');
  assert.equal(view.state.providers['without-key'].auth, 'needs-login');
  assert.match(view.state.providers['without-key'].detail, /^key file missing \(.*missing\.key\)$/);
  assert.equal(fake.messages().length, 0, 'an endpoint is never probed');
  const json = checkJson(view);
  assert.deepEqual(json.providers['with-key'].menu.models, [{ id: 'glm-5.3', efforts: ['low', 'medium'] }]);
  assert.equal(json.providers['without-key'].menu.excluded, 'needs-login');
  assert.match(formatCheck(view), /with-key \(claude-endpoint\)\n {2}login: ready \(key file present; not probed\)\n {2}usage: weekly unknown, five hours unknown; ceiling 90%\n {2}menu: glm-5\.3 \(low, medium\)/);
  assertNoSecret({ state: fs.readFileSync(h.stateFile, 'utf8'), text: formatCheck(view) }, [key]);
});

test('a disabled provider and a kind with no runtime skill are reported, not probed, and excluded from the menu', async () => {
  const tokenFile = path.join(tempDir('jh-tok-'), 'off.token');
  writeSecret(tokenFile, fakeSecret('sk-fake-oauth'));
  harness({
    providerList: [
      claudeProvider('off', tokenFile, { enabled: false }),
      { name: 'kimi', kind: 'openai-compatible', baseUrl: 'https://api.moonshot.ai/v1', models: [{ id: 'kimi-k2', label: 'Kimi', efforts: ['low'] }] },
      { name: 'codex', kind: 'codex-subscription', codexHome: codexHome().dir, models: GPT_MODELS },
    ],
  });
  const fake = fakeFetch();
  const codex = fakeCodex('ready');
  const view = await runCheck({ deps: { fetch: fake.fetch, spawn: codex.spawner, skillsRoot: CLAUDE_ROOT } });
  assert.equal(view.state.providers.off.detail, 'disabled in providers.json');
  assert.equal(view.state.providers.kimi.detail, 'no runtime skill for kind openai-compatible');
  assert.equal(view.state.providers.codex.detail, 'no runtime skill for kind codex-subscription');
  assert.equal(fake.messages().length, 0);
  assert.equal(codex.spawns.length, 0, 'no app-server without a runtime for the kind');
  const json = checkJson(view);
  assert.equal(json.providers.off.menu.excluded, 'disabled');
  assert.equal(json.providers.kimi.menu.excluded, 'no-runtime');
  assert.equal(json.providers.codex.menu.excluded, 'no-runtime');
  const text = formatCheck(view);
  assert.match(text, /off \(claude-subscription\)\n {2}login: not probed \(disabled in providers\.json\)\n.*\n {2}menu: none \(excluded: disabled\)/);
  assert.match(text, /kimi \(openai-compatible\)\n {2}login: not probed \(no runtime skill for kind openai-compatible\)\n.*\n {2}menu: none \(excluded: no-runtime\)/);
});

// ---- Codex ---------------------------------------------------------------------------------------------------------

test('codex-subscription: app-server under CODEX_HOME, account/read without a refresh, weekly from the 10080-minute window', async () => {
  const home = codexHome();
  harness({ providerList: [{ name: 'codex', kind: 'codex-subscription', codexHome: home.dir, ceilingPct: 90, models: GPT_MODELS }] });
  const codex = fakeCodex('ready');
  const ownerHome = tempDir('jh-owner-');
  const base = { PATH: process.env.PATH, LANG: 'C.UTF-8', JH_TASK: 'TABCDEF', SOME_TOKEN: fakeSecret('leak'), HOME: '/elsewhere' };
  const view = await runCheck({ deps: { fetch: fakeFetch().fetch, spawn: codex.spawner, skillsRoot: CODEX_ROOT, env: base, home: ownerHome } });
  const entry = view.state.providers.codex;
  assert.equal(entry.auth, 'ready');
  assert.equal(entry.detail, 'ChatGPT plus answered account/rateLimits/read');
  assert.equal(entry.weeklyPct, 41);
  assert.equal(entry.fiveHourPct, 12);
  assert.equal(entry.weeklyResetsAt, new Date(codex.weekReset * 1000).toISOString());
  assert.equal(entry.fiveHourResetsAt, new Date(codex.fiveReset * 1000).toISOString());
  const [spawned] = codex.spawns;
  assert.equal(spawned.command, 'codex');
  assert.deepEqual(spawned.args, ['app-server']);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.env.CODEX_HOME, home.dir);
  assert.equal(spawned.options.env.HOME, ownerHome);
  assert.deepEqual(Object.keys(spawned.options.env).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'PATH'], 'only the base variables and the Codex home');
  const log = codex.log();
  assert.deepEqual(log.map((l) => l.msg.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.deepEqual(log.find((l) => l.msg.method === 'account/read').msg.params, { refreshToken: false });
  assert.ok(log.every((l) => l.codexHome === home.dir));
  assert.equal(fs.readFileSync(home.auth, 'utf8'), home.before.text, 'auth.json is untouched');
  assert.equal(fs.statSync(home.auth).mtimeMs, home.before.mtimeMs);
  assert.deepEqual(checkJson(view).providers.codex.menu.models, [{ id: 'gpt-6-astra', efforts: ['low', 'medium', 'high'] }]);
});

test('codex-subscription: 401 on account/rateLimits/read needs "codex login"; the default CODEX_HOME is the owner home\'s .codex', async () => {
  const ownerHome = tempDir('jh-owner-');
  fs.mkdirSync(path.join(ownerHome, '.codex'));
  harness({ providerList: [{ name: 'codex', kind: 'codex-subscription', models: GPT_MODELS }] });
  const codex = fakeCodex('unauthorized');
  const view = await runCheck({ deps: { fetch: fakeFetch().fetch, spawn: codex.spawner, skillsRoot: CODEX_ROOT, home: ownerHome } });
  const entry = view.state.providers.codex;
  assert.equal(entry.auth, 'needs-login');
  assert.match(entry.detail, /refused the stored login/);
  assert.equal(entry.detail.includes('Please try signing in again'), false, 'the server text stays out');
  assert.equal(view.fixes.codex, 'codex login');
  assert.equal(codex.spawns[0].options.env.CODEX_HOME, path.join(ownerHome, '.codex'));
  assert.match(formatCheck(view), /codex \(codex-subscription\)\n {2}login: needs-login \(.*\)\n.*\n {2}menu: none \(excluded: needs-login\)\n {2}fix: codex login/);
});

test('codex-subscription: no stored login, no CODEX_HOME folder, and codex not on PATH', async () => {
  const home = codexHome();
  harness({ providerList: [{ name: 'codex', kind: 'codex-subscription', codexHome: home.dir, models: GPT_MODELS }] });
  const nologin = fakeCodex('nologin');
  let view = await runCheck({ deps: { fetch: fakeFetch().fetch, spawn: nologin.spawner, skillsRoot: CODEX_ROOT } });
  assert.equal(view.state.providers.codex.auth, 'needs-login');
  assert.match(view.state.providers.codex.detail, /no Codex login is stored/);
  assert.equal(view.fixes.codex, `CODEX_HOME=${home.dir} codex login`);
  assert.equal(nologin.log().some((l) => l.msg.method === 'account/rateLimits/read'), false);

  const absent = path.join(tempDir('jh-codexhome-'), 'never-made');
  harness({ providerList: [{ name: 'codex', kind: 'codex-subscription', codexHome: absent, models: GPT_MODELS }] });
  const unused = fakeCodex('ready');
  view = await runCheck({ deps: { fetch: fakeFetch().fetch, spawn: unused.spawner, skillsRoot: CODEX_ROOT } });
  assert.equal(view.state.providers.codex.auth, 'needs-login');
  assert.equal(view.state.providers.codex.detail, `no Codex login: ${absent} does not exist`);
  assert.equal(unused.spawns.length, 0, 'no app-server is started for a home that does not exist');
  assert.equal(fs.existsSync(absent), false);

  harness({ providerList: [{ name: 'codex', kind: 'codex-subscription', codexHome: home.dir, models: GPT_MODELS }] });
  view = await runCheck({ deps: { fetch: fakeFetch().fetch, skillsRoot: CODEX_ROOT, env: { PATH: tempDir('jh-empty-path-') } } });
  assert.equal(view.state.providers.codex.auth, 'unknown');
  assert.equal(view.state.providers.codex.detail, 'codex is not on PATH');
  assert.match(view.fixes.codex, /install Codex/);
});

// ---- the usage ceiling ---------------------------------------------------------------------------------------------

test('a provider at or above its ceiling on either window is excluded with usage-ceiling', async () => {
  const dir = tempDir('jh-tok-');
  const names = { weekly: '0.95', exact: '0.5', under: '0.899' };
  const list = Object.keys(names).map((name) => {
    writeSecret(path.join(dir, `${name}.token`), `token-for-${name}-${randomBytes(8).toString('hex')}`);
    return claudeProvider(name, path.join(dir, `${name}.token`));
  });
  harness({ providerList: list });
  const claude = (call) => {
    const which = Object.keys(names).find((name) => call.headers.authorization.includes(`token-for-${name}-`));
    const headers = which === 'exact' ? usageHeaders({ weekly: '0.5', fiveHour: '0.9' }) : usageHeaders({ weekly: names[which], fiveHour: '0.1' });
    return new Response('{}', { status: 200, headers });
  };
  const view = await runCheck({ deps: { fetch: fakeFetch({ claude }).fetch, skillsRoot: CLAUDE_ROOT } });
  const json = checkJson(view);
  assert.equal(json.providers.weekly.menu.excluded, 'usage-ceiling');
  assert.equal(json.providers.weekly.menu.detail, 'weekly usage 95% is at or above the 90% ceiling');
  assert.equal(json.providers.exact.menu.excluded, 'usage-ceiling', 'five hours at exactly the ceiling is excluded');
  assert.match(json.providers.exact.menu.detail, /^five-hour usage 90% /);
  assert.equal(json.providers.under.menu.excluded, null);
  assert.deepEqual(json.providers.under.menu.models.map((m) => m.id), ['claude-opus-5-5', 'claude-haiku-5-5']);
  const text = formatCheck(view);
  assert.match(text, /weekly \(claude-subscription\)\n {2}login: ready \(the probe on claude-haiku-5-5 answered\)\n {2}usage: weekly 95% \(resets [^)]+\), five hours 10% \(resets [^)]+\); ceiling 90%\n {2}menu: none \(excluded: usage-ceiling, weekly usage 95% is at or above the 90% ceiling\)/);
  assert.match(text, /under \(claude-subscription\)\n.*\n.*weekly 89\.9%.*\n {2}menu: claude-opus-5-5 \(low, medium, high\), claude-haiku-5-5 \(low, medium\)/);
});

test('menuFor: a window that has reset no longer counts, and a missing or stale probe is not-probed', () => {
  const provider = { name: 'p', kind: 'claude-subscription', enabled: true, ceilingPct: 90, models: CLAUDE_MODELS };
  const now = Date.now();
  const entry = (extra) => ({ auth: 'ready', detail: 'ok', weeklyPct: 99, fiveHourPct: null, weeklyResetsAt: null, fiveHourResetsAt: null, observedAt: new Date(now - 1000).toISOString(), ...extra });
  const kinds = new Set(['claude-subscription']);
  assert.equal(menuFor(provider, { providers: { p: entry({}) } }, { kinds, now }).excluded, 'usage-ceiling');
  assert.equal(menuFor(provider, { providers: { p: entry({ weeklyResetsAt: new Date(now - 60_000).toISOString() }) } }, { kinds, now }).excluded, null);
  assert.equal(menuFor(provider, { providers: {} }, { kinds, now }).excluded, 'not-probed');
  assert.equal(menuFor(provider, { providers: { p: entry({ observedAt: new Date(now - 13 * 3600 * 1000).toISOString() }) } }, { kinds, now }).excluded, 'not-probed');
  assert.equal(menuFor(provider, { providers: { p: entry({ auth: 'unknown' }) } }, { kinds, now }).excluded, 'login-unknown');
  assert.equal(menuFor(null, { providers: {} }, { kinds, now }).excluded, 'not-configured');
});

// ---- Jev -----------------------------------------------------------------------------------------------------------

test('Jev: ok when the configured model is listed; not listed, no key, a loose key file and a refused key are not ok', async () => {
  const tokenFile = path.join(tempDir('jh-tok-'), 'main.token');
  writeSecret(tokenFile, fakeSecret('sk-fake-oauth'));
  const providerList = [claudeProvider('claude-main', tokenFile)];

  let h = harness({ providerList });
  let fake = fakeFetch();
  let state = await checkProviders({ deps: { fetch: fake.fetch, skillsRoot: CLAUDE_ROOT } });
  assert.equal(state.jev.ok, true);
  assert.deepEqual(state.jev.models, ['jev-latest', 'jev-preview']);
  assert.equal(state.jev.configured, 'jev-latest');
  assert.equal(state.jev.detail, 'reachable, jev-latest listed');
  assert.match(state.jev.checkedAt, /^\d{4}-/);
  assert.equal(fake.jevCalls()[0].headers.authorization, `Bearer ${h.jevValue}`);

  harness({ providerList, jevModel: 'jev-next' });
  state = await checkProviders({ deps: { fetch: fakeFetch().fetch, skillsRoot: CLAUDE_ROOT } });
  assert.equal(state.jev.ok, false);
  assert.match(state.jev.detail, /jev-next is not listed \(listed: jev-latest, jev-preview\)/);

  harness({ providerList, jevKey: false });
  fake = fakeFetch();
  const view = await runCheck({ deps: { fetch: fake.fetch, skillsRoot: CLAUDE_ROOT } });
  assert.equal(view.state.jev.ok, false);
  assert.equal(view.state.jev.detail, 'no key configured');
  assert.equal(fake.jevCalls().length, 0);
  assert.match(formatCheck(view), /\n\nJev: not ready \(no key configured\); fix: write the Jev key to .*jev\.key and run chmod 600 .*jev\.key\n$/);

  h = harness({ providerList, jevMode: 0o644 });
  state = await checkProviders({ deps: { fetch: fakeFetch().fetch, skillsRoot: CLAUDE_ROOT } });
  assert.equal(state.jev.ok, false);
  assert.equal(state.jev.detail, `the key file ${h.keyFile} has mode 644, not 600`);

  harness({ providerList });
  state = await checkProviders({ deps: { fetch: fakeFetch({ jev: () => new Response('', { status: 401 }) }).fetch, skillsRoot: CLAUDE_ROOT } });
  assert.equal(state.jev.ok, false);
  assert.equal(state.jev.detail, 'authentication failed');
});

// ---- the merge -----------------------------------------------------------------------------------------------------

test('--only probes the named provider and keeps every other entry of the state file; an unknown name is not found', async () => {
  const dir = tempDir('jh-tok-');
  writeSecret(path.join(dir, 'a.token'), fakeSecret('sk-fake-oauth'));
  writeSecret(path.join(dir, 'b.token'), fakeSecret('sk-fake-oauth'));
  const h = harness({ providerList: [claudeProvider('claude-main', path.join(dir, 'a.token')), claudeProvider('claude-second', path.join(dir, 'b.token'))] });
  const kept = { auth: 'needs-login', detail: 'from an earlier check', weeklyPct: 7, fiveHourPct: null, weeklyResetsAt: null, fiveHourResetsAt: null, observedAt: '2026-11-01T00:00:00.000Z' };
  const gone = { ...kept, detail: 'a provider no longer in providers.json' };
  const earlierJev = { ok: true, models: ['jev-latest'], configured: 'jev-latest', detail: 'earlier', checkedAt: '2026-11-01T00:00:00.000Z' };
  writeJson(h.stateFile, { checkedAt: '2026-11-01T00:00:00.000Z', jev: earlierJev, providers: { 'claude-second': kept, 'old-one': gone } });
  const fake = fakeFetch();
  const state = await checkProviders({ only: ['claude-main', 'claude-main'], deps: { fetch: fake.fetch, skillsRoot: CLAUDE_ROOT }, jev: false });
  assert.equal(fake.messages().length, 1, 'one probe, for the named provider only');
  assert.equal(state.providers['claude-main'].auth, 'ready');
  assert.deepEqual(state.providers['claude-second'], kept);
  assert.deepEqual(state.providers['old-one'], gone);
  assert.deepEqual(state.jev, earlierJev, 'jev: false keeps the recorded Jev state');
  assert.notEqual(state.checkedAt, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(readProvidersState(h.stateFile), state);

  await assert.rejects(checkProviders({ only: ['nobody'], deps: { fetch: fake.fetch, skillsRoot: CLAUDE_ROOT } }), (error) => error.exitCode === 3 && /no provider "nobody"/.test(error.message));
  assert.deepEqual(readProvidersState(h.stateFile), state, 'a refused check writes nothing');
});

// ---- the command line ----------------------------------------------------------------------------------------------

test('command line: text blocks, the Jev line and exit 0; no token or key in the output, the state file or any other file', async () => {
  const dir = tempDir('jh-tok-');
  const good = fakeSecret('sk-fake-oauth');
  const refused = fakeSecret('sk-fake-oauth');
  writeSecret(path.join(dir, 'main.token'), good);
  writeSecret(path.join(dir, 'second.token'), refused);
  const h = harness({
    providerList: [
      claudeProvider('claude-main', path.join(dir, 'main.token')),
      claudeProvider('claude-second', path.join(dir, 'second.token')),
      { name: 'glm', kind: 'claude-endpoint', baseUrl: 'https://api.z.ai/api/anthropic', keyFile: path.join(dir, 'glm.key'), models: [{ id: 'glm-5.3', label: 'GLM', efforts: ['low'] }] },
      { name: 'kimi', kind: 'openai-compatible', baseUrl: 'https://api.moonshot.ai/v1', keyFile: path.join(dir, 'kimi.key'), models: [{ id: 'kimi-k2', label: 'Kimi', efforts: ['low'] }] },
      claudeProvider('off', path.join(dir, 'main.token'), { enabled: false }),
    ],
  });
  const anthropic = await anthropicServer(good);
  const jev = await jevServer(h.jevValue);
  try {
    const env = { JH_HARNESS_HOME: h.home, JH_ANTHROPIC_URL: anthropic.url, JH_JEV_URL: `${jev.url}/v1` };
    const r = await runCli(['check'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.match(r.stdout, /^claude-main \(claude-subscription\)\n {2}login: ready \(the probe on claude-haiku-5-5 answered\)\n {2}usage: weekly 34\.5% \(resets [^)]+\), five hours 12% \(resets [^)]+\); ceiling 90%\n {2}menu: claude-opus-5-5 \(low, medium, high\), claude-haiku-5-5 \(low, medium\)\n\n/);
    assert.match(r.stdout, /claude-second \(claude-subscription\)\n {2}login: needs-login \(the provider refused this token\)\n {2}usage: weekly unknown, five hours unknown; ceiling 90%\n {2}menu: none \(excluded: needs-login\)\n {2}fix: write a token/);
    assert.match(r.stdout, /glm \(claude-endpoint\)\n {2}login: needs-login \(key file missing \(.*glm\.key\)\)/);
    if (skillsWithRole('runtime', { kind: 'openai-compatible' }).length === 0) {
      assert.match(r.stdout, /kimi \(openai-compatible\)\n {2}login: not probed \(no runtime skill for kind openai-compatible\)/);
    }
    assert.match(r.stdout, /off \(claude-subscription\)\n {2}login: not probed \(disabled in providers\.json\)/);
    assert.match(r.stdout, /\n\nJev: ready \(reachable, jev-latest listed; models: jev-latest, jev-preview\)\n$/);
    assert.equal(anthropic.requests.length, 2, 'one probe per enabled Claude subscription');
    for (const request of anthropic.requests) {
      assert.equal(request.url, '/v1/messages');
      assert.equal(request.body.includes(good) || request.body.includes(refused), false);
    }
    const state = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'));
    assert.equal(state.providers['claude-main'].auth, 'ready');
    assert.equal(state.jev.ok, true);
    const secrets = [good, refused, h.jevValue];
    assertNoSecret({ stdout: r.stdout, stderr: r.stderr, 'the state file': fs.readFileSync(h.stateFile, 'utf8') }, secrets);
    assertNoSecret({ 'the harness home': filesText(h.home, [h.keyFile]) }, secrets);

    const j = await runCli(['check', '--json'], env);
    assert.equal(j.status, 0, j.stderr);
    const out = JSON.parse(j.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.exitCode, undefined);
    assert.deepEqual(out.providers['claude-main'].menu, { models: [{ id: 'claude-opus-5-5', efforts: ['low', 'medium', 'high'] }, { id: 'claude-haiku-5-5', efforts: ['low', 'medium'] }], excluded: null, detail: null });
    assert.equal(out.providers['claude-main'].kind, 'claude-subscription');
    assert.equal(out.providers['claude-second'].menu.excluded, 'needs-login');
    assert.match(out.providers['claude-second'].fix, /write a token/);
    assert.equal(out.providers.off.menu.excluded, 'disabled');
    assert.equal(out.jev.ok, true);
    assertNoSecret({ 'json stdout': j.stdout, 'json stderr': j.stderr }, secrets);
  } finally {
    await anthropic.close();
    await jev.close();
  }
});

test('command line: exit 2 with the reason when Jev has no key or no provider is ready; exit 3 for an unknown --only name', async () => {
  const dir = tempDir('jh-tok-');
  const good = fakeSecret('sk-fake-oauth');
  writeSecret(path.join(dir, 'main.token'), good);
  const providerList = [claudeProvider('claude-main', path.join(dir, 'main.token')), claudeProvider('no-file')];
  const anthropic = await anthropicServer(good);
  let h = harness({ providerList, jevKey: false });
  const jev = await jevServer('a-key-nobody-has');
  try {
    let env = { JH_HARNESS_HOME: h.home, JH_ANTHROPIC_URL: anthropic.url, JH_JEV_URL: `${jev.url}/v1` };
    let r = await runCli(['check'], env);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'providers check: Jev: no key configured\n');
    assert.match(r.stdout, /Jev: not ready \(no key configured\); fix: write the Jev key/);
    assert.equal(jev.requests.length, 0);

    r = await runCli(['check', '--json'], env);
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, 2);
    assert.equal(out.error, 'Jev: no key configured');
    assert.equal(out.providers['claude-main'].auth, 'ready');

    h = harness({ providerList });
    const jevOk = await jevServer(h.jevValue);
    try {
      env = { JH_HARNESS_HOME: h.home, JH_ANTHROPIC_URL: anthropic.url, JH_JEV_URL: `${jevOk.url}/v1` };
      r = await runCli(['check', '--only', 'no-file'], env);
      assert.equal(r.status, 2);
      assert.equal(r.stderr, 'providers check: no provider is ready\n');
      assert.match(r.stdout, /^no-file \(claude-subscription\)\n/);
      assert.equal(r.stdout.includes('claude-main'), false, 'only the named provider is printed');
      assert.match(r.stdout, /Jev: ready/);

      r = await runCli(['check', '--only', 'claude-main'], env);
      assert.equal(r.status, 0, r.stderr);

      r = await runCli(['check', '--json', '--only', 'nobody'], env);
      assert.equal(r.status, 3);
      assert.deepEqual(JSON.parse(r.stdout), { error: `no provider "nobody" in ${path.join(h.home, 'providers.json')}`, exitCode: 3 });
      assert.match(r.stderr, /no provider "nobody"/);
    } finally {
      await jevOk.close();
    }
  } finally {
    await anthropic.close();
    await jev.close();
  }
});

test('command line: a non-loopback JH_ANTHROPIC_URL and bad usage are refused with exit 2 before any request', async () => {
  const dir = tempDir('jh-tok-');
  writeSecret(path.join(dir, 'main.token'), fakeSecret('sk-fake-oauth'));
  const h = harness({ providerList: [claudeProvider('claude-main', path.join(dir, 'main.token'))] });
  const jev = await jevServer(h.jevValue);
  try {
    let r = await runCli(['check'], { JH_HARNESS_HOME: h.home, JH_ANTHROPIC_URL: 'https://example.com', JH_JEV_URL: `${jev.url}/v1` });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /JH_ANTHROPIC_URL must be an http URL on 127\.0\.0\.1 or localhost/);
    assert.equal(jev.requests.length, 0);
    assert.equal(fs.existsSync(h.stateFile), false);

    r = await runCli([], { JH_HARNESS_HOME: h.home });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: node providers\.mjs check \[--json\] \[--only <name>\]\.\.\./);
    r = await runCli(['check', '--bogus'], { JH_HARNESS_HOME: h.home });
    assert.equal(r.status, 2);
    r = await runCli(['check', '--json', '--bogus'], { JH_HARNESS_HOME: h.home });
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).exitCode, 2);
  } finally {
    await jev.close();
  }
});
