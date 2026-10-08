import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, PASSWORD } from './helpers.js';

let app, admin, hod, head, stake;
const put = (cookie, key, body) => app.call('PUT', `/api/data/${key}`, { cookie, body });

before(async () => {
  app = await makeApp();
  admin = await app.login('meera.iyer@college.example');
  hod = await app.login('hod.cse@college.example'); // CSE head
  head = await app.login('principal@college.example');
  stake = await app.login('placement@college.example');
});

test('health works and data needs a session', async () => {
  assert.equal((await app.call('GET', '/api/health')).status, 200);
  assert.equal((await app.call('GET', '/api/data')).status, 401);
  assert.equal((await app.call('GET', '/api/auth/me')).status, 401);
});

test('sign-in checks the password and locks after repeated failures', async () => {
  const bad = await app.call('POST', '/api/auth/login', { body: { email: 'hod.me@college.example', password: 'wrong-password' } });
  assert.equal(bad.status, 401);
  assert.match(bad.body.error, /Incorrect/);
  for (let i = 0; i < 4; i++) await app.call('POST', '/api/auth/login', { body: { email: 'hod.me@college.example', password: 'nope-nope-nope' } });
  const locked = await app.call('POST', '/api/auth/login', { body: { email: 'hod.me@college.example', password: PASSWORD } });
  assert.equal(locked.status, 429);
});

test('everyone gets the campus data but only admins get the user list', async () => {
  const a = await app.call('GET', '/api/data', { cookie: admin });
  assert.equal(a.body.data.users.length, 9);
  assert.equal(a.body.data.resources.length, 15);
  assert.ok(!JSON.stringify(a.body).includes('password'));
  assert.ok(!JSON.stringify(a.body).includes('$2'));
  const h = await app.call('GET', '/api/data', { cookie: hod });
  assert.equal(h.body.data.users.length, 1);
  assert.equal(h.body.user.role, 'hod');
});

test('a department head can edit only their own timetable', async () => {
  const data = (await app.call('GET', '/api/data', { cookie: hod })).body.data;
  const mine = data.resources.filter((r) => r.deptId === 'd_cse').map((r) => r.id);
  const other = data.resources.find((r) => r.deptId === 'd_ece');
  const busy = new Set(data.tt.filter((t) => t.day === 5).map((t) => `${t.resId}|${t.slotId}`));
  const freeSlot = data.slots.find((s) => !busy.has(`r1|${s.id}`) && !data.tt.some((t) => t.day === 5 && t.slotId === s.id && (t.faculty === 'Prof. T. Reddy' || t.classId === 'c_cse_1a')));
  const row = { id: 't_new1', resId: 'r1', day: 5, slotId: freeSlot.id, title: 'Test class', faculty: 'Prof. T. Reddy', classId: 'c_cse_1a' };
  assert.ok(mine.includes('r1'));
  assert.equal((await put(hod, 'tt', { upsert: [row] })).status, 200);
  // another department's venue
  const bad = await put(hod, 'tt', { upsert: [{ ...row, id: 't_new2', resId: other.id }] });
  assert.equal(bad.status, 403);
  // another table
  assert.equal((await put(hod, 'events', { upsert: [] , remove: []})).status, 200); // no-op is allowed
  assert.equal((await put(hod, 'venues', { upsert: [] })).status, 404);
  assert.equal((await put(hod, 'depts', { upsert: [{ id: 'd_x', name: 'X', code: 'X', h: 1 }] })).status, 403);
  // same venue and period twice
  const dup = await put(hod, 'tt', { upsert: [{ ...row, id: 't_new3', faculty: 'Dr. S. Joshi', classId: 'c_cse_2a' }] });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /venue already has a class/);
  // remove it again
  assert.equal((await put(hod, 'tt', { remove: ['t_new1'] })).status, 200);
});

test('faculty and section clashes are refused by the database', async () => {
  const data = (await app.call('GET', '/api/data', { cookie: hod })).body.data;
  const base = data.tt.find((t) => t.resId === 'r7');
  const freeVenue = ['r1', 'r8', 'r9'].find((id) => !data.tt.some((t) => t.resId === id && t.day === base.day && t.slotId === base.slotId));
  const fac = await put(hod, 'tt', { upsert: [{ id: 't_c1', resId: freeVenue, day: base.day, slotId: base.slotId, title: 'X', faculty: base.faculty, classId: 'c_cse_4b' }] });
  assert.equal(fac.status, 409);
  assert.match(fac.body.error, /faculty/);
  const sec = await put(hod, 'tt', { upsert: [{ id: 't_c2', resId: freeVenue, day: base.day, slotId: base.slotId, title: 'X', faculty: 'Nobody Else', classId: base.classId }] });
  assert.equal(sec.status, 409);
  assert.match(sec.body.error, /section/);
});

