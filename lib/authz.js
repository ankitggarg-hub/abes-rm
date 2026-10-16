// Who may change what. Pure functions so they are easy to test.
//
// `change` describes a request after it has been compared with the database:
//   adds     rows that did not exist
//   changes  [{ before, after }] rows that exist and differ
//   removes  existing rows that will be deleted
// `ctx.venueDept(id)` and `ctx.classDept(id)` return the owning department id.

export function authorize(user, key, change, ctx) {
  const { adds, changes, removes } = change;
  if (adds.length + changes.length + removes.length === 0) return null;
  const deny = (m) => m;

  if (user.role === 'admin') return null;

  if (user.role === 'hod' && key === 'releases') {
    if (!user.deptId) return deny('Your account is not linked to a department.');
    for (const r of [...adds, ...removes, ...changes.map((c) => c.after)]) {
      if (ctx.venueDept(r.resId) !== user.deptId || ctx.classDept(r.classId) !== user.deptId) {
        return deny('You can only release classes of your own department.');
      }
    }
    return null;
  }

  if (user.role === 'hod' && key === 'depts') {
    // a department head may only set the lunch periods of their own department
    if (adds.length || removes.length) return deny('Only administrators can add or remove departments.');
    for (const { before, after } of changes) {
      if (before.id !== user.deptId) return deny('You can only change the lunch break of your own department.');
      if (before.name !== after.name || before.code !== after.code || before.h !== after.h) return deny('Only administrators can rename a department.');
    }
    return null;
  }

  if (user.role === 'hod' && key === 'events') {
    // lending: a department head books their own department's venues for someone else
    if (!user.deptId) return deny('Your account is not linked to a department.');
    if (changes.length) return deny('A lent booking cannot be edited. Cancel it and lend the venue again.');
    for (const r of adds) {
      if (ctx.venueDept(r.resId) !== user.deptId) return deny('You can only lend venues allocated to your department.');
      if (r.lentDeptId !== user.deptId || r.lentBy !== user.name) return deny('A lent booking must be made in your own name and department.');
      if (r.status !== 'confirmed') return deny('A lent booking is confirmed straight away.');
      if (r.forDeptId && r.forDeptId === user.deptId) return deny('Choose a different department to lend to.');
    }
    for (const r of removes) {
      if (r.lentDeptId !== user.deptId) return deny('You can only cancel bookings that your department has lent out.');
    }
    return null;
  }

  if (user.role === 'hod') {
    if (key !== 'tt') return deny('Department heads can only change their own timetable.');
    if (!user.deptId) return deny('Your account is not linked to a department.');
    const ownVenue = (id) => ctx.venueDept(id) === user.deptId;
    const ownClass = (id) => ctx.classDept(id) === user.deptId;
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
