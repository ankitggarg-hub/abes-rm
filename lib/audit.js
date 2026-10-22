// Activity log: every change, sign-in and refused change is recorded with who did it.
// Entries are written by the server in the same transaction as the change, so a change cannot happen unrecorded.

export const ENTITY = {
  depts: 'Department', classes: 'Year & section', slots: 'Period', buildings: 'Building', floors: 'Floor', resources: 'Venue',
  users: 'User', tt: 'Timetable class', releases: 'Class change', events: 'Event / booking', vreqs: 'Venue request',
  loads: 'Load type', holidays: 'Off day', wplans: 'Weekly plan', unlocks: 'Tracker unlock', session: 'Sign-in',
};
export const ACTIONS = ['create', 'update', 'delete', 'login', 'login_failed', 'logout', 'denied'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SKIP = new Set(['id', 'pwHash', 'password']);
const RETAIN_MONTHS = 18;

const short = (v) => {
  if (v === null || v === undefined || v === '') return '–';
  const s = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
};
const clean = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !SKIP.has(k)));

async function lookups(q, key, rows) {
  const m = { cls: new Map(), load: new Map(), venue: new Map(), slot: new Map() };
  if (!rows.length) return m;
  const needCls = ['wplans', 'tt', 'releases', 'holidays', 'unlocks', 'vreqs', 'classes'].includes(key);
  if (needCls) for (const c of await q(`SELECT c.id, d.code || '-' || c.year || '-' || c.section AS label FROM classes c JOIN departments d ON d.id = c.dept_id`)) m.cls.set(c.id, c.label);
  if (key === 'wplans') for (const l of await q(`SELECT id, name FROM load_types`)) m.load.set(l.id, l.name);
  if (['tt', 'events', 'vreqs', 'releases'].includes(key)) for (const v of await q(`SELECT id, name FROM venues`)) m.venue.set(v.id, v.name);
  if (key === 'tt') for (const s of await q(`SELECT id, label FROM slots`)) m.slot.set(s.id, s.label);
  if (key === 'classes') m.dept = new Map((await q(`SELECT id, code FROM departments`)).map((d) => [d.id, d.code]));
  return m;
}

function nameOf(key, r, m) {
  const cl = (id) => m.cls.get(id) || id || '';
  switch (key) {
    case 'wplans': return `${cl(r.classId)} · ${m.load.get(r.loadId) || r.loadId} · week of ${r.weekStart}`;
    case 'tt': return `${cl(r.classId)} · ${m.venue.get(r.resId) || r.resId} · ${DAYS[r.day] || r.day} ${m.slot.get(r.slotId) || r.slotId}`;
    case 'releases': return `${cl(r.classId)} · ${m.venue.get(r.resId) || r.resId || ''} · ${r.date}`;
    case 'events': return `${r.title} · ${m.venue.get(r.resId) || r.resId} · ${r.date}`;
    case 'vreqs': return `${r.title} · ${m.venue.get(r.resId) || r.resId} · ${r.date}${r.classId ? ' · ' + cl(r.classId) : ''}`;
    case 'holidays': return `${r.title} · ${r.dateFrom}${r.dateTo !== r.dateFrom ? ' to ' + r.dateTo : ''}${r.classId ? ' · ' + cl(r.classId) : ' · whole campus'}`;
    case 'unlocks': return `${cl(r.classId)} · week of ${r.weekStart} · until ${r.until}`;
    case 'classes': return `${(m.dept && m.dept.get(r.deptId)) || r.deptId}-${r.year}-${r.section}`;
    case 'users': return `${r.name}${r.email ? ' (' + r.email + ')' : ''}`;
    default: return r.name || r.title || r.label || r.code || r.id;
  }
}

