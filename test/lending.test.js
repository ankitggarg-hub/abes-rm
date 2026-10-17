import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

let app, cse, ece, stake, head;
const put = (cookie, key, body) => app.call('PUT', '/api/data/' + key, { cookie, body });

test('setup', async () => {
  app = await makeApp();
  const rows = await app.db.query(`SELECT email, role, dept_id FROM users WHERE password_hash IS NOT NULL`);
  const by = (role, dept) => rows.find((u) => u.role === role && (!dept || u.dept_id === dept));
  cse = await app.login(by('hod', 'd_cse').email);
  ece = await app.login(by('hod', 'd_ece').email);
  stake = await app.login(by('stakeholder').email);
  head = await app.login(by('head').email);
});

async function venue(dept) {
  const [v] = await app.db.query(`SELECT id FROM venues WHERE dept_id = $1 LIMIT 1`, [dept]);
  return v.id;
}

test('a head lends an own venue to another department, and it blocks the slot', async () => {
  const me = (await app.call('GET', '/api/auth/me', { cookie: cse })).body.user;
  const resId = await venue('d_cse');
  const ev = { id: 'ln1', resId, date: '2026-12-15', slotIds: ['s2'], title: 'ECE guest lecture', by: 'ECE department', attendees: 30, notes: '', status: 'confirmed', forDeptId: 'd_ece', lentDeptId: 'd_cse', lentBy: me.name };
  const r = await put(cse, 'events', { upsert: [ev], remove: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const again = await put(cse, 'events', { upsert: [{ ...ev, id: 'ln2' }], remove: [] });
  assert.equal(again.status, 409);
  const seen = (await app.call('GET', '/api/data', { cookie: ece })).body.data.events.find((e) => e.id === 'ln1');
  assert.equal(seen.forDeptId, 'd_ece');
  assert.equal(seen.lentBy, me.name);
});

test('lending rules: only own venues, own name, confirmed, and not edited by others', async () => {
  const me = (await app.call('GET', '/api/auth/me', { cookie: cse })).body.user;
  const own = await venue('d_cse'), foreign = await venue('d_ece');
  const base = { resId: own, date: '2026-12-16', slotIds: ['s3'], title: 'X', by: 'Someone', attendees: 5, notes: '', status: 'confirmed', forDeptId: null, lentDeptId: 'd_cse', lentBy: me.name };
  assert.equal((await put(cse, 'events', { upsert: [{ ...base, id: 'a1', resId: foreign }] })).status, 403);
  assert.equal((await put(cse, 'events', { upsert: [{ ...base, id: 'a2', lentBy: 'Someone Else' }] })).status, 403);
  assert.equal((await put(cse, 'events', { upsert: [{ ...base, id: 'a3', status: 'pending' }] })).status, 403);
  assert.equal((await put(cse, 'events', { upsert: [{ ...base, id: 'a4', forDeptId: 'd_cse' }] })).status, 403);
  assert.equal((await put(cse, 'events', { upsert: [{ ...base, id: 'a5' }] })).status, 200); // for a named outsider
  // other heads, stakeholders and the head of institute cannot cancel or fake a lent booking
  assert.equal((await put(ece, 'events', { remove: ['a5'] })).status, 403);
  assert.equal((await put(stake, 'events', { upsert: [{ ...base, id: 'a6', status: 'pending', by: (await app.call('GET', '/api/auth/me', { cookie: stake })).body.user.name }] })).status, 403);
  assert.equal((await put(head, 'events', { upsert: [{ ...base, id: 'a7' }] })).status, 403);
  // the lender can cancel
  assert.equal((await put(cse, 'events', { remove: ['a5'] })).status, 200);
});

test('a head cannot touch ordinary events or lend into a break', async () => {
  const me = (await app.call('GET', '/api/auth/me', { cookie: cse })).body.user;
  assert.equal((await put(cse, 'events', { remove: ['e1'] })).status, 403);
  const own = await venue('d_cse');
  const [lunch] = await app.db.query(`SELECT id FROM slots WHERE is_break LIMIT 1`);
  const r = await put(cse, 'events', { upsert: [{ id: 'b1', resId: own, date: '2026-12-17', slotIds: [lunch.id], title: 'L', by: 'X', attendees: 1, notes: '', status: 'confirmed', forDeptId: null, lentDeptId: 'd_cse', lentBy: me.name }] });
  assert.equal(r.status, 400);
});

test('a head who manages two departments can lend and release for both, but not a third', async () => {
  const admin = await app.login('meera.iyer@college.example');
  const d = (await app.call('GET', '/api/data', { cookie: admin })).body.data;
  const hodRow = d.users.find((u) => u.role === 'hod' && u.deptId === 'd_cse');
  assert.deepEqual(hodRow.moreDeptIds, []);
  const upd = await put(admin, 'users', { upsert: [{ ...hodRow, moreDeptIds: ['d_ece', 'd_cse', 'd_ghost'] }] });
  assert.equal(upd.status, 400); // unknown department
  const ok = await put(admin, 'users', { upsert: [{ ...hodRow, moreDeptIds: ['d_ece', 'd_cse'] }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const saved = (await app.call('GET', '/api/data', { cookie: admin })).body.data.users.find((u) => u.id === hodRow.id);
  assert.deepEqual(saved.moreDeptIds, ['d_ece']); // the main department is removed from the extras
  // their old session is ended; sign in again
  const cookie = await app.login(hodRow.email);
  const me = (await app.call('GET', '/api/auth/me', { cookie })).body.user;
  assert.deepEqual(me.moreDeptIds, ['d_ece']);
  // 20 Dec 2026 is a Sunday: venues can only be used once an administrator converts it to a working day
  const conv = await put(admin, 'holidays', { upsert: [{ id: 'hw_sun', dateFrom: '2026-12-20', dateTo: '2026-12-20', title: 'Make-up day', classId: null, kind: 'working', slotFrom: null, slotTo: null }] });
  assert.equal(conv.status, 200, JSON.stringify(conv.body));
  const eceVenue = await venue('d_ece');
  const ev = { id: 'm1', resId: eceVenue, date: '2026-12-20', slotIds: ['s2'], title: 'ECE lab for ME', by: 'Someone', attendees: 3, notes: '', status: 'confirmed', forDeptId: null, lentDeptId: 'd_ece', lentBy: me.name };
  assert.equal((await put(cookie, 'events', { upsert: [ev] })).status, 200);
  assert.equal((await put(cookie, 'events', { upsert: [{ ...ev, id: 'm2', lentDeptId: 'd_cse' }] })).status, 403); // must name the venue's own department
  assert.equal((await put(cookie, 'events', { upsert: [{ ...ev, id: 'm3', forDeptId: 'd_cse', slotIds: ['s3'] }] })).status, 403); // cannot lend to a department they manage
  const meVenue = await venue('d_me');
  assert.equal((await put(cookie, 'events', { upsert: [{ ...ev, id: 'm4', resId: meVenue, lentDeptId: 'd_me', slotIds: ['s4'] }] })).status, 403); // a third department
  assert.equal((await put(cookie, 'events', { remove: ['m1'] })).status, 200);
  // a department that a head still manages cannot be deleted
  const dep = await put(admin, 'depts', { remove: ['d_ece'] });
  assert.equal(dep.status, 409);
});
