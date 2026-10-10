import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

let app, admin, hod, hodOther, head, stake, data;
const put = (cookie, key, body) => app.call('PUT', `/api/data/${key}`, { cookie, body });
const nextWeekday = (day) => { // ISO date of the next Monday-based weekday index (0 = Mon) after 2026-10-07
  const d = new Date('2026-10-12T00:00:00Z'); d.setUTCDate(d.getUTCDate() + day); return d.toISOString().slice(0, 10);
};

before(async () => {
  app = await makeApp();
  admin = await app.login('meera.iyer@college.example');
  hod = await app.login('hod.cse@college.example');
  head = await app.login('principal@college.example');
  stake = await app.login('placement@college.example');
  data = (await app.call('GET', '/api/data', { cookie: admin })).body.data;
  const other = data.users.find((u) => u.role === 'hod' && u.email !== 'hod.cse@college.example');
  hodOther = await app.login(other.email);
});

function cseEntry() {
  const cseVenues = new Set(data.resources.filter((r) => r.deptId === data.depts.find((d) => d.code === 'CSE').id).map((r) => r.id));
  return data.tt.find((t) => cseVenues.has(t.resId));
}

test('a department head releases a class for one date and it frees the slot', async () => {
  const t = cseEntry();
  const date = nextWeekday(t.day);
  const r = await put(hod, 'releases', { upsert: [{ id: 'rel1', ttId: t.id, date, reason: 'Industrial visit', note: 'Visit to Infosys', by: 'x' }], remove: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const got = (await app.call('GET', '/api/data', { cookie: stake })).body.data.releases;
  assert.equal(got.length, 1);
  assert.equal(got[0].by, 'Dr. R. Sharma'); // server stamps the author

  // a stakeholder can now book the freed slot, and only once
  const ev = { id: 'evR', resId: t.resId, date, slotIds: [t.slotId], title: 'Drive', by: 'Anita Desai (Training & Placement)', attendees: 10, notes: '', status: 'pending' };
  assert.equal((await put(stake, 'events', { upsert: [ev], remove: [] })).status, 200);
  assert.equal((await put(stake, 'events', { upsert: [{ ...ev, id: 'evR2' }], remove: [] })).status, 409);
});

test('release rules: right weekday, own department, unknown class, stakeholders blocked', async () => {
  const t = cseEntry();
  const wrongDay = nextWeekday((t.day + 1) % 6);
  assert.equal((await put(hod, 'releases', { upsert: [{ id: 'r2', ttId: t.id, date: wrongDay, reason: 'Other', by: 'x' }], remove: [] })).status, 400);
  assert.equal((await put(hodOther, 'releases', { upsert: [{ id: 'r3', ttId: t.id, date: nextWeekday(t.day), reason: 'Other', by: 'x' }], remove: [] })).status, 403);
  assert.equal((await put(hod, 'releases', { upsert: [{ id: 'r4', ttId: 'nope', date: nextWeekday(t.day), reason: 'Other', by: 'x' }], remove: [] })).status, 400);
  assert.equal((await put(stake, 'releases', { upsert: [{ id: 'r5', ttId: t.id, date: nextWeekday(t.day), reason: 'Other', by: 'x' }], remove: [] })).status, 403);
  assert.equal((await put(hod, 'releases', { upsert: [{ id: 'r6', ttId: t.id, date: nextWeekday(t.day), reason: 'Picnic', by: 'x' }], remove: [] })).status, 400);
});

test('restoring a class, and admin or head of institute can release too', async () => {
  const t = cseEntry();
  assert.equal((await put(hodOther, 'releases', { upsert: [], remove: ['rel1'] })).status, 403); // another department's release
  assert.equal((await app.call('GET', '/api/data', { cookie: admin })).body.data.releases.length, 1);
  assert.equal((await put(hod, 'releases', { upsert: [], remove: ['rel1'] })).status, 200);
  assert.equal((await app.call('GET', '/api/data', { cookie: admin })).body.data.releases.length, 0);
  assert.equal((await put(head, 'releases', { upsert: [{ id: 'rh', ttId: t.id, date: nextWeekday(t.day), reason: 'Holiday', by: 'x' }], remove: [] })).status, 200);
  assert.equal((await put(admin, 'releases', { upsert: [], remove: ['rh'] })).status, 200);
});

test('lunch breaks hold nothing, and faculty is optional', async () => {
  const d = (await app.call('GET', '/api/data', { cookie: admin })).body.data;
  const lunch = d.slots.find((s) => s.isBreak);
  assert.ok(lunch, 'demo data has a lunch break');
  const t = cseEntry();
  const free = d.resources.find((r) => r.id === t.resId);
  // a class in the break is refused
  const bad = await put(hod, 'tt', { upsert: [{ id: 'tbrk', resId: free.id, day: 5, slotId: lunch.id, title: 'X', faculty: '', classId: t.classId }], remove: [] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /break/);
  // an event over the break is refused
  const ev = await put(stake, 'events', { upsert: [{ id: 'ebrk', resId: 'r14', date: '2026-10-31', slotIds: [lunch.id], title: 'Lunch', by: 'Anita Desai (Training & Placement)', attendees: 5, status: 'pending' }], remove: [] });
  assert.equal(ev.status, 400);
  // a break cannot be created over a used period
  const used = await put(admin, 'slots', { upsert: [{ id: 's1', label: 'P1', start: '09:00', end: '10:00', isBreak: true }], remove: [] });
  assert.equal(used.status, 409);
  // classes without a faculty name can share a period (no clash check on empty names)
  const used2 = new Set(d.tt.map((x) => `${x.day}-${x.slotId}`));
  const venues = d.resources.filter((r) => r.deptId === free.deptId);
  const classes = d.classes.filter((c) => c.deptId === free.deptId);
  const slot = d.slots.filter((s) => !s.isBreak).find((s) => [0, 1, 2, 3, 4, 5].some((day) => !used2.has(`${day}-${s.id}`)));
  const day = [0, 1, 2, 3, 4, 5].find((x) => !used2.has(`${x}-${slot.id}`));
  const rows = [0, 1].map((i) => ({ id: 'nf' + i, resId: venues[i].id, day, slotId: slot.id, title: 'Open session', faculty: '', classId: classes[i].id }));
  const ok = await put(hod, 'tt', { upsert: rows, remove: [] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('each department has its own lunch periods', async () => {
  const d = (await app.call('GET', '/api/data', { cookie: admin })).body.data;
  const cse = d.depts.find((x) => x.code === 'CSE');
  const ece = d.depts.find((x) => x.code === 'ECE');
  const used = new Set(d.tt.filter((t) => d.classes.find((c) => c.id === t.classId).deptId === cse.id).map((t) => t.slotId));
  const free = d.slots.find((s) => !s.isBreak && !used.has(s.id));
  // a period that CSE already uses cannot become its lunch
  const used1 = [...used][0];
  assert.equal((await put(admin, 'depts', { upsert: [{ ...cse, lunchSlots: [used1] }], remove: [] })).status, 409);
  // the head of CSE sets lunch for CSE only
  const ok = await put(hod, 'depts', { upsert: [{ ...cse, lunchSlots: [free.id] }], remove: [] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await put(hod, 'depts', { upsert: [{ ...ece, lunchSlots: [free.id] }], remove: [] })).status, 403);
  assert.equal((await put(hod, 'depts', { upsert: [{ ...cse, name: 'Renamed', lunchSlots: [free.id] }], remove: [] })).status, 403);
  // classes of CSE are refused in that period, other departments are not
  const cseClass = d.classes.find((c) => c.deptId === cse.id);
  const cseVenue = d.resources.find((r) => r.deptId === cse.id);
  const day = [0, 1, 2, 3, 4, 5].find((x) => !d.tt.some((t) => t.day === x && t.slotId === free.id && (t.resId === cseVenue.id || t.classId === cseClass.id)));
  const bad = await put(hod, 'tt', { upsert: [{ id: 'tl1', resId: cseVenue.id, day, slotId: free.id, title: 'X', faculty: '', classId: cseClass.id }], remove: [] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /lunch break of CSE/);
});
