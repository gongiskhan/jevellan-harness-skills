// The Claude Code plugin and its one-plugin marketplace: the manifests agree with package.json and with each other,
// and hooks/hooks.json registers the ledger's three hooks the way install.mjs does, through ${CLAUDE_PLUGIN_ROOT}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POST_TOOL_MATCHER, SESSION_START_MATCHERS, HOOK_TIMEOUT } from '../install.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));

test('plugin.json: name jevellan-harness, the version of package.json, author gongiskhan, no component paths', () => {
  const plugin = read('.claude-plugin/plugin.json');
  const pkg = read('package.json');
  assert.equal(plugin.name, 'jevellan-harness');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.author?.name, 'gongiskhan');
  assert.equal(plugin.license, 'MIT');
  assert.ok(plugin.description && plugin.description.length > 40);
  // skills/ and hooks/hooks.json load from the standard layout; naming them again could load them twice.
  for (const key of ['skills', 'hooks', 'commands', 'agents']) assert.equal(key in plugin, false, key);
});

test('marketplace.json lists this repository root as its one plugin, under the plugin\'s own name', () => {
  const market = read('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'jevellan-harness-skills');
  assert.equal(market.owner?.name, 'gongiskhan');
  assert.equal(market.plugins.length, 1);
  const [entry] = market.plugins;
  assert.equal(entry.name, read('.claude-plugin/plugin.json').name);
  assert.equal(entry.source, './');
  assert.equal('skills' in entry, false, 'a skills list would stop the scan of skills/');
});

test('hooks/hooks.json runs the three ledger hooks with node from PATH, as install.mjs registers them', () => {
  const { hooks } = read('hooks/hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'SessionStart', 'Stop']);
  const handlers = (event) => hooks[event].flatMap((group) => group.hooks);
  const check = (event, file) => {
    const [handler, ...rest] = handlers(event);
    assert.equal(rest.length, 0, `${event}: one handler`);
    assert.equal(handler.type, 'command');
    assert.equal(handler.command, 'node');
    assert.deepEqual(handler.args, [`\${CLAUDE_PLUGIN_ROOT}/skills/jevellan-ledger/hooks/${file}`]);
    assert.equal(handler.timeout, HOOK_TIMEOUT);
    assert.ok(fs.existsSync(path.join(REPO, 'skills', 'jevellan-ledger', 'hooks', file)), file);
  };
  check('Stop', 'stop.mjs');
  check('PostToolUse', 'post-tool.mjs');
  check('SessionStart', 'session-start.mjs');
  assert.equal(hooks.Stop[0].matcher, undefined, 'Stop takes no matcher');
  assert.equal(hooks.PostToolUse[0].matcher, POST_TOOL_MATCHER);
  assert.equal(hooks.SessionStart[0].matcher, SESSION_START_MATCHERS.join('|'));
});

test('no package-lock.json at the plugin root (with one, Claude Code would run npm in the plugin cache)', () => {
  assert.equal(fs.existsSync(path.join(REPO, 'package-lock.json')), false);
  assert.equal(Object.keys(read('package.json').dependencies ?? {}).length, 0);
});
