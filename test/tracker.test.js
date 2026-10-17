import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

let app, admin, cse, ece, head, stake;
const put = (cookie, key, body) => app.call('PUT', '/api/data/' + key, { cookie, body });
const iso = (d) => d.toISOString().slice(0, 10);

test('setup', async () => {
  app = await makeApp();
  const rows = await app.db.query(`SELECT email, role, dept_id FROM users WHERE password_hash IS NOT NULL`);
  const by = (role, dept) => rows.find((u) => u.role === role && (!dept || u.dept_id === dept));
  admin = await app.login(by('admin').email);
  cse = await app.login(by('hod', 'd_cse').email);
  ece = await app.login(by('hod', 'd_ece').email);
  head = await app.login(by('head').email);
  stake = await app.login(by('stakeholder').email);
});

test('load types: everyone reads, only admins change them, names are unique', async () => {
  const d = (await app.call('GET', '/api/data', { cookie: cse })).body.data;
  assert.ok(d.loads.length >= 4 && d.loads.some((l) => l.kind === 'Training'));
  assert.equal((await put(cse, 'loads', { upsert: [{ id: 'lx', name: 'Seminar', kind: 'Academic' }] })).status, 403);
  assert.equal((await put(head, 'loads', { upsert: [{ id: 'lx', name: 'Seminar', kind: 'Academic' }] })).status, 403);
  assert.equal((await put(admin, 'loads', { upsert: [{ id: 'lx', name: 'Seminar', kind: 'Academic' }] })).status, 200);
  assert.equal((await put(admin, 'loads', { upsert: [{ id: 'ly', name: 'SEMINAR', kind: 'Training' }] })).status, 409);
  assert.equal((await put(admin, 'loads', { upsert: [{ id: 'ly', name: 'X', kind: 'Other' }] })).status, 400);
});

test('department heads plan only their own sections; stakeholders see nothing', async () => {
  const d = (await app.call('GET', '/api/data', { cookie: admin })).body.data;
  const cseClass = d.classes.find((c) => c.deptId === 'd_cse').id;
  const row = { id: 'wp1', classId: cseClass, weekStart: '2026-03-02', loadId: 'l_theory', planned: 14.5, actual: null };
  assert.equal((await put(cse, 'wplans', { upsert: [row] })).status, 200);
  assert.equal((await put(ece, 'wplans', { upsert: [{ ...row, id: 'wp2' }] })).status, 403);
  assert.equal((await put(ece, 'wplans', { remove: ['wp1'] })).status, 403);
  assert.equal((await put(head, 'wplans', { upsert: [{ ...row, id: 'wp3', loadId: 'l_lab' }] })).status, 403);
  assert.equal((await put(cse, 'wplans', { upsert: [{ ...row, id: 'wp4', weekStart: '2026-03-03' }] })).status, 400); // not a Monday
  assert.equal((await put(cse, 'wplans', { upsert: [{ ...row, id: 'wp5' }] })).status, 409); // same section, week and load
  const back = (await app.call('GET', '/api/data', { cookie: head })).body.data.wplans.find((w) => w.id === 'wp1');
  assert.equal(back.planned, 14.5);
  assert.deepEqual((await app.call('GET', '/api/data', { cookie: stake })).body.data.wplans, []);
  // a past week can be completed with actual hours, and a variance is just the numbers
  assert.equal((await put(cse, 'wplans', { upsert: [{ ...row, actual: 12 }] })).status, 200);
  assert.equal((await put(cse, 'wplans', { upsert: [{ ...row, actual: -1 }] })).status, 400);
});

test('actual hours open on the last working day of the week, and off days move that day earlier', async () => {
  const d = (await app.call('GET', '/api/data', { cookie: admin })).body.data;
  const cls = d.classes.find((c) => c.deptId === 'd_cse').id;
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  const dow = ist.getUTCDay();
  const mon = new Date(ist); mon.setUTCDate(mon.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  const week = iso(mon), row = { id: 'wp9', classId: cls, weekStart: week, loadId: 'l_lab', planned: 6, actual: 5 };
  if (dow >= 1 && dow <= 4) { // Saturday and Sunday are off, so Friday is the normal last working day
    const early = await put(cse, 'wplans', { upsert: [row] });
    assert.equal(early.status, 400, 'before the last working day');
    const next = new Date(ist); next.setUTCDate(next.getUTCDate() + 1);
    const sat = new Date(mon); sat.setUTCDate(sat.getUTCDate() + 5);
    // the head marks the rest of the week as off for their own section, so today is the last working day
    assert.equal((await put(cse, 'holidays', { upsert: [{ id: 'ho1', dateFrom: iso(next), dateTo: iso(sat), title: 'Fest', classId: cls }] })).status, 200);
  }
  assert.equal((await put(cse, 'wplans', { upsert: [row] })).status, 200);
});

test('off days: admin for the whole campus or one section, heads only for their own sections', async () => {
  const d = (await app.call('GET', '/api/data', { cookie: admin })).body.data;
  const cseClass = d.classes.find((c) => c.deptId === 'd_cse').id, eceClass = d.classes.find((c) => c.deptId === 'd_ece').id;
  const h = { id: 'hx', dateFrom: '2026-10-02', dateTo: '2026-10-03', title: 'Gandhi Jayanti', classId: null };
  assert.equal((await put(cse, 'holidays', { upsert: [h] })).status, 403); // campus-wide is admin only
  assert.equal((await put(admin, 'holidays', { upsert: [h] })).status, 200);
  assert.equal((await put(admin, 'holidays', { upsert: [{ ...h, id: 'hy', dateTo: '2026-10-01' }] })).status, 400); // ends before it starts
  assert.equal((await put(cse, 'holidays', { upsert: [{ ...h, id: 'hz', classId: eceClass }] })).status, 403);
  assert.equal((await put(cse, 'holidays', { upsert: [{ ...h, id: 'hz', classId: cseClass }] })).status, 200);
  assert.equal((await put(ece, 'holidays', { remove: ['hz'] })).status, 403);
  assert.equal((await put(cse, 'holidays', { remove: ['hx'] })).status, 403);
  assert.equal((await put(cse, 'holidays', { remove: ['hz'] })).status, 200);
  const rows = (await app.call('GET', '/api/data', { cookie: cse })).body.data.holidays;
  assert.equal(rows.find((r) => r.id === 'hx').by.length > 0, true); // stamped with who added it
  assert.equal((await put(stake, 'holidays', { upsert: [h] })).status, 403);
});

test('a load type in use cannot be deleted', async () => {
  const r = await put(admin, 'loads', { remove: ['l_theory'] });
  assert.equal(r.status, 409);
});
