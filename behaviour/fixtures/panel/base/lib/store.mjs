// The config store: one JSON file, one row per integration key. A row holds the integration's label, whether it is
// enabled, its settings and its stored credential.
import fs from 'node:fs';
import path from 'node:path';

const SEED = {
  slack: { key: 'slack', label: 'Slack', enabled: true, credential: 'xoxb-demo-7731', settings: { channels: ['geral', 'clientes'] } },
  imap: { key: 'imap', label: 'Email do escritório', enabled: true, credential: null, settings: { folder: 'INBOX' } },
};

export function storeFile() {
  return process.env.CONFIG_STORE || path.join(process.cwd(), 'data', 'configs.json');
}

export function readAll(file = storeFile()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(SEED);
  }
}

function writeAll(rows, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
}

// Creates the row or merges `values` into it. Empty values (undefined, null, '') are ignored, so a form saved with a
// field left blank never wipes what is stored.
export function upsert(key, values, file = storeFile()) {
  const rows = readAll(file);
  const kept = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const now = new Date().toISOString();
  rows[key] = { ...(rows[key] ?? { key, enabled: true, credential: null, settings: {}, createdAt: now }), ...kept, key, updatedAt: now };
  writeAll(rows, file);
  return rows[key];
}

// Deletes the whole row: its label, settings and credential.
export function remove(key, file = storeFile()) {
  const rows = readAll(file);
  if (!(key in rows)) return false;
  delete rows[key];
  writeAll(rows, file);
  return true;
}
