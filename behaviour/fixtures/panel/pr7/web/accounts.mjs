// The inbox accounts page: each account reads its messages through an integration and links to that integration's
// panel, where its credential is kept.
import { escapeHtml } from './panel.mjs';

export function renderAccount(account) {
  const id = escapeHtml(account.id);
  return `<section class="account" data-id="${id}">
  <h2>${escapeHtml(account.label)}</h2>
  <p>Integração: ${escapeHtml(account.integration)}</p>
  <a class="configure" href="/panel.html#config-${escapeHtml(account.integration)}">Configurar integração</a>
</section>`;
}

export function renderAccounts(accounts) {
  if (!accounts.length) return '<p class="empty">Ainda não há contas.</p>';
  return accounts.map(renderAccount).join('\n');
}

async function load(doc) {
  const accounts = await (await fetch('/accounts')).json();
  doc.querySelector('#accounts').innerHTML = renderAccounts(accounts);
}

if (typeof document !== 'undefined') load(document);
