// Which days are working days for a year and section.
// Saturday and Sunday are off unless converted to a working day. A department head's entry for one
// section beats a campus-wide entry, and a "working" entry beats an "off" entry at the same level.
//
// `rows` are off-day / working-day entries already limited to the campus (classId null) and the
// section being asked about: { f: 'YYYY-MM-DD', t: 'YYYY-MM-DD', kind: 'off' | 'working', classId }.
export function dayState(date, rows) {
  const cover = rows.filter((r) => r.f <= date && date <= r.t);
  for (const sectionLevel of [true, false]) {
    const level = cover.filter((r) => Boolean(r.classId) === sectionLevel);
    if (level.some((r) => r.kind === 'working')) return 'working';
    if (level.some((r) => r.kind !== 'working')) return 'off';
  }
  const wd = new Date(date + 'T00:00:00Z').getUTCDay();
  return wd === 0 || wd === 6 ? 'off' : 'working';
}

export const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/** Last working day of the week that starts on `weekStart` (Monday to Sunday), or null. */
export function lastWorkingDay(weekStart, rows) {
  for (let i = 6; i >= 0; i--) {
    const d = addDays(weekStart, i);
    if (dayState(d, rows) === 'working') return d;
  }
  return null;
}

/** Entries that cover `date` and have a period range are "part-day"; the rest decide whether the day is on or off. */
export const isPartDay = (r) => Boolean(r.slotFrom && r.slotTo);

/**
 * Does a timetable class run on `date`?  `rows` are holiday entries for the campus and the class
 * (f, t, kind, classId, slotFrom, slotTo); `order` maps slot id to its position in the day.
 * A day that is off (weekend unless converted, or a holiday) holds no classes; a part-day off day
 * stops only the classes in its periods.
 */
export function classRuns(date, slotId, rows, order) {
  if (dayState(date, rows.filter((r) => !isPartDay(r))) === 'off') return false;
  const at = order[slotId];
  return !rows.some(
    (r) => isPartDay(r) && r.kind !== 'working' && r.f <= date && date <= r.t && at >= order[r.slotFrom] && at <= order[r.slotTo]
  );
}

/** Saturdays and Sundays are closed for venue use until an administrator converts them to a working day. */
export function campusClosed(date, rows) {
  const wd = new Date(date + 'T00:00:00Z').getUTCDay();
  if (wd !== 0 && wd !== 6) return false;
  return !rows.some((r) => !r.classId && r.kind === 'working' && !isPartDay(r) && r.f <= date && date <= r.t);
}

/** Dates on which every class a section has that weekday was released (an off day for the tracker). */
export function releaseOffRows(classId, ttRows, relRows) {
  const byTt = new Map(ttRows.map((t) => [t.id, t.day]));
  const perDay = [0, 1, 2, 3, 4, 5].map((d) => ttRows.filter((t) => t.day === d).length);
  const seen = new Map();
  for (const r of relRows) {
    if (!byTt.has(r.ttId)) continue;
    seen.set(r.date, (seen.get(r.date) || new Set()).add(r.ttId));
  }
  const out = [];
  for (const [date, ids] of seen) {
    const jsDay = new Date(date + 'T00:00:00Z').getUTCDay();
    if (jsDay >= 1 && perDay[jsDay - 1] > 0 && ids.size >= perDay[jsDay - 1]) out.push({ f: date, t: date, kind: 'off', classId });
  }
  return out;
}
