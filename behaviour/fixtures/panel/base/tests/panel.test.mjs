import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPanels } from '../web/panel.mjs';

const configs = [
  { key: 'slack', label: 'Slack', enabled: true, credential: '••••7731', settings: { channels: ['geral'] } },
  { key: 'imap', label: 'Email do escritório', enabled: false, credential: null, settings: {} },
];

test('each config gets a panel with Ver and Desativar', () => {
  const html = renderPanels(configs);
  assert.equal(html.match(/<section class="panel"/g).length, 2);
  assert.equal(html.match(/data-action="ver"/g).length, 2);
  assert.equal(html.match(/data-action="desativar"/g).length, 2);
  assert.match(html, /id="config-slack"/);
});

test('the credential shows masked, or sem credencial', () => {
  const html = renderPanels(configs);
  assert.match(html, /Credencial: ••••7731/);
  assert.match(html, /Credencial: sem credencial/);
  assert.doesNotMatch(html, /xoxb/);
});

test('a disabled integration cannot be disabled again', () => {
  assert.match(renderPanels(configs), /data-action="desativar" disabled/);
});

test('no configs: an empty state', () => {
  assert.match(renderPanels([]), /Ainda não há integrações/);
});
