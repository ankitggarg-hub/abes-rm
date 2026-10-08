// Try the whole app on your own computer with no accounts: an in-memory Postgres
// (PGlite) holds the demo campus. Data is lost when you stop the server.
//   npm run dev     then open http://localhost:3000
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../lib/core.js';
import { loadDemo } from '../lib/seed.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.DEMO_PASSWORD || 'demo-password-1';

const pg = new PGlite();
await pg.exec(await readFile(join(root, 'db/schema.sql'), 'utf8'));
const db = {
  query: async (t, p) => (await pg.query(t, p)).rows,
  tx: (fn) => pg.transaction((tx) => fn(async (t, p) => (await tx.query(t, p)).rows)),
};
await db.tx((q) => loadDemo(q, { password: PASSWORD }));
const handle = createHandler({ withDb: (fn) => fn(db), env: { SESSION_SECRET: randomBytes(32).toString('hex'), COOKIE_SECURE: 'false' } });

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const out = await handle({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(out.status, out.headers);
      return res.end(JSON.stringify(out.body));
    }
    const path = req.url.split('?')[0];
    const file = normalize(join(root, 'public', path === '/' ? 'index.html' : path));
    if (!file.startsWith(join(root, 'public'))) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Campus Resource Planner running at http://localhost:${PORT}`);
  console.log(`Sign in as meera.iyer@college.example (admin), hod.cse@college.example, principal@college.example or placement@college.example`);
  console.log(`Password for all demo users: ${PASSWORD}`);
});
