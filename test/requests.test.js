import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

let app, cse, ece, admin, stake;
const put = (cookie, key, body) => app.call('PUT', '/api/data/' + key, { cookie, body });
const data = async (c) => (await app.call('GET', '/api/data', { cookie: c })).body.data;
const venue = async (dept) => (await app.db.query(`SELECT id FROM venues WHERE dept_id = $1 ORDER BY id LIMIT 1`, [dept]))[0].id;
let FREE = [], CLS, ECLS;
const DATE = '2026-12-17'; // a Thursday, in the future of the demo data

test('setup', async () => {
  app = await makeApp();
  const rows = await app.db.query(`SELECT email, role, dept_id FROM users WHERE password_hash IS NOT NULL`);
  const by = (role, dept) => rows.find((u) => u.role === role && (!dept || u.dept_id === dept));
  cse = await app.login(by('hod', 'd_cse').email);
  ece = await app.login(by('hod', 'd_ece').email);
  admin = await app.login(by('admin').email);
  stake = await app.login(by('stakeholder').email);
  CLS = (await app.db.query(`SELECT id FROM classes WHERE dept_id = 'd_cse' ORDER BY id LIMIT 1`))[0].id;
  ECLS = (await app.db.query(`SELECT id FROM classes WHERE dept_id = 'd_ece' ORDER BY id LIMIT 1`))[0].id;
  const res = await venue('d_ece');
  const busy = (await app.db.query(`SELECT slot_id FROM timetable WHERE res_id = $1 AND day = 3`, [res])).map((r) => r.slot_id);
  const slots = await app.db.query(`SELECT id FROM slots WHERE NOT is_break ORDER BY start_time`);
  FREE = slots.map((s) => s.id).filter((id) => !busy.includes(id));
});

const mk = (id, resId, over = {}) => ({ id, resId, date: DATE, slotIds: [FREE[0]], title: 'Guest lecture', attendees: 40, reason: 'Our rooms are full', fromDeptId: 'd_cse', classId: CLS, status: 'pending', ...over });

