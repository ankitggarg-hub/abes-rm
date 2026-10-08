import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../lib/core.js';
import { loadDemo } from '../lib/seed.js';

export const PASSWORD = 'correct horse battery';
export const SECRET = 'test-secret-test-secret-test-secret-1234';

export async function makeApp() {
  const pg = new PGlite();
  await pg.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  const db = {
    query: async (text, params) => (await pg.query(text, params)).rows,
    tx: (fn) => pg.transaction((tx) => fn(async (text, params) => (await tx.query(text, params)).rows)),
  };
  await db.tx((q) => loadDemo(q, { password: PASSWORD, today: '2026-10-07' }));
  const handle = createHandler({ withDb: (fn) => fn(db), env: { SESSION_SECRET: SECRET, COOKIE_SECURE: 'false' } });

  async function call(method, path, { body, cookie, origin, host = 'planner.test' } = {}) {
    const headers = { host };
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const res = await handle({ method, url: path, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers['set-cookie'];
    return { status: res.status, body: res.body, cookie: sc ? sc.split(';')[0] : undefined };
  }
  async function login(email) {
    const r = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    if (r.status !== 200) throw new Error('login failed: ' + JSON.stringify(r.body));
    return r.cookie;
  }
  return { pg, db, call, login };
}
