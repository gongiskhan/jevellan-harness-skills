import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-panel-'));
process.env.CONFIG_STORE = path.join(dir, 'configs.json');
const { createServer } = await import('../server.mjs');

const server = createServer();
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const post = (body) => fetch(`${base}/configs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('GET /configs lists the rows with the credential masked', async () => {
  const rows = await (await fetch(`${base}/configs`)).json();
  const slack = rows.find((r) => r.key === 'slack');
  assert.equal(slack.credential, '••••7731');
  assert.equal(rows.find((r) => r.key === 'imap').credential, null);
});

test('POST /configs creates a row, and a second POST merges into it', async () => {
  assert.equal((await post({ key: 'teams', label: 'Teams', credential: 'abc-0001', settings: { team: 'escritorio' } })).status, 200);
  const row = await (await post({ key: 'teams', credential: 'abc-0002' })).json();
  assert.equal(row.credential, '••••0002');
  assert.equal(row.label, 'Teams');
  assert.deepEqual(row.settings, { team: 'escritorio' });
});

test('a blank field never wipes what is stored', async () => {
  const row = await (await post({ key: 'teams', credential: '' })).json();
  assert.equal(row.credential, '••••0002');
});

test('DELETE /configs/:key deletes the whole row', async () => {
  assert.equal((await fetch(`${base}/configs/teams`, { method: 'DELETE' })).status, 204);
  const rows = await (await fetch(`${base}/configs`)).json();
  assert.equal(rows.some((r) => r.key === 'teams'), false);
  assert.equal((await fetch(`${base}/configs/teams`, { method: 'DELETE' })).status, 404);
});
