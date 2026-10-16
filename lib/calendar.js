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
