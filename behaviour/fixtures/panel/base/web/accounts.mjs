// The inbox accounts page: each account reads its messages through an integration, and has its own Ligar form that
// saves the integration's credential from here.
import { escapeHtml } from './panel.mjs';

export function renderAccount(account) {
  const id = escapeHtml(account.id);
  return `<section class="account" data-id="${id}">
  <h2>${escapeHtml(account.label)}</h2>
  <p>Integração: ${escapeHtml(account.integration)}</p>
  <form class="connect" data-integration="${escapeHtml(account.integration)}">
    <label>Credencial <input name="credential" type="password" autocomplete="off" required></label>
    <button>Ligar</button>
  </form>
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

if (typeof document !== 'undefined') {
  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('form.connect');
    if (!form) return;
    event.preventDefault();
    const credential = new FormData(form).get('credential');
    await fetch('/configs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: form.dataset.integration, credential }) });
    form.reset();
  });
  load(document);
}
