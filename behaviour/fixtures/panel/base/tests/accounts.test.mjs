import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAccounts } from '../web/accounts.mjs';

test('each account shows its integration and a Ligar form', () => {
  const html = renderAccounts([{ id: 'slack-geral', label: 'Slack #geral', integration: 'slack' }]);
  assert.match(html, /Integração: slack/);
  assert.match(html, /<form class="connect" data-integration="slack">/);
  assert.match(html, /<button>Ligar<\/button>/);
});
