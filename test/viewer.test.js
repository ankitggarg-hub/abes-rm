import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

test('a view-only account sees availability without names, and cannot change anything', async () => {
  const app = await makeApp();
  const cookie = await app.login('desk@college.example');
  const me = (await app.call('GET', '/api/auth/me', { cookie })).body.user;
  assert.equal(me.role, 'viewer');
  const d = (await app.call('GET', '/api/data', { cookie })).body.data;
  assert.ok(d.resources.length > 0 && d.tt.length > 0 && d.slots.length > 0);
  assert.equal(d.users.length, 1); // only themselves
  assert.deepEqual(d.wplans, []);
  assert.deepEqual(d.loads, []);
  assert.ok(d.tt.every((t) => t.title === 'Class' && t.faculty === ''));
  assert.ok(d.events.every((e) => e.title === 'Booked' && e.by === '' && e.notes === ''));
  assert.ok(d.releases.every((r) => r.note === '' && r.by === ''));
  // writes are refused for every data set
  for (const key of ['events', 'releases', 'resources', 'holidays', 'tt']) {
    const r = await app.call('PUT', '/api/data/' + key, { cookie, body: { upsert: [{ id: 'x' }], remove: [] } });
    assert.ok([400, 403].includes(r.status), key + ' ' + r.status);
  }
  const ev = { id: 'vw1', resId: d.resources[0].id, date: '2027-02-10', slotIds: [d.slots.find((s) => !s.isBreak).id], title: 'Try', by: 'Desk', attendees: 1, notes: '', status: 'pending', forDeptId: null, lentDeptId: null, lentBy: '' };
  assert.equal((await app.call('PUT', '/api/data/events', { cookie, body: { upsert: [ev] } })).status, 403);
});
