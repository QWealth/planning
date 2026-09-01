/**
 * The cases that matter are the ones where two lists LOOK different and are not.
 *
 * A wrong answer here is not a visible bug - the save still works. It shows up later
 * as an audit trail claiming people changed their role on days they only opened the
 * form, which is exactly the kind of wrong data nobody thinks to distrust.
 */

import { describe, expect, it } from 'vitest';

import { sameRoles } from './roles';

describe('sameRoles', () => {
  it('is true for the same roles in a different order', () => {
    // The real case: the form yields catalogue order, the API returns stored order.
    expect(sameRoles(['ux', 'ba'], ['ba', 'ux'])).toBe(true);
  });

  it('is true for two empty lists', () => {
    // Legacy rows have none. Opening one and saving a name change must not send roles.
    expect(sameRoles([], [])).toBe(true);
  });

  it('is false when a role is added', () => {
    expect(sameRoles(['ba', 'ux'], ['ba'])).toBe(false);
  });

  it('is false when a role is removed', () => {
    expect(sameRoles(['ba'], ['ba', 'ux'])).toBe(false);
  });

  it('is false when one role is swapped for another', () => {
    // Same length, so this is the case a length check alone would get wrong.
    expect(sameRoles(['ba'], ['ux'])).toBe(false);
  });

  it('is false when the first role is filled in on a legacy row', () => {
    expect(sameRoles(['qa'], [])).toBe(false);
  });

  it('does not mutate either argument', () => {
    // It sorts to compare. Sorting in place would reorder the array about to be sent,
    // and worse, the one held in component state.
    const a = ['ux', 'ba'];
    const b = ['qa', 'data'];
    sameRoles(a, b);
    expect(a).toEqual(['ux', 'ba']);
    expect(b).toEqual(['qa', 'data']);
  });

  it('compares values, not identity', () => {
    const shared = ['ba', 'ux'];
    expect(sameRoles(shared, [...shared])).toBe(true);
  });
});
