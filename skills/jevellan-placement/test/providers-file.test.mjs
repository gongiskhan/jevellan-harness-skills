// providers.json and providers-state.json (lib/providers-file.mjs): strict validation with the defaults and the
// "same as" lists, the paths under JH_HARNESS_HOME, and the probe results' freshness and usage windows. Runs with only
// this skill present.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, writeJson } from './helpers/fixture.mjs';
import {
  ProvidersError,
  STATE_FRESH_MS,
  currentUsage,
  findProvider,
  freshProviderState,
  loadProviders,
  ownerHome,
  parseProviders,
  providersPath,
  providersStatePath,
  readProvidersState,
  secretFile,
  secretPresent,
  writeProvidersState,
} from '../scripts/lib/providers-file.mjs';

const MODELS = [{ id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'high'] }];
const JEV = { keyFile: '~/.jevellan-harness/secrets/jev.key', model: 'jev-latest' };
const refusal = (message) => (error) => error instanceof ProvidersError && error.exitCode === 2 && error.message === message;

describe('providers.json', () => {
  test('defaults, "same as" lists and home-relative paths', () => {
    const config = parseProviders({
      jev: JEV,
      providers: [
        { name: 'claude-main', kind: 'claude-subscription', tokenFile: '~/.jevellan-harness/secrets/main.token', models: MODELS },
        { name: 'claude-second', kind: 'claude-subscription', models: 'same as claude-main', ceilingPct: 70, enabled: false },
        { name: 'glm', kind: 'claude-endpoint', baseUrl: 'https://api.z.ai/api/anthropic', keyFile: '/keys/glm.key', paidUse: 'never', models: [{ id: 'glm-5.3', label: 'GLM', efforts: ['low'], maxTokens: 4096 }] },
        { name: 'codex', kind: 'codex-subscription', codexHome: '~/.codex-work', models: [{ id: 'gpt-6-astra', label: 'GPT', efforts: ['high'] }] },
      ],
    }, '/x/providers.json');
    assert.equal(config.file, '/x/providers.json');
    assert.deepEqual(config.jev, { keyFile: path.join(ownerHome(), '.jevellan-harness', 'secrets', 'jev.key'), model: 'jev-latest', timeoutMs: 4000 });
    const [main, second, glm, codex] = config.providers;
    assert.equal(main.tokenFile, path.join(ownerHome(), '.jevellan-harness', 'secrets', 'main.token'));
    assert.deepEqual([main.ceilingPct, main.enabled, main.paidUse, main.metered], [90, true, 'always', false]);
    assert.deepEqual(second.models, main.models);
    assert.notEqual(second.models, main.models, 'a "same as" list is a copy');
    assert.deepEqual([second.ceilingPct, second.enabled], [70, false]);
    assert.deepEqual([glm.metered, glm.paidUse, glm.models[0].maxTokens], [true, 'never', 4096]);
    assert.equal(codex.codexHome, path.join(ownerHome(), '.codex-work'));
    assert.equal(findProvider(config, 'glm'), glm);
    assert.equal(findProvider(config, 'nobody'), null);
    assert.equal(secretFile(main), main.tokenFile);
    assert.equal(secretFile(glm), '/keys/glm.key');
  });

  test('anything unknown or incomplete is refused with exit 2 naming where', () => {
    const one = (p) => ({ jev: JEV, providers: [{ name: 'p', kind: 'claude-subscription', models: MODELS, ...p }] });
    const cases = [
      [{ jev: JEV, providers: [], extra: 1 }, 'providers.json: the file has an unknown key "extra"'],
      [{ providers: [] }, 'providers.json: jev is required'],
      [{ jev: { ...JEV, colour: 'blue' }, providers: [] }, 'providers.json: jev has an unknown key "colour"'],
      [{ jev: JEV, providers: [] }, 'providers.json: providers must be a non-empty list'],
      [one({ ceilingPct: 0 }), 'providers.json: providers.p ceilingPct must be a number from 1 to 100'],
      [one({ kind: 'telegraph' }), 'providers.json: providers.p kind must be one of claude-subscription, claude-endpoint, codex-subscription, openai-compatible'],
      [one({ kind: 'claude-endpoint' }), 'providers.json: providers.p needs a baseUrl (http or https)'],
      [one({ kind: 'codex-subscription', tokenFile: '/t' }), 'providers.json: providers.p a codex-subscription logs in through its CODEX_HOME, not a token or key file'],
      [one({ models: 'same as nobody' }), 'providers.json: providers.p models "same as nobody" must name a provider with its own list'],
      [one({ models: [{ id: 'm', label: 'M', efforts: ['huge'] }] }), 'providers.json: providers.p.models[0] efforts must be a non-empty list of low, medium, high, xhigh, max'],
      [one({ tokenFlie: '/t' }), 'providers.json: providers[0] (p) has an unknown key "tokenFlie"'],
    ];
    for (const [raw, message] of cases) assert.throws(() => parseProviders(raw, '/x/providers.json'), refusal(message), message);
  });

  test('loadProviders reads JH_HARNESS_HOME/providers.json; a missing or broken file is exit 2', () => {
    const home = tempDir('jh-pf-home-');
    const previous = process.env.JH_HARNESS_HOME;
    process.env.JH_HARNESS_HOME = home;
    try {
      assert.equal(providersPath(), path.join(home, 'providers.json'));
      assert.equal(providersStatePath(), path.join(home, 'providers-state.json'));
      assert.throws(() => loadProviders(), refusal(`cannot read ${path.join(home, 'providers.json')}: ENOENT`));
      fs.writeFileSync(path.join(home, 'providers.json'), '{nope');
      assert.throws(() => loadProviders(), (e) => e.exitCode === 2 && e.message.startsWith(`${path.join(home, 'providers.json')} is not JSON: `));
      writeJson(path.join(home, 'providers.json'), { jev: JEV, providers: [{ name: 'p', kind: 'claude-subscription', models: MODELS }] });
      assert.equal(loadProviders().providers[0].name, 'p');
    } finally {
      process.env.JH_HARNESS_HOME = previous;
    }
  });

  test('secretPresent says whether a file has a value, never what it is', () => {
    const dir = tempDir('jh-pf-secret-');
    fs.writeFileSync(path.join(dir, 'full'), 'value-1234567890\n');
    fs.writeFileSync(path.join(dir, 'blank'), '  \n');
    assert.equal(secretPresent(path.join(dir, 'full')), true);
    assert.equal(secretPresent(path.join(dir, 'blank')), false);
    assert.equal(secretPresent(path.join(dir, 'absent')), false);
    assert.equal(secretPresent(undefined), false);
  });
});

