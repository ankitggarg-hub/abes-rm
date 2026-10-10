// Single source of truth for the data model.
// Each client key maps to a Postgres table; every column is declared once so the
// API can validate input, build SQL and map snake_case columns to camelCase keys.

const col = (key, column, type, opts = {}) => ({ key, col: column, type, ...opts });

export const ROLES = ['admin', 'hod', 'head', 'stakeholder'];
export const VENUE_TYPES = ['Lecture theatre', 'Computer lab', 'Seminar hall', 'Auditorium'];
export const RELEASE_REASONS = ['Industrial visit', 'Placement activity', 'Seminar or workshop', 'Exam or test', 'Holiday', 'Faculty on leave', 'Other'];
export const EVENT_STATUS = ['pending', 'confirmed', 'rejected'];

const id = col('id', 'id', 'text', { id: true });

export const TABLES = {
  depts: {
    table: 'departments',
    order: 'code',
    cols: [id, col('name', 'name', 'text', { max: 120 }), col('code', 'code', 'text', { max: 12 }), col('h', 'h', 'int', { min: 0, max: 360 }),
      // periods this department uses for lunch (each department can differ)
      col('lunchSlots', 'lunch_slots', 'jsonb', { list: true, optional: true, default: [], sorted: true })],
  },
  classes: {
    table: 'classes',
    order: 'dept_id, year, section',
    cols: [
      id,
      col('deptId', 'dept_id', 'text', { ref: true }),
      col('year', 'year', 'int', { min: 1, max: 8 }),
      col('section', 'section', 'text', { max: 8 }),
      col('strength', 'strength', 'int', { min: 0, max: 5000, optional: true, default: 0 }),
    ],
  },
  slots: {
    table: 'slots',
    order: 'start_time',
    cols: [
      id,
      col('label', 'label', 'text', { max: 20 }),
      col('start', 'start_time', 'text', { pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }),
      col('end', 'end_time', 'text', { pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }),
      // a break (lunch): no classes or events can be placed in it
      col('isBreak', 'is_break', 'bool', { optional: true, default: false }),
    ],
  },
  buildings: {
    table: 'buildings',
    order: 'name',
    cols: [id, col('name', 'name', 'text', { max: 120 })],
  },
  floors: {
    table: 'floors',
    order: 'level',
    cols: [id, col('name', 'name', 'text', { max: 60 }), col('level', 'level', 'int', { min: -5, max: 100 })],
  },
  resources: {
    table: 'venues',
    order: 'name',
    cols: [
      id,
      col('name', 'name', 'text', { max: 120 }),
      col('type', 'type', 'text', { enum: VENUE_TYPES }),
      col('buildingId', 'building_id', 'text', { ref: true }),
      col('floorId', 'floor_id', 'text', { ref: true }),
      col('capacity', 'capacity', 'int', { min: 1, max: 100000 }),
      col('equipment', 'equipment', 'text', { max: 300, optional: true, default: '' }),
      col('deptId', 'dept_id', 'text', { ref: true, nullable: true }),
    ],
  },
  users: {
    table: 'users',
    order: 'name',
    cols: [
      id,
      col('name', 'name', 'text', { max: 120 }),
      col('email', 'email', 'text', { max: 200, email: true, optional: true, default: '' }),
      col('role', 'role', 'text', { enum: ROLES }),
      col('deptId', 'dept_id', 'text', { ref: true, nullable: true }),
    ],
    // never sent to the browser; written only from a validated password
    secret: col('pwHash', 'password_hash', 'text', { keep: true }),
  },
  tt: {
    table: 'timetable',
    order: 'day, slot_id',
    cols: [
      id,
      col('resId', 'res_id', 'text', { ref: true }),
      col('day', 'day', 'int', { min: 0, max: 5 }),
      col('slotId', 'slot_id', 'text', { ref: true }),
      col('title', 'title', 'text', { max: 160 }),
      col('faculty', 'faculty', 'text', { max: 120, optional: true, default: '' }),
      col('classId', 'class_id', 'text', { ref: true }),
    ],
  },
  // A scheduled class that does NOT happen in its venue on one date (visit, placement drive...).
  // While a release exists the venue shows as free for that date and period.
  releases: {
    table: 'releases',
    order: 'date',
    cols: [
      id,
      col('ttId', 'tt_id', 'text', { ref: true }),
      col('date', 'date', 'date'),
      col('reason', 'reason', 'text', { enum: RELEASE_REASONS }),
      col('note', 'note', 'text', { max: 300, optional: true, default: '' }),
      col('by', 'by_name', 'text', { max: 160 }),
    ],
  },
  events: {
    table: 'events',
    order: 'date',
    cols: [
      id,
      col('resId', 'res_id', 'text', { ref: true }),
      col('date', 'date', 'date'),
      col('slotIds', 'slot_ids', 'jsonb', { list: true }),
      col('title', 'title', 'text', { max: 200 }),
      col('by', 'by_name', 'text', { max: 160 }),
      col('attendees', 'attendees', 'int', { min: 0, max: 100000, optional: true, default: 0 }),
      col('notes', 'notes', 'text', { max: 500, optional: true, default: '' }),
      col('status', 'status', 'text', { enum: EVENT_STATUS }),
    ],
  },
};

