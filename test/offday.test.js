import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';
import { addDays, releaseOffRows } from '../lib/calendar.js';

let app, admin, cls;
const put = (cookie, key, body) => app.call('PUT', '/api/data/' + key, { cookie, body });
let n = 0;
const ev = (resId, date, slotIds) => ({ id: 'od' + ++n, resId, date, slotIds, title: 'Seminar', by: 'Someone', attendees: 5, notes: '', status: 'confirmed', forDeptId: null, lentDeptId: null, lentBy: '' });
const hol = (o) => ({ id: 'oh' + ++n, title: 'Test', classId: null, kind: 'off', slotFrom: null, slotTo: null, ...o });

test('setup', async () => {
  app = await makeApp();
  admin = await app.login('meera.iyer@college.example');
  // a weekday timetable class (Monday to Friday) and the date it falls on in January 2027 (4 Jan is a Monday)
  [cls] = await app.db.query(`SELECT t.res_id AS "resId", t.slot_id AS "slotId", t.day, t.class_id AS "classId" FROM timetable t WHERE t.day <= 4 ORDER BY t.id LIMIT 1`);
  cls.date = addDays('2027-01-04', cls.day);
});

test('a venue cannot be booked on a Saturday until it is converted to a working day', async () => {
  const sat = '2027-01-09';
  const r = await put(admin, 'events', { upsert: [ev(cls.resId, sat, [cls.slotId])] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /off day/);
  assert.equal((await put(admin, 'holidays', { upsert: [hol({ dateFrom: sat, dateTo: sat, kind: 'working' })] })).status, 200);
  // once converted the weekly Saturday timetable applies, so book a period nobody teaches in
  const free = await app.db.query(`SELECT id FROM slots WHERE is_break = false AND id NOT IN (SELECT slot_id FROM timetable WHERE res_id = $1 AND day = 5)`, [cls.resId]);
  assert.equal((await put(admin, 'events', { upsert: [ev(cls.resId, sat, [free[0].id])] })).status, 200);
});

test('a campus-wide off day frees the venue of a weekday class', async () => {
  const blocked = await put(admin, 'events', { upsert: [ev(cls.resId, cls.date, [cls.slotId])] });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /class/);
  assert.equal((await put(admin, 'holidays', { upsert: [hol({ id: 'hcamp', dateFrom: cls.date, dateTo: cls.date })] })).status, 200);
  assert.equal((await put(admin, 'events', { upsert: [ev(cls.resId, cls.date, [cls.slotId])] })).status, 200);
});

test('an off day for the section frees its venue, and a different section does not', async () => {
  const other = addDays(cls.date, 7);
  assert.equal((await put(admin, 'holidays', { upsert: [hol({ dateFrom: other, dateTo: other, classId: cls.classId })] })).status, 200);
  assert.equal((await put(admin, 'events', { upsert: [ev(cls.resId, other, [cls.slotId])] })).status, 200);
});

test('a part-day off day frees only its periods', async () => {
  const slots = await app.db.query(`SELECT id FROM slots WHERE is_break = false ORDER BY start_time`);
  const idx = slots.findIndex((s) => s.id === cls.slotId);
  const date = addDays(cls.date, 14);
  const inside = { slotFrom: slots[idx].id, slotTo: slots[Math.min(idx + 1, slots.length - 1)].id };
  assert.equal((await put(admin, 'holidays', { upsert: [hol({ dateFrom: date, dateTo: date, ...inside })] })).status, 200);
  assert.equal((await put(admin, 'events', { upsert: [ev(cls.resId, date, [cls.slotId])] })).status, 200);
  // a class outside the periods still holds its venue
  const date2 = addDays(cls.date, 21);
  const outside = idx === 0 ? { slotFrom: slots[1].id, slotTo: slots[1].id } : { slotFrom: slots[0].id, slotTo: slots[0].id };
  assert.equal((await put(admin, 'holidays', { upsert: [hol({ dateFrom: date2, dateTo: date2, ...outside })] })).status, 200);
  assert.equal((await put(admin, 'events', { upsert: [ev(cls.resId, date2, [cls.slotId])] })).status, 409);
});

test('period ranges are validated', async () => {
  const d = '2027-03-01';
  assert.equal((await put(admin, 'holidays', { upsert: [hol({ dateFrom: d, dateTo: d, slotFrom: 's1' })] })).status, 400); // only one period
  assert.equal((await put(admin, 'holidays', { upsert: [hol({ dateFrom: d, dateTo: d, kind: 'working', slotFrom: 's1', slotTo: 's2' })] })).status, 400); // working days are whole days
  assert.equal((await put(admin, 'holidays', { upsert: [hol({ dateFrom: d, dateTo: d, slotFrom: 's3', slotTo: 's1' })] })).status, 400); // reversed
});

test('a day on which every class of a section was released counts as an off day', () => {
  const tt = [{ id: 'a', day: 1 }, { id: 'b', day: 1 }, { id: 'c', day: 2 }];
  // 2027-01-05 is a Tuesday (day 1): both Tuesday classes released; Wednesday only if its class is
  const rows = releaseOffRows('c1', tt, [{ ttId: 'a', date: '2027-01-05' }, { ttId: 'b', date: '2027-01-05' }, { ttId: 'a', date: '2027-01-12' }]);
  assert.deepEqual(rows.map((r) => r.f), ['2027-01-05']); // 12 Jan has only one of two classes released: a part day
});
