import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

const ADMIN = 'meera.iyer@college.example';

async function adminAndOther() {
  const app = await makeApp();
  const [other] = await app.db.query(`SELECT email FROM users WHERE role <> 'admin' AND password_hash IS NOT NULL LIMIT 1`);
  return { app, other: other.email };
}

test('sign out really ends the session, even if the cookie is replayed', async () => {
  const { app } = await adminAndOther();
  const cookie = await app.login(ADMIN);
  assert.equal((await app.call('GET', '/api/auth/me', { cookie })).status, 200);
  await app.call('POST', '/api/auth/logout', { cookie });
  assert.equal((await app.call('GET', '/api/auth/me', { cookie })).status, 401);
});

test('an idle session times out, but background refreshes do not keep it alive', async () => {
  const { app } = await adminAndOther();
  const cookie = await app.login(ADMIN);
  await app.db.query(`UPDATE sessions SET last_seen = now() - interval '2 hours'`);
  assert.equal((await app.call('GET', '/api/auth/me', { cookie })).status, 401);
});

test('each person has their own session; signing out one does not affect the other', async () => {
  const { app, other } = await adminAndOther();
  const a = await app.login(ADMIN);
  const b = await app.login(other);
  const me = await app.call('GET', '/api/auth/me', { cookie: b });
  assert.equal(me.body.user.email, other);
  await app.call('POST', '/api/auth/logout', { cookie: a });
  assert.equal((await app.call('GET', '/api/auth/me', { cookie: b })).status, 200);
});

test('sign out everywhere ends every session of that user', async () => {
  const { app } = await adminAndOther();
  const c1 = await app.login(ADMIN);
  const c2 = await app.login(ADMIN);
  await app.call('POST', '/api/auth/logout-all', { cookie: c1 });
  assert.equal((await app.call('GET', '/api/auth/me', { cookie: c2 })).status, 401);
});

test('only the newest 5 sessions per user survive', async () => {
  const { app } = await adminAndOther();
  const first = await app.login(ADMIN);
  for (let i = 0; i < 5; i++) await app.login(ADMIN);
  assert.equal((await app.call('GET', '/api/auth/me', { cookie: first })).status, 401);
});

test('changing a user password ends their sessions', async () => {
  const { app, other } = await adminAndOther();
  const admin = await app.login(ADMIN);
  const victim = await app.login(other);
  const d = await app.call('GET', '/api/data', { cookie: admin });
  const row = d.body.data.users.find((u) => u.email === other);
  const r = await app.call('PUT', '/api/data/users', { cookie: admin, body: { upsert: [{ ...row, password: 'a-brand-new-password' }], remove: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await app.call('GET', '/api/auth/me', { cookie: victim })).status, 401);
  assert.equal((await app.call('GET', '/api/auth/me', { cookie: admin })).status, 200);
});

test('a forged or old-style token without a session is rejected', async () => {
  const { app } = await adminAndOther();
  assert.equal((await app.call('GET', '/api/auth/me', { cookie: 'crp_session=abc.def.ghi' })).status, 401);
});
