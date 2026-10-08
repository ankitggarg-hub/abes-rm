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
