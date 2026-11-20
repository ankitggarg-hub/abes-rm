import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

let app, admin, cse, ece, head, stake, viewer;
const put = (cookie, key, body) => app.call('PUT', '/api/data/' + key, { cookie, body });
const data = async (c) => (await app.call('GET', '/api/data', { cookie: c })).body.data;

test('setup', async () => {
  app = await makeApp();
  const rows = await app.db.query(`SELECT email, role, dept_id FROM users WHERE password_hash IS NOT NULL`);
  const by = (role, dept) => rows.find((u) => u.role === role && (!dept || u.dept_id === dept));
  admin = await app.login(by('admin').email);
  cse = await app.login(by('hod', 'd_cse').email);
  ece = await app.login(by('hod', 'd_ece').email);
  head = await app.login(by('head').email);
  stake = await app.login(by('stakeholder').email);
  viewer = await app.login(by('viewer').email);
});

test('programmes, terms and subjects are readable by all, changed only by admins', async () => {
  const d = await data(cse);
  assert.deepEqual(d.programmes.map((p) => [p.code, p.semesters]).sort(), [['B.Tech', 8], ['BCA', 6], ['MBA', 4], ['MCA', 4]]);
  assert.ok(d.subjects.length > 50 && d.terms.length === 1);
  assert.equal((await put(cse, 'programmes', { upsert: [{ id: 'px', code: 'X', name: 'X', semesters: 4 }] })).status, 403);
  assert.equal((await put(cse, 'subjects', { upsert: [{ id: 'sx', code: 'X1', name: 'X', programmeId: 'p_btech', deptId: 'd_cse', semester: 1 }] })).status, 403);
  assert.equal((await put(cse, 'terms', { remove: ['t_2627o'] })).status, 403);
  assert.equal((await put(admin, 'programmes', { upsert: [{ id: 'px', code: 'MCA2', name: 'Test', semesters: 4 }] })).status, 200);
});

test('a subject cannot sit beyond its programme length; a term cannot overlap', async () => {
  assert.equal((await put(admin, 'subjects', { upsert: [{ id: 'sx', code: 'MBA901', name: 'Too far', programmeId: 'p_mba', deptId: 'd_mba', semester: 5 }] })).status, 400);
  assert.equal((await put(admin, 'subjects', { upsert: [{ id: 'sx', code: 'MBA499', name: 'OK', programmeId: 'p_mba', deptId: 'd_mba', semester: 4 }] })).status, 200);
  const t = (await data(admin)).terms[0];
  assert.equal((await put(admin, 'terms', { upsert: [{ id: 'tn', session: '2026-27', kind: 'even', startDate: t.startDate, endDate: t.endDate }] })).status, 409);
  assert.equal((await put(admin, 'terms', { upsert: [{ id: 'tn', session: '2026-27', kind: 'even', startDate: '2027-02-01', endDate: '2027-06-01' }] })).status, 200);
});

test('a section year cannot go beyond the programme', async () => {
  assert.equal((await put(admin, 'classes', { upsert: [{ id: 'c_mba_3a', deptId: 'd_mba', year: 3, section: 'A', strength: 60, tracked: true }] })).status, 400);
  assert.equal((await put(admin, 'classes', { upsert: [{ id: 'c_cse_4c', deptId: 'd_cse', year: 4, section: 'C', strength: 60, tracked: true }] })).status, 200);
});

