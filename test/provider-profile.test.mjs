// The deepseek-rtx entry of providers.example.json (H-044, docs/endpoint-sessions.md) through both skills that read
// providers.json: placement accepts it and never offers it to Jev, the Claude runtime builds its login with the
// chosen settings, and the other providers' logins are what they were.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProviders } from '../skills/jevellan-placement/scripts/lib/providers-file.mjs';
import { rankProviders } from '../skills/jevellan-placement/scripts/route.mjs';
import { providerLogin } from '../skills/jevellan-runtime-claude/scripts/lib/env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = JSON.parse(fs.readFileSync(path.join(REPO, 'providers.example.json'), 'utf8'));
const raw = (name) => example.providers.find((p) => p.name === name);
const MODEL = 'deepseek-v4.1-flash-1017-uncensored';

test('placement accepts the example and keeps deepseek-rtx out of Jev\'s menu and out of unlisted projects', () => {
  const config = parseProviders(example, '/example/providers.json');
  const rtx = config.providers.find((p) => p.name === 'deepseek-rtx');
  assert.equal(rtx.placement, false);
  assert.equal(rtx.metered, false);
  assert.equal(rtx.projects.length, 1);
  assert.ok(path.isAbsolute(rtx.projects[0]));
  const elsewhere = fs.mkdtempSync(path.join(process.env.JH_TEST_TMPDIR || os.tmpdir(), 'jh-profile-'));
  const ranked = rankProviders({ providers: config.providers, state: { providers: {} }, kinds: ['claude-endpoint'], project: elsewhere, keyReady: () => true });
  assert.equal(ranked.find((r) => r.provider.name === 'deepseek-rtx').reason, 'project-not-listed');
  const listed = rankProviders({ providers: config.providers, state: { providers: {} }, kinds: ['claude-endpoint'], project: null, keyReady: () => true });
  assert.ok(['project-not-listed', 'not-offered'].includes(listed.find((r) => r.provider.name === 'deepseek-rtx').reason));
});

test('the runtime builds deepseek-rtx\'s login with the chosen settings; glm\'s login is unchanged', () => {
  const dir = fs.mkdtempSync(path.join(process.env.JH_TEST_TMPDIR || os.tmpdir(), 'jh-profile-key-'));
  const keyFile = path.join(dir, 'key');
  fs.writeFileSync(keyFile, 'fake-profile-key-0123456789\n', { mode: 0o600 });
  const login = providerLogin({ ...raw('deepseek-rtx'), keyFile });
  assert.deepEqual(login, {
    ANTHROPIC_BASE_URL: 'https://llm-rtx.culturabuilder.com',
    ANTHROPIC_AUTH_TOKEN: 'fake-profile-key-0123456789',
    ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '65536',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
    API_TIMEOUT_MS: '1800000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    MAX_THINKING_TOKENS: '0',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  });
  const glm = providerLogin({ ...raw('glm'), keyFile });
  assert.deepEqual(Object.keys(glm), ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']);
});
