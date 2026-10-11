// Vercel adapter: every /api/* request is rewritten to this function (see vercel.json).
import { handle } from '../lib/server.js';

export default async function handler(req, res) {
  const u = new URL(req.url, 'http://local');
  let path = u.pathname;
  // vercel.json rewrites /api/<anything> to /api/index?path=<anything>
  if (path === '/api/index' || path === '/api' || path === '/api/') {
    path = '/api/' + (u.searchParams.get('path') || '');
    u.searchParams.delete('path');
  }
  const url = path + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
  const out = await handle({ method: req.method, url, headers: req.headers, body: req.body });
  res.status(out.status);
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.send(JSON.stringify(out.body));
}
