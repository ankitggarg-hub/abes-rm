import { TABLES, upsertSql } from './schema.js';
import { hashPassword } from './auth.js';
import { sampleData } from './sample-data.js';

const ORDER = ['depts', 'classes', 'slots', 'buildings', 'floors', 'resources', 'users', 'tt', 'releases', 'events', 'vreqs', 'loads', 'holidays', 'wplans', 'unlocks'];

/** Loads the demo campus. `q(text, params)` runs on any connection. */
export async function loadDemo(q, { password, today = new Date().toISOString().slice(0, 10) } = {}) {
  const data = sampleData(today);
  const pwHash = await hashPassword(password);
  for (const key of [...ORDER].reverse()) await q(`DELETE FROM ${TABLES[key].table}`);
  for (const key of ORDER) {
    let rows = data[key] || [];
    if (key === 'depts') rows = rows.map((d) => ({ lunchSlots: [], ...d }));
    if (key === 'slots') rows = rows.map((s) => ({ isBreak: false, ...s }));
    if (key === 'holidays') rows = rows.map((h) => ({ classId: null, kind: 'off', slotFrom: null, slotTo: null, by: '', ...h }));
    if (key === 'wplans') rows = rows.map((w) => ({ actual: null, ...w }));
    if (key === 'events') rows = rows.map((e) => ({ forDeptId: null, lentDeptId: null, lentBy: '', ...e }));
    if (key === 'users') rows = rows.map((u) => ({ moreDeptIds: [], ...u, pwHash }));
    await q(upsertSql(TABLES[key]), [JSON.stringify(rows)]);
  }
  return Object.fromEntries(ORDER.map((k) => [k, (data[k] || []).length]));
}
