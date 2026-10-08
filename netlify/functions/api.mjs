// Netlify adapter: every /api/* request lands here.
import { handle } from '../../lib/server.js';

export default async (req) => {
  const url = new URL(req.url);
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const out = await handle({
    method: req.method,
    url: url.pathname + url.search,
    headers: Object.fromEntries(req.headers),
    body: hasBody ? await req.text() : undefined,
  });
  return new Response(JSON.stringify(out.body), { status: out.status, headers: out.headers });
};

export const config = { path: '/api/*' };