test('a head requests another department venue; only the owner sees it and decides', async () => {
  const res = await venue('d_ece');
  const r = await put(cse, 'vreqs', { upsert: [mk('rq1', res)] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const seen = (await data(ece)).vreqs.find((x) => x.id === 'rq1');
  assert.equal(seen.ownerDeptId, 'd_ece');
  assert.equal(seen.status, 'pending');
  assert.equal((await data(stake)).vreqs.length, 0);
  // pending does not book
  assert.equal((await data(ece)).events.some((e) => e.date === DATE && e.resId === res), false);
  // the requester cannot approve their own request
  assert.equal((await put(cse, 'vreqs', { upsert: [{ ...seen, status: 'approved' }] })).status, 403);
  // rejection needs a remark
  assert.equal((await put(ece, 'vreqs', { upsert: [{ ...seen, status: 'rejected', remarks: '  ' }] })).status, 400);
  const ok = await put(ece, 'vreqs', { upsert: [{ ...seen, status: 'approved', remarks: 'Please leave it tidy' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const after = (await data(cse));
  const rq = after.vreqs.find((x) => x.id === 'rq1');
  assert.equal(rq.status, 'approved');
  assert.equal(rq.remarks, 'Please leave it tidy');
  assert.ok(rq.decidedBy && rq.decidedAt);
  const ev = after.events.find((e) => e.id === rq.eventId);
  assert.equal(ev.forDeptId, 'd_cse');
  assert.equal(ev.lentDeptId, 'd_ece');
  assert.equal(ev.status, 'confirmed');
  // a decided request is final
  assert.equal((await put(ece, 'vreqs', { upsert: [{ ...rq, status: 'rejected', remarks: 'x' }] })).status, 409);
});

test('rules: own venue, taken slot, reject keeps slot free, cancel by requester only', async () => {
  const own = await venue('d_cse'), res = await venue('d_ece');
  assert.equal((await put(cse, 'vreqs', { upsert: [mk('rq2', own)] })).status, 403);
  assert.equal((await put(cse, 'vreqs', { upsert: [mk('rq3', res)] })).status, 409); // slot now booked by rq1
  assert.equal((await put(stake, 'vreqs', { upsert: [mk('rq4', res, { slotIds: [FREE[1]] })] })).status, 403);
  assert.equal((await put(cse, 'vreqs', { upsert: [mk('rq5', res, { slotIds: [FREE[1]], date: '2020-01-01' })] })).status, 400);
  assert.equal((await put(cse, 'vreqs', { upsert: [mk('rq6', res, { slotIds: [FREE[1]] })] })).status, 200);
  const row = (await data(cse)).vreqs.find((x) => x.id === 'rq6');
  assert.equal((await put(ece, 'vreqs', { upsert: [{ ...row, status: 'cancelled' }] })).status, 403);
  assert.equal((await put(ece, 'vreqs', { upsert: [{ ...row, status: 'rejected', remarks: 'Lab maintenance' }] })).status, 200);
  assert.equal((await data(ece)).events.some((e) => e.date === DATE && e.slotIds.includes(FREE[1]) && e.resId === res), false);
  assert.equal((await put(cse, 'vreqs', { upsert: [mk('rq7', res, { slotIds: [FREE[2]] })] })).status, 200);
  const r7 = (await data(cse)).vreqs.find((x) => x.id === 'rq7');
  assert.equal((await put(cse, 'vreqs', { upsert: [{ ...r7, status: 'cancelled' }] })).status, 200);
  assert.equal((await put(cse, 'vreqs', { remove: ['rq7'] })).status, 403);
});

test('the administrator decides requests for central venues', async () => {
  const [c] = await app.db.query(`SELECT id FROM venues WHERE dept_id IS NULL LIMIT 1`);
  if (!c) return;
  assert.equal((await put(cse, 'vreqs', { upsert: [mk('rq8', c.id, { slotIds: [FREE[3]] })] })).status, 200);
  const row = (await data(admin)).vreqs.find((x) => x.id === 'rq8');
  assert.equal((await put(ece, 'vreqs', { upsert: [{ ...row, status: 'approved' }] })).status, 403);
  assert.equal((await put(admin, 'vreqs', { upsert: [{ ...row, status: 'approved' }] })).status, 200);
});

test('year/section is required and must be your own', async () => {
  const res = await venue('d_ece');
  assert.equal((await put(cse, 'vreqs', { upsert: [mk('rc1', res, { slotIds: [FREE[5] || FREE[4]], classId: null })] })).status, 403);
  assert.equal((await put(cse, 'vreqs', { upsert: [mk('rc2', res, { slotIds: [FREE[5] || FREE[4]], classId: ECLS })] })).status, 403);
});

test('alerts: owner is alerted, requester releases an approved request, venue is free again', async () => {
  const res = await venue('d_ece'), slot = FREE[4];
  assert.equal((await put(cse, 'vreqs', { upsert: [mk('rl1', res, { slotIds: [slot], date: '2026-12-18' })] })).status, 200);
  let row = (await data(ece)).vreqs.find((x) => x.id === 'rl1');
  assert.equal(row.ownerSeen, false);
  assert.equal(row.classId, CLS);
  // owner cannot release; requester cannot dismiss owner alert
  assert.equal((await put(ece, 'vreqs', { upsert: [{ ...row, status: 'approved', remarks: 'ok' }] })).status, 200);
  row = (await data(cse)).vreqs.find((x) => x.id === 'rl1');
  assert.equal(row.requesterSeen, false);
  assert.ok((await data(cse)).events.some((e) => e.id === row.eventId && e.title.includes('(CSE')));
  assert.equal((await put(ece, 'vreqs', { upsert: [{ ...row, status: 'released', releaseNote: 'x' }] })).status, 403);
  assert.equal((await put(ece, 'vreqs', { upsert: [{ ...row, requesterSeen: true }] })).status, 403);
  assert.equal((await put(cse, 'vreqs', { upsert: [{ ...row, requesterSeen: true }] })).status, 200);
  assert.equal((await put(cse, 'vreqs', { upsert: [{ ...row, requesterSeen: true, status: 'released', releaseNote: ' ' }] })).status, 400);
  const rel = await put(cse, 'vreqs', { upsert: [{ ...row, requesterSeen: true, status: 'released', releaseNote: 'Programme changed' }] });
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  const d = await data(ece);
  const after = d.vreqs.find((x) => x.id === 'rl1');
  assert.equal(after.status, 'released');
  assert.equal(after.ownerSeen, false);
  assert.equal(after.releaseNote, 'Programme changed');
  assert.equal(d.events.some((e) => e.id === row.eventId), false);
  // the owner dismisses the alert; a released request is final
  assert.equal((await put(ece, 'vreqs', { upsert: [{ ...after, ownerSeen: true }] })).status, 200);
  assert.equal((await put(cse, 'vreqs', { upsert: [{ ...after, status: 'cancelled' }] })).status, 409);
  // the slot can be requested again
  assert.equal((await put(cse, 'vreqs', { upsert: [mk('rl2', res, { slotIds: [slot], date: '2026-12-18' })] })).status, 200);
});
