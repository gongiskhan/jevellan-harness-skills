import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAccounts } from '../web/accounts.mjs';

test('each account links to its integration in the panel', () => {
  const html = renderAccounts([{ id: 'slack-geral', label: 'Slack #geral', integration: 'slack' }]);
  assert.match(html, /Integração: slack/);
  assert.match(html, /href="\/panel.html#config-slack">Configurar integração</);
  assert.doesNotMatch(html, /<form/);
});