test('syllabus: heads enter their own sections, units capped, other roles blocked, old fortnights locked', async () => {
  const d = await data(cse);
  const cls = d.classes.find((c) => c.deptId === 'd_cse' && c.year === 2 && c.section === 'A');
  const sem = 2 * cls.year - 1;
  const sub = d.subjects.find((s) => s.deptId === 'd_cse' && s.semester === sem);
  const other = d.subjects.find((s) => s.deptId === 'd_ece' && s.semester === sem);
  const ecls = d.classes.find((c) => c.deptId === 'd_ece');
  // the current fortnight (Monday on or before today, in India time)
  const t = new Date(Date.now() + 5.5 * 3600e3), wd = t.getUTCDay();
  const mon = new Date(t.getTime() - (wd === 0 ? 6 : wd - 1) * 864e5).toISOString().slice(0, 10);
  const row = (o) => ({ id: 'syn1', classId: cls.id, subjectId: sub.id, fortnight: mon, unitsDone: 2, pct: 40, remark: 'on track', ...o });
  assert.equal((await put(cse, 'syllabus', { upsert: [row()] })).status, 200);
  assert.equal((await put(cse, 'syllabus', { upsert: [row({ unitsDone: sub.units + 1 })] })).status, 400);
  assert.equal((await put(cse, 'syllabus', { upsert: [row({ subjectId: other.id })] })).status, 400);
  assert.equal((await put(cse, 'syllabus', { upsert: [row({ id: 'syn2', classId: ecls.id, subjectId: other.id })] })).status, 403);
  assert.equal((await put(ece, 'syllabus', { upsert: [row({ unitsDone: 3 })] })).status, 403);
  assert.equal((await put(head, 'syllabus', { upsert: [row({ unitsDone: 3 })] })).status, 403);
  assert.equal((await data(stake)).syllabus.length, 0);
  assert.equal((await data(viewer)).syllabus.length, 0);
  // a long-closed fortnight is locked for the head, open for the admin, and reopens with an unlock
  const old = '2026-02-02';
  const oldRow = row({ id: 'syn3', fortnight: old });
  assert.equal((await put(cse, 'syllabus', { upsert: [oldRow] })).status, 403);
  assert.equal((await put(admin, 'syllabus', { upsert: [oldRow] })).status, 200);
  assert.equal((await put(cse, 'syllabus', { upsert: [{ ...oldRow, unitsDone: 1 }] })).status, 403);
  assert.equal((await put(cse, 'sunlocks', { upsert: [{ id: 'su1', classId: cls.id, fortnight: old, until: '2099-01-01' }] })).status, 403);
  assert.equal((await put(admin, 'sunlocks', { upsert: [{ id: 'su1', classId: cls.id, fortnight: old, until: '2099-01-01', note: 'late' }] })).status, 200);
  assert.equal((await put(cse, 'syllabus', { upsert: [{ ...oldRow, unitsDone: 1 }] })).status, 200);
  // a fortnight that has not started yet, and a non-Monday start
  assert.equal((await put(cse, 'syllabus', { upsert: [row({ id: 'syn4', fortnight: '2099-01-05' })] })).status, 400);
  assert.equal((await put(admin, 'syllabus', { upsert: [row({ id: 'syn5', fortnight: '2026-02-03' })] })).status, 400);
});

test('lab groups: groups run parallel lab periods, but not alongside a whole-section class', async () => {
  const d = await data(admin);
  const cls = d.classes.find((c) => c.deptId === 'd_cse' && c.year === 3 && c.section === 'A');
  const g = d.cgroups.filter((x) => x.classId === cls.id);
  assert.deepEqual(g.map((x) => x.name), ['G1', 'G2']);
  const labs = d.resources.filter((r) => r.type === 'Laboratory' || /lab/i.test(r.name)).slice(0, 2);
  const lunch = d.depts.find((q) => q.id === 'd_cse').lunchSlots || [];
  const busy = (day, sid) => d.tt.some((t) => t.day === day && t.slotId === sid && (t.classId === cls.id || labs.some((l) => l.id === t.resId)));
  let day = 5, slot;
  for (const dd of [5, 4, 3, 2, 1, 0]) { slot = d.slots.find((s) => !s.isBreak && !lunch.includes(s.id) && !busy(dd, s.id)); if (slot) { day = dd; break; } }
  const row = (id, resId, groupId) => ({ id, resId, day, slotId: slot.id, title: 'Lab', faculty: '', classId: cls.id, groupId });
  assert.equal((await put(admin, 'tt', { upsert: [row('lg1', labs[0].id, g[0].id), row('lg2', labs[1].id, g[1].id)] })).status, 200);
  const venue3 = d.resources.find((r) => r.id !== labs[0].id && r.id !== labs[1].id);
  assert.equal((await put(admin, 'tt', { upsert: [row('lg3', venue3.id, '')] })).status, 409);
  assert.equal((await put(admin, 'tt', { upsert: [row('lg4', venue3.id, 'nope')] })).status, 400);
  assert.equal((await put(admin, 'cgroups', { remove: [g[0].id] })).status, 409);
  assert.equal((await put(cse, 'cgroups', { upsert: [{ id: 'gx', classId: cls.id, name: 'G3', strength: 10 }] })).status, 403);
});
