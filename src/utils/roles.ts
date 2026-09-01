/**
 * Comparing role lists.
 *
 * A one-function module, and it is here rather than beside its only caller in
 * components/PersonEditor.tsx for one reason: anything importing that component pulls
 * in services/api.ts, which initialises Amplify at import time, which cannot run under
 * the node-environment test setup. `sameSpecialisations` lives there and is therefore
 * untested. This one makes a claim subtle enough to be worth proving instead.
 */

/**
 * True when the two lists hold the same roles, whatever order they arrived in.
 *
 * ORDER-INSENSITIVE ON PURPOSE, and this is the whole reason the function exists.
 *
 * It decides whether a PATCH sends `roles` at all. React Hook Form yields checkbox
 * values in DOM order - catalogue order - while the API returns them in the order they
 * happened to be stored, which is the order they were first ticked. So ["ux","ba"] and
 * ["ba","ux"] describe the same person and routinely arrive as different arrays.
 *
 * Compared as sequences, every open-and-save of an unmodified form would look like a
 * change: a needless write, and an audit entry asserting somebody changed their role
 * when all they did was look at it. The audit log is the record of who changed what,
 * so filling it with edits nobody made is worse than a wasted round trip.
 *
 * Duplicates are not a concern here - the API refuses a repeated role - so length plus
 * sorted contents is a sound identity test.
 */
export function sameRoles(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const key = (list: string[]) => [...list].sort().join('|');
  return key(a) === key(b);
}
