import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../lib/authz.js';

const ctx = { venueDept: (id) => (id === 'mine' ? 'd1' : 'd2'), classDept: (id) => (id === 'cm' ? 'd1' : 'd2') };
const none = { adds: [], changes: [], removes: [] };

test('an empty change is always allowed', () => {
  for (const role of ['hod', 'head', 'stakeholder', 'admin']) assert.equal(authorize({ role }, 'depts', none, ctx), null);
});

test('hod rules', () => {
  const u = { role: 'hod', deptId: 'd1' };
  assert.equal(authorize(u, 'tt', { ...none, adds: [{ resId: 'mine', classId: 'cm' }] }, ctx), null);
  assert.ok(authorize(u, 'tt', { ...none, adds: [{ resId: 'theirs', classId: 'cm' }] }, ctx));
  assert.ok(authorize(u, 'tt', { ...none, adds: [{ resId: 'mine', classId: 'cx' }] }, ctx));
  assert.ok(authorize(u, 'tt', { ...none, changes: [{ before: { resId: 'theirs', classId: 'cm' }, after: { resId: 'mine', classId: 'cm' } }] }, ctx));
  assert.ok(authorize(u, 'events', { ...none, adds: [{}] }, ctx));
  assert.ok(authorize({ role: 'hod', deptId: null }, 'tt', { ...none, adds: [{ resId: 'mine', classId: 'cm' }] }, ctx));
});

test('head and stakeholder rules', () => {
  assert.equal(authorize({ role: 'head' }, 'events', { ...none, changes: [{ before: {}, after: {} }] }, ctx), null);
  assert.ok(authorize({ role: 'head' }, 'tt', { ...none, adds: [{}] }, ctx));
  const s = { role: 'stakeholder', name: 'Sam' };
  assert.equal(authorize(s, 'events', { ...none, adds: [{ status: 'pending', by: 'Sam' }] }, ctx), null);
  assert.ok(authorize(s, 'events', { ...none, adds: [{ status: 'confirmed', by: 'Sam' }] }, ctx));
  assert.ok(authorize(s, 'events', { ...none, removes: [{ by: 'Other' }] }, ctx));
  assert.ok(authorize(s, 'users', { ...none, adds: [{}] }, ctx));
});
