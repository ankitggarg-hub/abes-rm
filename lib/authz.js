// Who may change what. Pure functions so they are easy to test.
//
// `change` describes a request after it has been compared with the database:
//   adds     rows that did not exist
//   changes  [{ before, after }] rows that exist and differ
//   removes  existing rows that will be deleted
// `ctx.venueDept(id)` and `ctx.classDept(id)` return the owning department id.

/** The departments a department head manages: the main one plus any extra ones. */
export const deptsOf = (u) => (u.deptId ? [u.deptId, ...(u.moreDeptIds || [])] : []);

export function authorize(user, key, change, ctx) {
  const { adds, changes, removes } = change;
  const mine = deptsOf(user);
  if (adds.length + changes.length + removes.length === 0) return null;
  const deny = (m) => m;

  if (user.role === 'admin') return null;

  if (key === 'vreqs') {
    if (user.role !== 'hod') return deny('Only department heads can request a venue.');
    if (!mine.length) return deny('Your account is not linked to a department.');
    if (removes.length) return deny('Requests cannot be deleted. Cancel a pending request instead.');
    for (const r of adds) {
      if (r.ownerDeptId && mine.includes(r.ownerDeptId)) return deny('That venue belongs to your own department. Use Lend a venue instead.');
      if (!mine.includes(r.fromDeptId)) return deny('Choose one of your own departments to request for.');
    }
    for (const { before, after } of changes) {
      if (after.status === 'cancelled') {
        if (before.requestedById !== user.id) return deny('Only the person who asked can cancel a request.');
      } else if (!before.ownerDeptId || !mine.includes(before.ownerDeptId)) {
        return deny('Only the head of the department that owns the venue (or the administrator for central venues) can approve or reject this request.');
      }
    }
    return null;
  }

  if (user.role === 'hod' && key === 'releases') {
    if (!user.deptId) return deny('Your account is not linked to a department.');
    for (const r of [...adds, ...removes, ...changes.map((c) => c.after)]) {
      if (!mine.includes(ctx.venueDept(r.resId)) || !mine.includes(ctx.classDept(r.classId))) {
        return deny('You can only release classes of your own department.');
      }
    }
    return null;
  }

  if (user.role === 'hod' && key === 'depts') {
    // a department head may only set the lunch periods of their own department
    if (adds.length || removes.length) return deny('Only administrators can add or remove departments.');
    for (const { before, after } of changes) {
      if (!mine.includes(before.id)) return deny('You can only change the lunch break of your own department.');
      if (before.name !== after.name || before.code !== after.code || before.h !== after.h) return deny('Only administrators can rename a department.');
    }
    return null;
  }

  if (user.role === 'hod' && (key === 'holidays' || key === 'wplans')) {
    // department heads plan hours and mark off days for the year/sections of their own departments
    if (!mine.length) return deny('Your account is not linked to a department.');
    const rows = [...adds, ...removes, ...changes.map((c) => c.before), ...changes.map((c) => c.after)];
    for (const r of rows) {
      if (!r.classId) return deny(key === 'holidays' ? 'Only administrators can mark an off day for the whole campus.' : 'Choose a year and section.');
      if (!mine.includes(ctx.classDept(r.classId))) return deny('That year and section does not belong to your department.');
    }
    return null;
  }

  if (user.role === 'hod' && key === 'events') {
    // lending: a department head books their own department's venues for someone else
    if (!user.deptId) return deny('Your account is not linked to a department.');
    if (changes.length) return deny('A lent booking cannot be edited. Cancel it and lend the venue again.');
    for (const r of adds) {
      if (!mine.includes(ctx.venueDept(r.resId))) return deny('You can only lend venues allocated to your department.');
      if (r.lentDeptId !== ctx.venueDept(r.resId) || r.lentBy !== user.name) return deny('A lent booking must be made in your own name and for the department that owns the venue.');
      if (r.status !== 'confirmed') return deny('A lent booking is confirmed straight away.');
      if (r.forDeptId && mine.includes(r.forDeptId)) return deny('Choose a different department to lend to.');
    }
    for (const r of removes) {
      if (!mine.includes(r.lentDeptId)) return deny('You can only cancel bookings that your department has lent out.');
    }
    return null;
  }

  if (user.role === 'hod') {
    if (key !== 'tt') return deny('Department heads can only change their own timetable.');
    if (!user.deptId) return deny('Your account is not linked to a department.');
    const ownVenue = (id) => mine.includes(ctx.venueDept(id));
    const ownClass = (id) => mine.includes(ctx.classDept(id));
    for (const r of [...adds, ...removes, ...changes.map((c) => c.before), ...changes.map((c) => c.after)]) {
      if (!ownVenue(r.resId)) return deny('That venue is not allocated to your department.');
      if (!ownClass(r.classId)) return deny('That year and section does not belong to your department.');
    }
    return null;
  }

  if (user.role === 'head') {
    if (key === 'events' && adds.some((r) => r.lentDeptId || r.forDeptId || r.lentBy)) return deny('Only department heads can lend a department venue.');
    return key === 'events' || key === 'releases' ? null : deny('Only administrators can change this data.');
  }

  if (user.role === 'stakeholder') {
    if (key !== 'events') return deny('Only administrators can change this data.');
    if (changes.length) return deny('Only the head of institute can approve or change a request.');
    for (const r of adds) {
      if (r.status !== 'pending') return deny('New requests wait for approval by the head of institute.');
      if (r.by !== user.name) return deny('A request must be made in your own name.');
      if (r.lentDeptId || r.forDeptId || r.lentBy) return deny('Only department heads can lend a department venue.');
    }
    for (const r of removes) {
      if (r.by !== user.name) return deny('You can only cancel your own requests.');
    }
    return null;
  }

  return deny('Your role cannot change this data.');
}
