// The whole API, independent of Vercel or Netlify.
// handle({ method, url, headers, body }) -> { status, headers, body }

import { TABLES, TABLE_KEYS, selectList, upsertSql, validateRow, fingerprint } from './schema.js';
import { authorize } from './authz.js';
import { COOKIE, DUMMY_HASH, checkPassword, clearCookie, hashPassword, parseCookies, readSession, sessionCookie, signSession } from './auth.js';

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

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, deptId: u.deptId ?? null });

export function createHandler({ withDb, env = process.env }) {
  const secure = env.COOKIE_SECURE ? env.COOKIE_SECURE !== 'false' : Boolean(env.VERCEL || env.NETLIFY || env.NODE_ENV === 'production');

  function secret() {
    const s = env.SESSION_SECRET;
    if (!s || s.length < 32) throw new HttpError(500, 'The server is missing SESSION_SECRET (at least 32 characters).');
    return s;
  }

  async function currentUser(db, headers) {
    const token = parseCookies(headers.cookie)[COOKIE];
    const id = await readSession(token, secret());
    if (!id) return null;
    const rows = await db.query(
      `SELECT id, name, email, role, dept_id AS "deptId" FROM users WHERE id = $1 AND password_hash IS NOT NULL`,
      [id]
    );
    return rows[0] || null;
  }

  async function login(db, body) {
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    if (!email || !password) throw new HttpError(400, 'Enter your email and password.');

    const [att] = await db.query(`SELECT attempts, locked_until FROM login_attempts WHERE email = $1`, [email]);
    if (att?.locked_until && new Date(att.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(att.locked_until) - new Date()) / 60000);
      throw new HttpError(429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    const [user] = await db.query(
      `SELECT id, name, email, role, dept_id AS "deptId", password_hash AS hash FROM users WHERE lower(email) = $1`,
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
    const token = await signSession(user.id, secret());
    return json(200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(token, { secure }) });
  }

  async function readAll(db, user) {
    const data = {};
    await Promise.all(
      TABLE_KEYS.map(async (key) => {
        const def = TABLES[key];
        if (key === 'users' && user.role !== 'admin') {
          data.users = [publicUser(user)];
          return;
        }
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
        if (row.role !== 'hod') row.deptId = null;
      }
      if (key === 'releases') row.by = user.name;
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

      // rules the database cannot express
      if (key === 'users') {
        for (const a of adds) if (!a.pwHash) throw new HttpError(400, 'Set a password for each new user.');
        if (removes.some((u) => u.id === user.id)) throw new HttpError(409, 'You cannot delete the account you are signed in with.');
      }
      if (key === 'events') {
        for (const ev of adds) {
          const jsDay = new Date(ev.date + 'T00:00:00Z').getUTCDay();
          for (const slotId of ev.slotIds) {
            if (jsDay >= 1) {
              const [cls] = await q(
                `SELECT t.title FROM timetable t WHERE t.res_id = $1 AND t.day = $2 AND t.slot_id = $3
                 AND NOT EXISTS (SELECT 1 FROM releases r WHERE r.tt_id = t.id AND r.date = $4)`,
                [ev.resId, jsDay - 1, slotId, ev.date]
              );
              if (cls) throw new HttpError(409, `The venue has a class (${cls.title}) in one of those periods.`);
            }
            const [clash] = await q(
              `SELECT title FROM events WHERE res_id = $1 AND date = $2 AND status <> 'rejected' AND slot_ids @> to_jsonb($3::text)`,
              [ev.resId, ev.date, slotId]
            );
            if (clash) throw new HttpError(409, `The venue is already booked for "${clash.title}" in one of those periods.`);
          }
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
        const [{ n }] = await q(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND password_hash IS NOT NULL`);
        if (n < 1) throw new HttpError(409, 'Keep at least one administrator who can sign in.');
      }
      return { ok: true, added: adds.length, changed: changes.length, removed: removes.length };
    });
  }

  function mapDbError(err) {
    if (err instanceof HttpError) return err;
    if (err?.code === '23505') {
      const c = err.constraint || '';
      if (c === 'timetable_venue_unique') return new HttpError(409, 'That venue already has a class in this period.');
      if (c === 'timetable_class_unique') return new HttpError(409, 'That year and section already has a class in this period.');
      if (c === 'timetable_faculty_unique') return new HttpError(409, 'That faculty member already teaches in this period.');
      if (c === 'users_email_unique') return new HttpError(409, 'Another user already has that email address.');
      return new HttpError(409, 'That value already exists.');
    }
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
        return withDb(async (db) => {
          await db.query('SELECT 1');
          return json(200, { ok: true });
        });
      }

      return await withDb(async (db) => {
        if (path === '/api/auth/login' && method === 'POST') return login(db, body);
        if (path === '/api/auth/logout' && method === 'POST') return json(200, { ok: true }, { 'set-cookie': clearCookie({ secure }) });

        const user = await currentUser(db, h);
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
