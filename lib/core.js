// The whole API, independent of Vercel or Netlify.
// handle({ method, url, headers, body }) -> { status, headers, body }

import { TABLES, TABLE_KEYS, selectList, upsertSql, validateRow, fingerprint } from './schema.js';
import { authorize } from './authz.js';
import { dayState, lastWorkingDay, addDays, isPartDay, classRuns, campusClosed, releaseOffRows } from './calendar.js';
import { randomUUID } from 'node:crypto';
import { COOKIE, DUMMY_HASH, SESSION_SECONDS, checkPassword, clearCookie, hashPassword, parseCookies, readSession, sessionCookie, signSession } from './auth.js';

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const MAX_ROWS = 2000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (status, body, extra = {}) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  body,
});

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, deptId: u.deptId ?? null, moreDeptIds: u.moreDeptIds ?? [] });

export function createHandler({ withDb, env = process.env }) {
  const secure = env.COOKIE_SECURE ? env.COOKIE_SECURE !== 'false' : Boolean(env.VERCEL || env.NETLIFY || env.NODE_ENV === 'production');

  function secret() {
    const s = env.SESSION_SECRET;
    if (!s || s.length < 32) throw new HttpError(500, 'The server is missing SESSION_SECRET (at least 32 characters).');
    return s;
  }

  const idleMinutes = Math.max(1, Number(env.SESSION_IDLE_MINUTES) || 60);
  const MAX_SESSIONS = 5;

  // Valid only if the session row exists, has not expired and the user was active recently.
  // Background refreshes (x-background) do not count as activity, so an unattended tab times out.
  async function currentUser(db, headers) {
    const token = parseCookies(headers.cookie)[COOKIE];
    const sess = await readSession(token, secret());
    if (!sess) return null;
    const rows = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.dept_id AS "deptId", u.more_dept_ids AS "moreDeptIds", s.id AS sid, s.last_seen AS "lastSeen"
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND u.password_hash IS NOT NULL
         AND s.expires_at > now() AND s.last_seen > now() - ($3 || ' minutes')::interval`,
      [sess.sid, sess.userId, String(idleMinutes)]
    );
    const u = rows[0];
    if (!u) return null;
    if (!headers['x-background'] && Date.now() - new Date(u.lastSeen).getTime() > 60000) {
      await db.query(`UPDATE sessions SET last_seen = now() WHERE id = $1`, [u.sid]);
    }
    return u;
  }

  async function login(db, body, headers = {}) {
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    if (!email || !password) throw new HttpError(400, 'Enter your email and password.');

    const [att] = await db.query(`SELECT attempts, locked_until FROM login_attempts WHERE email = $1`, [email]);
    if (att?.locked_until && new Date(att.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(att.locked_until) - new Date()) / 60000);
      throw new HttpError(429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    const [user] = await db.query(
      `SELECT id, name, email, role, dept_id AS "deptId", more_dept_ids AS "moreDeptIds", password_hash AS hash FROM users WHERE lower(email) = $1`,
      [email]
    );
    const ok = await checkPassword(password, user?.hash || DUMMY_HASH);
    if (!user || !user.hash || !ok) {
      await db.query(
        `INSERT INTO login_attempts (email, attempts, locked_until) VALUES ($1, 1, NULL)
         ON CONFLICT (email) DO UPDATE SET
           attempts = CASE WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now() THEN 1 ELSE login_attempts.attempts + 1 END,
           locked_until = CASE WHEN (CASE WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now() THEN 1 ELSE login_attempts.attempts + 1 END) >= ${MAX_ATTEMPTS}
                               THEN now() + interval '${LOCK_MINUTES} minutes' ELSE NULL END`,
        [email]
      );
      throw new HttpError(401, 'Incorrect email or password.');
    }
    await db.query(`DELETE FROM login_attempts WHERE email = $1`, [email]);
    const sid = randomUUID();
    await db.query(`DELETE FROM sessions WHERE expires_at <= now() OR last_seen <= now() - interval '1 day'`);
    await db.query(
      `INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1, $2, now() + ($3 || ' seconds')::interval, $4)`,
      [sid, user.id, String(SESSION_SECONDS), String(headers['user-agent'] || '').slice(0, 200)]
    );
    // keep only the newest few sessions per user
    await db.query(
      `DELETE FROM sessions WHERE user_id = $1 AND id NOT IN (SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${MAX_SESSIONS})`,
      [user.id]
    );
    const token = await signSession(user.id, secret(), sid);
    return json(200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(token, { secure }) });
  }

  async function readAll(db, user) {
    const data = {};
    await Promise.all(
      TABLE_KEYS.map(async (key) => {
        const def = TABLES[key];
        if (key === 'users' && user.role !== 'admin') {
          // everyone can pick a department head by name when lending a venue; no email addresses
          const heads = await db.query(`SELECT id, name, role, dept_id AS "deptId", more_dept_ids AS "moreDeptIds" FROM users WHERE role = 'hod' AND id <> $1 ORDER BY name`, [user.id]);
          data.users = [publicUser(user), ...heads.map((h) => ({ ...h, email: '' }))];
          return;
        }
        if (key === 'wplans' && user.role === 'stakeholder') { data.wplans = []; return; }
        data[key] = await db.query(`SELECT ${selectList(def)} FROM ${def.table} ORDER BY ${def.order}`);
      })
    );
    return data;
  }

  async function fetchExisting(q, def, ids) {
    if (!ids.length) return [];
    return q(`SELECT ${selectList(def)} FROM ${def.table} WHERE id = ANY($1::text[])`, [ids]);
  }

  async function write(db, user, key, body) {
    const def = TABLES[key];
    if (!def) throw new HttpError(404, 'Unknown data set.');
    const upsertIn = Array.isArray(body?.upsert) ? body.upsert : [];
    const removeIn = Array.isArray(body?.remove) ? body.remove : [];
    if (upsertIn.length > MAX_ROWS || removeIn.length > MAX_ROWS) throw new HttpError(413, 'Too many rows in one request.');

    // validate
    const rows = [];
    const seen = new Set();
    for (const raw of upsertIn) {
      const { row, error } = validateRow(def, raw);
      if (error) throw new HttpError(400, error);
      if (seen.has(row.id)) throw new HttpError(400, 'The same id appears twice.');
      seen.add(row.id);
      if (key === 'users') {
        if (raw.password !== undefined && raw.password !== null && raw.password !== '') {
          const pw = String(raw.password);
          if (pw.length < 8 || pw.length > 72) throw new HttpError(400, 'A password must be 8 to 72 characters.');
          row.pwHash = await hashPassword(pw);
        }
        if (row.role === 'hod' && !row.deptId) throw new HttpError(400, 'A department head needs a department.');
        if (row.role !== 'hod') { row.deptId = null; row.moreDeptIds = []; }
        row.moreDeptIds = (row.moreDeptIds || []).filter((id) => id !== row.deptId);
      }
      if (key === 'releases' || key === 'holidays') row.by = user.name;
      rows.push(row);
    }
    const removeIds = [...new Set(removeIn.map(String))];
    if (removeIds.some((id) => !/^[A-Za-z0-9_-]{1,48}$/.test(id))) throw new HttpError(400, 'Invalid id.');

    return db.tx(async (q) => {
      const existing = await fetchExisting(q, def, [...rows.map((r) => r.id), ...removeIds]);
      const byId = new Map(existing.map((r) => [r.id, r]));
      const adds = [];
      const changes = [];
      for (const r of rows) {
        const before = byId.get(r.id);
        if (!before) adds.push(r);
        else if (fingerprint(def, before) !== fingerprint(def, r) || r.pwHash) changes.push({ before, after: r });
      }
      const removes = removeIds.map((id) => byId.get(id)).filter(Boolean);

      // a release carries the venue and class of the timetable entry it frees
      if (key === 'releases') {
        const ttIds = [...new Set([...adds, ...removes, ...changes.flatMap((c) => [c.before, c.after])].map((r) => r.ttId))];
        const tts = ttIds.length ? await q(`SELECT id, res_id AS "resId", class_id AS "classId", day FROM timetable WHERE id = ANY($1::text[])`, [ttIds]) : [];
        const tMap = new Map(tts.map((t) => [t.id, t]));
        for (const r of [...adds, ...removes, ...changes.flatMap((c) => [c.before, c.after])]) {
          const t = tMap.get(r.ttId);
          if (t) { r.resId = t.resId; r.classId = t.classId; r.day = t.day; }
        }
        for (const r of [...adds, ...changes.map((c) => c.after)]) {
          const jsDay = new Date(r.date + 'T00:00:00Z').getUTCDay();
          if (r.day === undefined) throw new HttpError(400, 'That timetable class no longer exists.');
          if (jsDay === 0 || jsDay - 1 !== r.day) throw new HttpError(400, 'The date does not fall on the weekday of that class.');
          r.by = r.by || user.name;
        }
      }

      // permissions
      const venueIds = new Set();
      const classIds = new Set();
      for (const r of [...adds, ...removes, ...changes.flatMap((c) => [c.before, c.after])]) {
        if (r.resId) venueIds.add(r.resId);
        if (r.classId) classIds.add(r.classId);
      }
      const venues = venueIds.size ? await q(`SELECT id, dept_id AS "deptId" FROM venues WHERE id = ANY($1::text[])`, [[...venueIds]]) : [];
      const classes = classIds.size ? await q(`SELECT id, dept_id AS "deptId" FROM classes WHERE id = ANY($1::text[])`, [[...classIds]]) : [];
      const vMap = new Map(venues.map((v) => [v.id, v.deptId]));
      const cMap = new Map(classes.map((c) => [c.id, c.deptId]));
      const denied = authorize(user, key, { adds, changes, removes }, { venueDept: (id) => vMap.get(id), classDept: (id) => cMap.get(id) });
      if (denied) throw new HttpError(403, denied);

      // breaks (lunch) cannot hold classes or events
      if (key === 'tt' || key === 'events') {
        const ids = key === 'tt' ? [...adds, ...changes.map((c) => c.after)].map((r) => r.slotId) : [...adds, ...changes.map((c) => c.after)].flatMap((r) => r.slotIds);
        if (ids.length) {
          const [b] = await q(`SELECT label FROM slots WHERE id = ANY($1::text[]) AND is_break LIMIT 1`, [[...new Set(ids)]]);
          if (b) throw new HttpError(400, `${b.label} is a break. Nothing can be scheduled in it.`);
        }
      }
      if (key === 'tt') {
        for (const r of [...adds, ...changes.map((c) => c.after)]) {
          const [bad] = await q(
            `SELECT d.code, s.label FROM classes c JOIN departments d ON d.id = c.dept_id JOIN slots s ON s.id = $2
             WHERE c.id = $1 AND d.lunch_slots @> to_jsonb($2::text)`,
            [r.classId, r.slotId]
          );
          if (bad) throw new HttpError(400, `${bad.label} is the lunch break of ${bad.code}. Nothing can be scheduled in it.`);
        }
      }
      if (key === 'depts') {
        for (const d of [...adds, ...changes.map((c) => c.after)].filter((x) => x.lunchSlots.length)) {
          const [{ n }] = await q(`SELECT count(*)::int AS n FROM slots WHERE id = ANY($1::text[])`, [d.lunchSlots]);
          if (n !== d.lunchSlots.length) throw new HttpError(400, 'One of the lunch periods does not exist.');
          const [use] = await q(
            `SELECT count(*)::int AS n FROM timetable t JOIN classes c ON c.id = t.class_id WHERE c.dept_id = $1 AND t.slot_id = ANY($2::text[])`,
            [d.id, d.lunchSlots]
          );
          if (use.n) throw new HttpError(409, `${d.code} already has ${use.n} class${use.n === 1 ? '' : 'es'} in those periods. Remove them before using them for lunch.`);
        }
      }
      if (key === 'slots') {
        for (const s of [...adds, ...changes.map((c) => c.after)].filter((r) => r.isBreak)) {
          const [use] = await q(`SELECT (SELECT count(*) FROM timetable WHERE slot_id = $1)::int AS t, (SELECT count(*) FROM events WHERE slot_ids @> to_jsonb($1::text))::int AS e`, [s.id]);
          if (use && (use.t || use.e)) throw new HttpError(409, `${s.label} already has classes or events. Remove them before marking it as a break.`);
        }
      }

      // rules the database cannot express
      if (key === 'depts' && removes.length) {
        const [use] = await q(`SELECT count(*)::int AS n FROM users WHERE more_dept_ids ?| $1::text[]`, [removes.map((r) => r.id)]);
        if (use.n) throw new HttpError(409, 'A department head still manages this department. Remove it from their account first.');
      }
      if (key === 'users') {
        const extra = [...new Set([...adds, ...changes.map((c) => c.after)].flatMap((r) => r.moreDeptIds || []))];
        if (extra.length) {
          const [{ n }] = await q(`SELECT count(*)::int AS n FROM departments WHERE id = ANY($1::text[])`, [extra]);
          if (n !== extra.length) throw new HttpError(400, 'One of the extra departments does not exist.');
        }
        for (const a of adds) if (!a.pwHash) throw new HttpError(400, 'Set a password for each new user.');
        if (removes.some((u) => u.id === user.id)) throw new HttpError(409, 'You cannot delete the account you are signed in with.');
      }
      if (key === 'holidays') {
        const rows = [...adds, ...changes.map((c) => c.after)];
        for (const r of rows) {
          if (!r.slotFrom && !r.slotTo) continue;
          if (!r.slotFrom || !r.slotTo) throw new HttpError(400, 'Choose both the first and the last period, or leave both empty for the whole day.');
          if (r.kind === 'working') throw new HttpError(400, 'A working day always covers the whole day.');
          const order = await slotOrder(q);
          if (order[r.slotFrom] === undefined || order[r.slotTo] === undefined) throw new HttpError(400, 'One of the periods does not exist.');
          if (order[r.slotFrom] > order[r.slotTo]) throw new HttpError(400, 'The last period cannot be before the first period.');
        }
      }
      if (key === 'events') {
        const order = adds.length ? await slotOrder(q) : {};
        for (const ev of adds) {
          const hol = await q(
            `SELECT to_char(date_from,'YYYY-MM-DD') AS f, to_char(date_to,'YYYY-MM-DD') AS t, kind, class_id AS "classId", slot_from AS "slotFrom", slot_to AS "slotTo" FROM holidays WHERE date_from <= $1::date AND date_to >= $1::date`,
            [ev.date]
          );
          if (campusClosed(ev.date, hol)) {
            const dayName = new Date(ev.date + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
            throw new HttpError(409, `${dayName} ${ev.date} is an off day, so venues cannot be used. Ask the administrator to convert it to a working day first.`);
          }
          const jsDay = new Date(ev.date + 'T00:00:00Z').getUTCDay();
          for (const slotId of ev.slotIds) {
            if (jsDay >= 1) {
              const classes = await q(
                `SELECT t.title, t.class_id AS "classId" FROM timetable t WHERE t.res_id = $1 AND t.day = $2 AND t.slot_id = $3
                 AND NOT EXISTS (SELECT 1 FROM releases r WHERE r.tt_id = t.id AND r.date = $4)`,
                [ev.resId, jsDay - 1, slotId, ev.date]
              );
              // a class that is not running (off day for its section, or a part-day off day) does not hold the venue
              const live = classes.find((c) => classRuns(ev.date, slotId, hol.filter((h) => !h.classId || h.classId === c.classId), order));
              if (live) throw new HttpError(409, `The venue has a class (${live.title}) in one of those periods.`);
            }
            const [clash] = await q(
              `SELECT title FROM events WHERE res_id = $1 AND date = $2 AND status <> 'rejected' AND slot_ids @> to_jsonb($3::text)`,
              [ev.resId, ev.date, slotId]
            );
            if (clash) throw new HttpError(409, `The venue is already booked for "${clash.title}" in one of those periods.`);
          }
        }
      }

      // actual hours can be entered from the last working day of the week
      if (key === 'wplans') {
        const entered = [...adds, ...changes.filter((c) => c.before.actual !== c.after.actual).map((c) => c.after)].filter((r) => r.actual !== null && r.actual !== undefined);
        const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // India time
        for (const r of entered) {
          const end = addDays(r.weekStart, 6);
          const hol = await q(
            `SELECT to_char(date_from,'YYYY-MM-DD') AS f, to_char(date_to,'YYYY-MM-DD') AS t, kind, class_id AS "classId", slot_from AS "slotFrom", slot_to AS "slotTo" FROM holidays WHERE (class_id IS NULL OR class_id = $1) AND date_from <= $3::date AND date_to >= $2::date`,
            [r.classId, r.weekStart, end]
          );
          // a day on which every class of the section was released (a class change) is an off day too
          const tt = await q(`SELECT id, day FROM timetable WHERE class_id = $1`, [r.classId]);
          const rel = tt.length
            ? await q(`SELECT tt_id AS "ttId", to_char(date,'YYYY-MM-DD') AS date FROM releases WHERE tt_id = ANY($1::text[]) AND date BETWEEN $2::date AND $3::date`, [tt.map((t) => t.id), r.weekStart, end])
            : [];
          const rows = [...hol.filter((h) => !isPartDay(h)), ...releaseOffRows(r.classId, tt, rel)];
          const last = lastWorkingDay(r.weekStart, rows);
          if (last && today < last) throw new HttpError(400, `Actual hours can be entered from the last working day of the week (${last}).`);
        }
      }

      // a class moved to another weekday no longer matches its one-off releases
      if (key === 'tt') {
        const moved = changes.filter((c) => c.before.day !== c.after.day).map((c) => c.after.id);
        if (moved.length) await q(`DELETE FROM releases WHERE tt_id = ANY($1::text[])`, [moved]);
      }

      // apply
      if (removes.length) await q(`DELETE FROM ${def.table} WHERE id = ANY($1::text[])`, [removes.map((r) => r.id)]);
      const toWrite = [...adds, ...changes.map((c) => c.after)];
      if (toWrite.length) await q(upsertSql(def), [JSON.stringify(toWrite)]);
      if (key === 'users') {
        // a new password, role or department ends that person's other sign-ins
        const revoke = changes.filter((c) => c.after.pwHash || c.before.role !== c.after.role || (c.before.deptId ?? null) !== (c.after.deptId ?? null) || JSON.stringify(c.before.moreDeptIds || []) !== JSON.stringify(c.after.moreDeptIds || [])).map((c) => c.after.id);
        for (const id of revoke) {
          await q(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [id, id === user.id ? user.sid : '']);
        }
        const [{ n }] = await q(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND password_hash IS NOT NULL`);
        if (n < 1) throw new HttpError(409, 'Keep at least one administrator who can sign in.');
      }
      return { ok: true, added: adds.length, changed: changes.length, removed: removes.length };
    });
  }

  async function slotOrder(q) {
    const rows = await q('SELECT id FROM slots ORDER BY start_time');
    return Object.fromEntries(rows.map((r, i) => [r.id, i]));
  }

  function mapDbError(err) {
    if (err instanceof HttpError) return err;
    if (err?.code === '23505') {
      const c = err.constraint || '';
      if (c === 'timetable_venue_unique') return new HttpError(409, 'That venue already has a class in this period.');
      if (c === 'timetable_class_unique') return new HttpError(409, 'That year and section already has a class in this period.');
      if (c === 'timetable_faculty_unique') return new HttpError(409, 'That faculty member already teaches in this period.');
      if (c === 'load_types_name_unique') return new HttpError(409, 'A load type with that name already exists.');
      if (c === 'week_plans_unique') return new HttpError(409, 'That week already has a plan for this load type. Refresh and try again.');
      if (c === 'users_email_unique') return new HttpError(409, 'Another user already has that email address.');
      return new HttpError(409, 'That value already exists.');
    }
    if ((err?.code === '23503' || err?.code === '23001') && /holidays_slot/.test(err.constraint || '')) return new HttpError(409, 'That time slot is used by an off day. Change or delete the off day first.');
    if (err?.code === '23503' || err?.code === '23001') return new HttpError(409, 'This record is in use by other data, or refers to something that no longer exists.');
    if (err?.code === '23514') return new HttpError(400, 'A value is outside the allowed range.');
    return err;
  }

  return async function handle({ method, url, headers = {}, body }) {
    try {
      const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v]));
      const path = new URL(url, 'http://local').pathname.replace(/\/+$/, '') || '/';
      method = String(method || 'GET').toUpperCase();

      if (typeof body === 'string' && body.length) {
        try { body = JSON.parse(body); } catch { throw new HttpError(400, 'The request body is not valid JSON.'); }
      }

      if (method !== 'GET' && method !== 'HEAD' && h.origin) {
        const host = h['x-forwarded-host'] || h.host;
        let originHost = '';
        try { originHost = new URL(h.origin).host; } catch { /* ignore */ }
        if (!host || originHost !== host) throw new HttpError(403, 'Cross-site requests are not allowed.');
      }

      if (path === '/api/health') {
        return await withDb(async (db) => {
          await db.query('SELECT 1');
          return json(200, { ok: true });
        });
      }

      return await withDb(async (db) => {
        if (path === '/api/auth/login' && method === 'POST') return login(db, body, h);
        if (path === '/api/auth/logout' && method === 'POST') {
          const sess = await readSession(parseCookies(h.cookie)[COOKIE], secret());
          if (sess) await db.query(`DELETE FROM sessions WHERE id = $1`, [sess.sid]);
          return json(200, { ok: true }, { 'set-cookie': clearCookie({ secure }) });
        }

        const user = await currentUser(db, h);
        if (path === '/api/auth/logout-all' && method === 'POST') {
          if (!user) return json(401, { error: 'Please sign in.' });
          await db.query(`DELETE FROM sessions WHERE user_id = $1`, [user.id]);
          return json(200, { ok: true }, { 'set-cookie': clearCookie({ secure }) });
        }
        if (path === '/api/auth/me' && method === 'GET') {
          return user ? json(200, { user: publicUser(user) }) : json(401, { error: 'Not signed in.' });
        }
        if (!user) return json(401, { error: 'Please sign in.' });

        if (path === '/api/data' && method === 'GET') return json(200, { user: publicUser(user), data: await readAll(db, user) });

        const m = path.match(/^\/api\/data\/([a-z]+)$/);
        if (m && method === 'PUT') return json(200, await write(db, user, m[1], body));

        return json(404, { error: 'Not found.' });
      });
    } catch (raw) {
      const err = mapDbError(raw);
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(raw);
      return json(500, { error: 'Something went wrong on the server.' });
    }
  };
}
