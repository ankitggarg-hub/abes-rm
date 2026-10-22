// Vercel adapter: every /api/* request lands here.
import { handle } from '../lib/server.js';

export default async function handler(req, res) {
  const out = await handle({ method: req.method, url: req.url, headers: req.headers, body: req.body });
  res.status(out.status);
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.send(JSON.stringify(out.body));
}