/** Records the adds, changes and removes of one save. `q` is the open transaction. */
export async function auditWrite(q, user, key, { adds, changes, removes, extra = {} }) {
  const all = [...adds, ...removes, ...changes.map((c) => c.after)];
  if (!all.length) return;
  const m = await lookups(q, key, all);
  const label = ENTITY[key] || key;
  const out = [];
  for (const r of adds) out.push({ action: 'create', entity: key, entity_id: r.id, summary: `Added ${label.toLowerCase()}: ${nameOf(key, r, m)}`, detail: { after: clean(r), ...extra } });
  for (const r of removes) out.push({ action: 'delete', entity: key, entity_id: r.id, summary: `Deleted ${label.toLowerCase()}: ${nameOf(key, r, m)}`, detail: { before: clean(r) } });
  for (const { before, after } of changes) {
    const diff = {};
    for (const k of Object.keys(clean(after))) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diff[k] = [before[k] ?? null, after[k] ?? null];
    }
    if (after.pwHash) diff.password = ['(hidden)', 'changed'];
    const parts = Object.entries(diff).slice(0, 4).map(([k, [a, b]]) => `${k}: ${short(a)} → ${short(b)}`);
    out.push({ action: 'update', entity: key, entity_id: after.id, summary: `Changed ${label.toLowerCase()} ${nameOf(key, after, m)} — ${parts.join('; ') || 'no visible change'}`, detail: { changes: diff } });
  }
  await insertRows(q, user, out);
}

async function insertRows(q, user, rows) {
  if (!rows.length) return;
  const base = { user_id: user?.id || '', user_name: user?.name || '', role: user?.role || '' };
  const payload = rows.map((r) => ({ ...base, ...r, summary: String(r.summary).slice(0, 500) }));
  await q(
    `INSERT INTO activity_log (user_id, user_name, role, action, entity, entity_id, summary, detail)
     SELECT x.user_id, x.user_name, x.role, x.action, coalesce(x.entity,''), coalesce(x.entity_id,''), x.summary, coalesce(x.detail,'{}'::jsonb)
     FROM jsonb_to_recordset($1::jsonb) AS x(user_id text, user_name text, role text, action text, entity text, entity_id text, summary text, detail jsonb)`,
    [JSON.stringify(payload)]
  );
}

/** One-off entry (sign-in, refused change). Never lets a logging problem break the request. */
export async function logEvent(q, user, entry) {
  try { await insertRows(q, user, [{ entity: '', entity_id: '', detail: {}, ...entry }]); } catch { /* logging must not break the app */ }
}

/** Administrator search. Also trims entries older than the retention period. */
export async function queryAudit(q, p = {}) {
  await q(`DELETE FROM activity_log WHERE at < now() - interval '${RETAIN_MONTHS} months'`);
  const where = [], args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '$' + args.length)); };
  if (p.user) add('user_id = ?', String(p.user));
  if (p.entity) add('entity = ?', String(p.entity));
  if (p.action) add('action = ?', String(p.action));
  if (p.from && /^\d{4}-\d{2}-\d{2}$/.test(p.from)) add(`at >= (?::date)::timestamp - interval '5 hours 30 minutes'`, p.from);
  if (p.to && /^\d{4}-\d{2}-\d{2}$/.test(p.to)) add(`at < (?::date + 1)::timestamp - interval '5 hours 30 minutes'`, p.to);
  if (p.q) {
    args.push('%' + String(p.q).replace(/[%_\\]/g, '\\$&') + '%');
    const n = '$' + args.length;
    where.push(`(summary ILIKE ${n} OR user_name ILIKE ${n} OR detail::text ILIKE ${n})`);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Math.max(parseInt(p.limit, 10) || 50, 1), 1000), offset = Math.max(parseInt(p.offset, 10) || 0, 0);
  const rows = await q(`SELECT id::text AS id, at, user_id AS "userId", user_name AS "userName", role, action, entity, entity_id AS "entityId", summary, detail FROM activity_log ${w} ORDER BY at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, args);
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM activity_log ${w}`, args);
  return { rows, total: n };
}