test('a class can be moved to a free slot in one request', async () => {
  const data = (await app.call('GET', '/api/data', { cookie: hod })).body.data;
  const t = data.tt.find((x) => x.resId === 'r1');
  const target = data.slots.find((s) => !data.tt.some((x) => x.resId === 'r1' && x.day === t.day && x.slotId === s.id) && !data.tt.some((x) => x.day === t.day && x.slotId === s.id && (x.faculty === t.faculty || x.classId === t.classId)));
  const r = await put(hod, 'tt', { upsert: [{ ...t, slotId: target.id }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, 1);
});

test('stakeholders request, the head approves, and bookings cannot overlap', async () => {
  const req = { id: 'e_s1', resId: 'r12', date: '2026-10-12', slotIds: ['s1', 's2'], title: 'Placement drive', by: 'Anita Desai (Training & Placement)', attendees: 100, notes: '', status: 'pending' };
  assert.equal((await put(stake, 'events', { upsert: [{ ...req, status: 'confirmed' }] })).status, 403);
  assert.equal((await put(stake, 'events', { upsert: [{ ...req, by: 'Someone Else' }] })).status, 403);
  assert.equal((await put(stake, 'events', { upsert: [req] })).status, 200);
  // overlapping request for the same hall
  const clash = await put(head, 'events', { upsert: [{ ...req, id: 'e_s2', title: 'Other', by: 'Dr. Vikram Rao', status: 'confirmed', slotIds: ['s2', 's3'] }] });
  assert.equal(clash.status, 409);
  // a Monday class blocks an event (12 Oct 2026 is a Monday; r1 has Monday classes)
  const data = (await app.call('GET', '/api/data', { cookie: admin })).body.data;
  const cls = data.tt.find((t) => t.day === 0 && t.resId === 'r1');
  const blocked = await put(head, 'events', { upsert: [{ ...req, id: 'e_s3', resId: 'r1', slotIds: [cls.slotId], by: 'Dr. Vikram Rao', status: 'confirmed' }] });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /has a class/);
  // stakeholders cannot approve; the head can
  assert.equal((await put(stake, 'events', { upsert: [{ ...req, status: 'confirmed' }] })).status, 403);
  assert.equal((await put(head, 'events', { upsert: [{ ...req, status: 'confirmed' }] })).status, 200);
  // stakeholders cancel only their own
  assert.equal((await put(stake, 'events', { remove: ['e1'] })).status, 403);
  assert.equal((await put(stake, 'events', { remove: ['e_s1'] })).status, 200);
});

test('only admins change masters, with foreign keys protecting data in use', async () => {
  assert.equal((await put(head, 'depts', { upsert: [{ id: 'd_new', name: 'Physics', code: 'PHY', h: 100 }] })).status, 403);
  assert.equal((await put(admin, 'depts', { upsert: [{ id: 'd_new', name: 'Physics', code: 'PHY', h: 100 }] })).status, 200);
  const inUse = await put(admin, 'depts', { remove: ['d_cse'] });
  assert.equal(inUse.status, 409);
  assert.match(inUse.body.error, /in use/);
  const bad = await put(admin, 'floors', { upsert: [{ id: 'f9', name: 'Roof', level: 'high' }] });
  assert.equal(bad.status, 400);
  assert.equal((await put(admin, 'resources', { upsert: [{ id: 'rx', name: 'X', type: 'Gym', buildingId: 'b1', floorId: 'f0', capacity: 10 }] })).status, 400);
});

test('user management: passwords are required, hashed and never returned', async () => {
  const noPw = await put(admin, 'users', { upsert: [{ id: 'u_n1', name: 'New Person', email: 'new@college.example', role: 'stakeholder' }] });
  assert.equal(noPw.status, 400);
  const short = await put(admin, 'users', { upsert: [{ id: 'u_n1', name: 'New Person', email: 'new@college.example', role: 'stakeholder', password: 'short' }] });
  assert.equal(short.status, 400);
  const ok = await put(admin, 'users', { upsert: [{ id: 'u_n1', name: 'New Person', email: 'new@college.example', role: 'stakeholder', password: 'a-good-password' }] });
  assert.equal(ok.status, 200);
  const l = await app.call('POST', '/api/auth/login', { body: { email: 'NEW@college.example', password: 'a-good-password' } });
  assert.equal(l.status, 200);
  assert.equal(l.body.user.role, 'stakeholder');
  // editing without a password keeps the old one
  assert.equal((await put(admin, 'users', { upsert: [{ id: 'u_n1', name: 'New Person 2', email: 'new@college.example', role: 'stakeholder' }] })).status, 200);
  assert.equal((await app.call('POST', '/api/auth/login', { body: { email: 'new@college.example', password: 'a-good-password' } })).status, 200);
  // duplicate email
  const dup = await put(admin, 'users', { upsert: [{ id: 'u_n2', name: 'Dup', email: 'new@college.example', role: 'head', password: 'another-password' }] });
  assert.equal(dup.status, 409);
  // a department head needs a department
  assert.equal((await put(admin, 'users', { upsert: [{ id: 'u_n3', name: 'H', email: 'h@college.example', role: 'hod', password: 'another-password' }] })).status, 400);
  // cannot delete yourself or the last admin
  const me = (await app.call('GET', '/api/auth/me', { cookie: admin })).body.user;
  assert.equal((await put(admin, 'users', { remove: [me.id] })).status, 409);
  const demote = await put(admin, 'users', { upsert: [{ ...me, role: 'head' }] });
  assert.equal(demote.status, 409);
});

test('requests from another site are refused', async () => {
  const r = await app.call('PUT', '/api/data/tt', { cookie: admin, origin: 'https://evil.example', body: { upsert: [] } });
  assert.equal(r.status, 403);
  const ok = await app.call('PUT', '/api/data/tt', { cookie: admin, origin: 'https://planner.test', body: { upsert: [] } });
  assert.equal(ok.status, 200);
});

test('logout clears the cookie and a forged cookie is rejected', async () => {
  const out = await app.call('POST', '/api/auth/logout', { cookie: admin });
  assert.equal(out.status, 200);
  assert.equal((await app.call('GET', '/api/data', { cookie: 'crp_session=abc.def.ghi' })).status, 401);
});
