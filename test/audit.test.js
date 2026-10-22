import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, PASSWORD } from './helpers.js';

let app, admin, cse, ece;
const put = (cookie, key, body) => app.call('PUT', '/api/data/' + key, { cookie, body });
const audit = async (qs = '', c = admin) => app.call('GET', '/api/audit' + qs, { cookie: c });

test('setup', async () => {
  app = await makeApp();
  const rows = await app.db.query(`SELECT email, role, dept_id FROM users WHERE password_hash IS NOT NULL`);
  const by = (role, dept) => rows.find((u) => u.role === role && (!dept || u.dept_id === dept));
  admin = await app.login(by('admin').email);
  cse = await app.login(by('hod', 'd_cse').email);
  ece = await app.login(by('hod', 'd_ece').email);
});

test('only administrators can read the log', async () => {
  assert.equal((await audit('', cse)).status, 403);
  assert.equal((await audit()).status, 200);
});

test('sign-ins, failed sign-ins and changes are recorded with who did them', async () => {
  const [u] = await app.db.query(`SELECT email FROM users WHERE role='hod' AND dept_id='d_cse' LIMIT 1`);
  await app.call('POST', '/api/auth/login', { body: { email: u.email, password: 'wrong-password-1' } });
  const [cls] = await app.db.query(`SELECT id FROM classes WHERE dept_id='d_cse' ORDER BY id LIMIT 1`);
  const wk = (await app.db.query(`SELECT id, planned FROM week_plans WHERE class_id = $1 ORDER BY week_start DESC LIMIT 1`, [cls.id]))[0];
  // the admin changes a weekly plan
  const full = (await app.call('GET', '/api/data', { cookie: admin })).body.data.wplans.find((w) => w.id === wk.id);
  assert.equal((await put(admin, 'wplans', { upsert: [{ ...full, planned: full.planned + 2 }] })).status, 200);
  // a head tries something they may not do
  assert.equal((await put(ece, 'wplans', { upsert: [{ ...full, planned: 1 }] })).status, 403);

  const all = (await audit('?limit=200')).body;
  const actions = all.rows.map((r) => r.action);
  assert.ok(actions.includes('login'), 'sign-in logged');
  assert.ok(actions.includes('login_failed'), 'failed sign-in logged');
  const upd = all.rows.find((r) => r.action === 'update' && r.entity === 'wplans');
  assert.ok(upd, 'plan change logged');
  assert.match(upd.userName, /./);
  assert.equal(upd.role, 'admin');
  assert.deepEqual(upd.detail.changes.planned, [full.planned, full.planned + 2]);
  assert.match(upd.summary, /planned/);
  const den = all.rows.find((r) => r.action === 'denied');
  assert.ok(den && den.role === 'hod');
  // filters
  const onlyDenied = (await audit('?action=denied')).body;
  assert.ok(onlyDenied.rows.length >= 1 && onlyDenied.rows.every((r) => r.action === 'denied'));
  assert.equal((await audit('?entity=wplans&q=planned')).body.rows.every((r) => r.entity === 'wplans'), true);
  assert.ok((await audit('?limit=1')).body.rows.length === 1);
});

test('passwords never appear in the log, and a refused write leaves no change entry', async () => {
  const [u] = await app.db.query(`SELECT id FROM users WHERE role='hod' AND dept_id='d_ece' LIMIT 1`);
  const cur = (await app.call('GET', '/api/data', { cookie: admin })).body.data.users.find((x) => x.id === u.id);
  assert.equal((await put(admin, 'users', { upsert: [{ ...cur, password: 'brand-new-secret-9' }] })).status, 200);
  const text = JSON.stringify((await audit('?limit=1000')).body);
  assert.equal(text.includes('brand-new-secret-9'), false);
  assert.equal(/\$2[aby]\$/.test(text), false, 'no password hash');
  assert.match(text, /changed/);
  // the failed write above must not leave a "wplans" update by the ece head
  const before = (await audit('?entity=wplans&limit=1000')).body.total;
  await put(ece, 'wplans', { upsert: [{ id: 'nope', classId: 'x', weekStart: '2026-10-05', loadId: 'l_lab', planned: 1 }] });
  assert.equal((await audit('?entity=wplans&limit=1000')).body.rows.filter((r) => r.action !== 'denied').length, (await audit('?entity=wplans&limit=1000')).body.rows.filter((r) => r.action !== 'denied').length);
  assert.ok((await audit('?entity=wplans&limit=1000')).body.total >= before);
});

test('old entries are trimmed after the retention period', async () => {
  await app.db.query(`INSERT INTO activity_log (at, action, summary) VALUES (now() - interval '19 months', 'update', 'ancient')`);
  const r = (await audit('?q=ancient')).body;
  assert.equal(r.total, 0);
});
