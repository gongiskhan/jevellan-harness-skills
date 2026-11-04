// The integrations panel's server: a JSON API over the config store and the pages in web/.
//   GET    /configs        every row, the credential masked
//   POST   /configs        {key, ...values}: creates the row or merges the values into it (lib/store.mjs upsert)
//   DELETE /configs/:key   deletes the row
//   GET    /accounts       the inbox accounts
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAll, remove, upsert } from './lib/store.mjs';
import { publicRow } from './lib/mask.mjs';
import { readAccounts } from './lib/accounts.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/configs' && req.method === 'GET') return send(res, 200, Object.values(readAll()).map(publicRow));
      if (url.pathname === '/configs' && req.method === 'POST') {
        const { key, ...values } = await readBody(req);
        if (typeof key !== 'string' || !key.trim()) return send(res, 400, { error: 'key is required' });
        return send(res, 200, publicRow(upsert(key, values)));
      }
      const one = /^\/configs\/([^/]+)$/.exec(url.pathname);
      if (one && req.method === 'DELETE') return remove(decodeURIComponent(one[1])) ? send(res, 204, '', 'text/plain') : send(res, 404, { error: 'not found' });
      if (url.pathname === '/accounts' && req.method === 'GET') return send(res, 200, readAccounts());
      if (req.method === 'GET') {
        const name = url.pathname === '/' ? 'panel.html' : url.pathname.slice(1);
        const file = path.join(WEB, path.normalize(name));
        if (file.startsWith(WEB + path.sep) && fs.existsSync(file)) return send(res, 200, fs.readFileSync(file, 'utf8'), TYPES[path.extname(file)] ?? 'text/plain');
      }
      send(res, 404, { error: 'not found' });
    } catch (error) {
      send(res, 500, { error: error.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`cred-panel listening on http://localhost:${port}`));
}
