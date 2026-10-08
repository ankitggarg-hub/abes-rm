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
    return key === 'events' || key === 'releases' ? null : deny('Only administrators can change this data.');
  }

  if (user.role === 'stakeholder') {
    if (key !== 'events') return deny('Only administrators can change this data.');
    if (changes.length) return deny('Only the head of institute can approve or change a request.');
    for (const r of adds) {
      if (r.status !== 'pending') return deny('New requests wait for approval by the head of institute.');
      if (r.by !== user.name) return deny('A request must be made in your own name.');
    }
    for (const r of removes) {
      if (r.by !== user.name) return deny('You can only cancel your own requests.');
    }
    return null;
  }

  return deny('Your role cannot change this data.');
}