export const TABLE_KEYS = Object.keys(TABLES);
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;

const pgType = (c) => (c.type === 'bool' ? 'boolean' : c.type === 'int' ? 'int' : c.type === 'date' ? 'date' : c.type === 'jsonb' ? 'jsonb' : 'text');

/** SELECT list that returns camelCase keys and plain JSON-friendly values. */
export function selectList(def) {
  return def.cols
    .map((c) => {
      const expr = c.type === 'date' ? `to_char(${c.col}, 'YYYY-MM-DD')` : c.col;
      return `${expr} AS "${c.key}"`;
    })
    .join(', ');
}

/** INSERT ... ON CONFLICT statement fed by one jsonb array parameter ($1). */
export function upsertSql(def) {
  const cols = def.secret ? [...def.cols, def.secret] : def.cols;
  const insertCols = cols.map((c) => c.col).join(', ');
  const recordset = cols.map((c) => `"${c.key}" ${pgType(c)}`).join(', ');
  const select = cols.map((c) => `x."${c.key}"`).join(', ');
  const update = cols
    .filter((c) => !c.id)
    .map((c) => (c.keep ? `${c.col} = COALESCE(EXCLUDED.${c.col}, ${def.table}.${c.col})` : `${c.col} = EXCLUDED.${c.col}`))
    .join(', ');
  return `INSERT INTO ${def.table} (${insertCols}) SELECT ${select} FROM jsonb_to_recordset($1::jsonb) AS x(${recordset}) ON CONFLICT (id) DO UPDATE SET ${update}`;
}

/** Validate and normalise one incoming row. Returns { row } or { error }. */
export function validateRow(def, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Each row must be an object.' };
  const row = {};
  for (const c of def.cols) {
    let v = input[c.key];
    if (v === undefined || v === null || v === '') {
      if (c.nullable) { row[c.key] = null; continue; }
      if (c.optional) { row[c.key] = c.default; continue; }
      return { error: `"${c.key}" is required.` };
    }
    if (c.type === 'bool') {
      if (typeof v !== 'boolean') return { error: `"${c.key}" must be true or false.` };
      row[c.key] = v;
    } else if (c.type === 'int') {
      const n = typeof v === 'number' ? v : Number(String(v).trim());
      if (!Number.isInteger(n)) return { error: `"${c.key}" must be a whole number.` };
      if (c.min !== undefined && n < c.min) return { error: `"${c.key}" must be at least ${c.min}.` };
      if (c.max !== undefined && n > c.max) return { error: `"${c.key}" must be at most ${c.max}.` };
      row[c.key] = n;
    } else if (c.type === 'date') {
      const s = String(v).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) return { error: `"${c.key}" must be a date like 2026-10-07.` };
      row[c.key] = s;
    } else if (c.type === 'jsonb') {
      if (!Array.isArray(v) || (v.length < 1 && !c.optional) || v.length > 16 || !v.every((x) => typeof x === 'string' && ID_PATTERN.test(x))) {
        return { error: `"${c.key}" must list one or more period ids.` };
      }
      row[c.key] = c.sorted ? [...new Set(v)].sort() : v;
    } else {
      if (typeof v !== 'string' && typeof v !== 'number') return { error: `"${c.key}" must be text.` };
      let s = String(v).trim();
      if (c.id && !ID_PATTERN.test(s)) return { error: 'Invalid id.' };
      if (c.ref && !ID_PATTERN.test(s)) return { error: `"${c.key}" is not a valid reference.` };
      if (c.max && s.length > c.max) return { error: `"${c.key}" is too long (max ${c.max}).` };
      if (c.pattern && !c.pattern.test(s)) return { error: `"${c.key}" has the wrong format.` };
      if (c.enum && !c.enum.includes(s)) return { error: `"${c.key}" must be one of: ${c.enum.join(', ')}.` };
      if (c.email) {
        s = s.toLowerCase();
        if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { error: 'Enter a valid email address.' };
      }
      row[c.key] = s;
    }
  }
  if (def.table === 'slots' && row.end <= row.start) return { error: 'A period must end after it starts.' };
  return { row };
}

/** Stable string for comparing two normalised rows. */
export const fingerprint = (def, row) => JSON.stringify(def.cols.map((c) => row[c.key] ?? null));
