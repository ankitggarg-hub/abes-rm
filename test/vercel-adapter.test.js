import { test } from 'node:test';
import assert from 'node:assert/strict';

// No DATABASE_URL: a request that reaches the API core answers a JSON 500 (not a host 404).
delete process.env.DATABASE_URL;
const { default: handler } = await import('../api/index.js');

function call(url, method = 'GET') {
  return new Promise((resolve) => {
    const res = { headers: {}, status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, send(b) { resolve({ code: this.code, body: b }); } };
    handler({ url, method, headers: { host: 'x.vercel.app' }, body: undefined }, res);
  });
}

test('rewritten and original URLs both reach the API core', async () => {
  for (const url of ['/api/index?path=health', '/api/health', '/api/index?path=auth/me']) {
    const r = await call(url);
    assert.equal(r.code, 500, url);
    assert.match(r.body, /Something went wrong/);
  }
});
