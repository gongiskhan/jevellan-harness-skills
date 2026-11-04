// The integrations panel: one panel per stored config, with Ver (show the settings) and Desativar (switch it off).
// Work in progress: Substituir opens the form again for a panel with a stored credential; Remover still to come.
// The render functions are pure so the tests can call them; the code at the bottom wires them in the browser.

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderSettings(settings = {}) {
  const rows = Object.entries(settings).map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(Array.isArray(value) ? value.join(', ') : value)}</dd>`);
  return rows.length ? rows.join('') : '<dt>Definições</dt><dd>nenhuma</dd>';
}

// `config` is a row as GET /configs returns it: the credential is already masked (or null).
export function renderPanel(config) {
  const key = escapeHtml(config.key);
  return `<section class="panel" id="config-${key}" data-key="${key}">
  <h2>${escapeHtml(config.label ?? config.key)}</h2>
  <p class="state">${config.enabled === false ? 'Desativada' : 'Ativa'}</p>
  <p class="credential">Credencial: ${config.credential ? escapeHtml(config.credential) : 'sem credencial'}</p>
  <div class="actions">
    <button type="button" data-action="ver">Ver</button>
    <button type="button" data-action="desativar"${config.enabled === false ? ' disabled' : ''}>Desativar</button>${config.credential ? `
    <button type="button" data-action="substituir">Substituir</button>` : ''}
  </div>
  <dl class="details" hidden>${renderSettings(config.settings)}</dl>
</section>`;
}

export function renderPanels(configs) {
  if (!configs.length) return '<p class="empty">Ainda não há integrações.</p>';
  return configs.map(renderPanel).join('\n');
}

// ---- in the browser ---------------------------------------------------------------------------------------------

async function load(doc) {
  const rows = await (await fetch('/configs')).json();
  doc.querySelector('#panels').innerHTML = renderPanels(rows);
}

async function save(values) {
  await fetch('/configs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
}

function wire(doc) {
  doc.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const panel = button.closest('.panel');
    const key = panel?.dataset.key;
    if (button.dataset.action === 'ver') panel.querySelector('.details').hidden = !panel.querySelector('.details').hidden;
    if (button.dataset.action === 'desativar') {
      await save({ key, enabled: false });
      await load(doc);
    }
    if (button.dataset.action === 'nova') doc.querySelector('#config-dialog').showModal();
    if (button.dataset.action === 'substituir') {
      doc.querySelector('#config-form').elements.key.value = key;
      doc.querySelector('#config-dialog').showModal();
    }
  });
  doc.querySelector('#config-form')?.addEventListener('submit', async (event) => {
    if (event.submitter?.value !== 'guardar') return;
    const form = new FormData(event.target);
    await save({ key: form.get('key'), label: form.get('label'), credential: form.get('credential') });
    event.target.reset();
    await load(doc);
  });
}

if (typeof document !== 'undefined') {
  wire(document);
  load(document);
}