describe('providers-state.json', () => {
  test('written with mode 600 and read back; a missing or broken file reads as empty', () => {
    const file = path.join(tempDir('jh-pf-state-'), 'nested', 'providers-state.json');
    assert.deepEqual(readProvidersState(file), { jev: null, providers: {} });
    const state = { checkedAt: '2026-11-02T00:00:00.000Z', jev: null, providers: { p: { auth: 'ready', observedAt: '2026-11-02T00:00:00.000Z' } } };
    writeProvidersState(state, file);
    assert.deepEqual(readProvidersState(file), state);
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
    fs.writeFileSync(file, '[1, 2]');
    assert.deepEqual(readProvidersState(file), { jev: null, providers: {} });
  });

  test('an entry counts for twelve hours; a usage percentage counts until its window resets', () => {
    const now = Date.parse('2026-11-02T12:00:00.000Z');
    const at = (ms) => new Date(now - ms).toISOString();
    const state = { providers: { fresh: { auth: 'ready', observedAt: at(STATE_FRESH_MS - 1000) }, stale: { auth: 'ready', observedAt: at(STATE_FRESH_MS) }, none: { auth: 'ready' } } };
    assert.equal(freshProviderState(state, 'fresh', now), state.providers.fresh);
    assert.equal(freshProviderState(state, 'stale', now), null);
    assert.equal(freshProviderState(state, 'none', now), null);
    assert.equal(freshProviderState(state, 'missing', now), null);
    const entry = { weeklyPct: 40, weeklyResetsAt: new Date(now + 1000).toISOString(), fiveHourPct: 95, fiveHourResetsAt: new Date(now - 1000).toISOString() };
    assert.deepEqual(currentUsage(entry, now), { weeklyPct: 40, fiveHourPct: null });
    assert.deepEqual(currentUsage({ weeklyPct: 12, fiveHourPct: 'x' }, now), { weeklyPct: 12, fiveHourPct: null });
    assert.deepEqual(currentUsage(null, now), { weeklyPct: null, fiveHourPct: null });
  });
});
