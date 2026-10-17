import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayState, lastWorkingDay } from '../lib/calendar.js';

// 2026-10-05 is a Monday
test('Saturday and Sunday are off by default, weekdays are working', () => {
  assert.equal(dayState('2026-10-05', []), 'working');
  assert.equal(dayState('2026-10-09', []), 'working');
  assert.equal(dayState('2026-10-10', []), 'off');
  assert.equal(dayState('2026-10-11', []), 'off');
  assert.equal(lastWorkingDay('2026-10-05', []), '2026-10-09');
});

test('a Saturday can be converted to a working day, and an off day marked on a weekday', () => {
  const rows = [{ f: '2026-10-10', t: '2026-10-10', kind: 'working', classId: null }, { f: '2026-10-07', t: '2026-10-08', kind: 'off', classId: null }];
  assert.equal(dayState('2026-10-10', rows), 'working');
  assert.equal(dayState('2026-10-07', rows), 'off');
  assert.equal(dayState('2026-10-08', rows), 'off');
  assert.equal(lastWorkingDay('2026-10-05', rows), '2026-10-10'); // the working Saturday ends the week
});

test('a section entry beats a campus entry, and working beats off at the same level', () => {
  const campusOff = { f: '2026-10-06', t: '2026-10-06', kind: 'off', classId: null };
  assert.equal(dayState('2026-10-06', [campusOff]), 'off');
  assert.equal(dayState('2026-10-06', [campusOff, { ...campusOff, kind: 'working', classId: 'c1' }]), 'working'); // the section works despite a central holiday
  assert.equal(dayState('2026-10-07', [{ f: '2026-10-07', t: '2026-10-07', kind: 'working', classId: null }, { f: '2026-10-07', t: '2026-10-07', kind: 'off', classId: 'c1' }]), 'off'); // the section is off though the campus works
  assert.equal(dayState('2026-10-06', [campusOff, { ...campusOff, kind: 'working' }]), 'working');
});

test('a week that is off entirely has no last working day', () => {
  const rows = [{ f: '2026-10-05', t: '2026-10-11', kind: 'off', classId: null }];
  assert.equal(lastWorkingDay('2026-10-05', rows), null);
});
