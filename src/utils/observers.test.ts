import { describe, expect, it } from 'vitest';

import type { PersonWorkload } from '../types';
import {
  holdsNothing,
  isLeadershipOnly,
  isObserver,
  schedulable,
  splitObservers,
} from './observers';

function person(overrides: Partial<PersonWorkload> = {}): PersonWorkload {
  return {
    email: 'a@example.invalid',
    name: 'A',
    roles: ['outside-engineering'],
    active: true,
    specialisations: [],
    digest_enabled: false,
    digest_days: 14,
    digest_admin_report: false,
    rfcs_read: {},
    created_at: null,
    updated_at: null,
    dri_project_ids: [],
    support_project_ids: [],
    owned_phase_count: 0,
    ...overrides,
  };
}

describe('holdsNothing', () => {
  it('is true only when all three counts are empty', () => {
    expect(holdsNothing(person())).toBe(true);
  });

  it('counts a DRI lane', () => {
    expect(holdsNothing(person({ dri_project_ids: ['p1'] }))).toBe(false);
  });

  it('counts a Support lane', () => {
    expect(holdsNothing(person({ support_project_ids: ['p1'] }))).toBe(false);
  });

  it('counts owned phases, which include Maintenance bands', () => {
    // Carrying ongoing support is real load - see the note on owned_phase_count.
    expect(holdsNothing(person({ owned_phase_count: 1 }))).toBe(false);
  });
});

describe('isObserver', () => {
  it('is true for sole-role outside-engineering holding nothing', () => {
    expect(isObserver(person())).toBe(true);
  });

  it('is false when they also claim a delivery role', () => {
    // The picker is additive; the narrower claim wins.
    expect(isObserver(person({ roles: ['outside-engineering', 'ba'] }))).toBe(false);
    expect(isObserver(person({ roles: ['ba', 'outside-engineering'] }))).toBe(false);
  });

  it('is false for any other single role', () => {
    expect(isObserver(person({ roles: ['ba'] }))).toBe(false);
  });

  it('is false when they have no roles at all', () => {
    // Empty roles is the workbook-seeded "nobody recorded this". Reclassifying those
    // people would turn missing data into a claim about them.
    expect(isObserver(person({ roles: [] }))).toBe(false);
  });

  it('THE SAFETY RULE: work beats the role, every time', () => {
    // An observer who is actually DRI of something stays on the roster and therefore
    // on the chart. Hiding them would make a genuinely owned lane look unowned, which
    // is the one outcome this feature must never produce.
    expect(isObserver(person({ dri_project_ids: ['p1'] }))).toBe(false);
    expect(isObserver(person({ support_project_ids: ['p1'] }))).toBe(false);
    expect(isObserver(person({ owned_phase_count: 2 }))).toBe(false);
  });

  it('applies to deactivated people the same way', () => {
    // Deactivation is drawn by greying the row, not by moving it; the two states are
    // independent and must not be conflated.
    expect(isObserver(person({ active: false }))).toBe(true);
  });
});

describe('splitObservers', () => {
  it('separates the two groups', () => {
    const eng = person({ email: 'eng@example.invalid', roles: ['software-engineer'] });
    const obs = person({ email: 'obs@example.invalid' });
    const split = splitObservers([eng, obs]);
    expect(split.roster.map((p) => p.email)).toEqual(['eng@example.invalid']);
    expect(split.observers.map((p) => p.email)).toEqual(['obs@example.invalid']);
  });

  it('preserves the incoming order within each half', () => {
    // The caller has already sorted. Re-sorting here would silently override it.
    const people = [
      person({ email: 'b@x.invalid', roles: ['ba'] }),
      person({ email: 'obs1@x.invalid' }),
      person({ email: 'a@x.invalid', roles: ['qa'] }),
      person({ email: 'obs2@x.invalid' }),
    ];
    const split = splitObservers(people);
    expect(split.roster.map((p) => p.email)).toEqual(['b@x.invalid', 'a@x.invalid']);
    expect(split.observers.map((p) => p.email)).toEqual(['obs1@x.invalid', 'obs2@x.invalid']);
  });

  it('handles the everyday case of no observers at all', () => {
    const people = [person({ roles: ['ba'] }), person({ roles: ['qa'] })];
    const split = splitObservers(people);
    expect(split.roster).toHaveLength(2);
    expect(split.observers).toEqual([]);
  });

  it('never loses or duplicates anybody', () => {
    const people = [
      person({ email: '1@x.invalid', roles: ['ba'] }),
      person({ email: '2@x.invalid' }),
      person({ email: '3@x.invalid', roles: ['outside-engineering'], owned_phase_count: 1 }),
      person({ email: '4@x.invalid', roles: [] }),
    ];
    const split = splitObservers(people);
    expect(split.roster.length + split.observers.length).toBe(people.length);
    const seen = [...split.roster, ...split.observers].map((p) => p.email).sort();
    expect(seen).toEqual(['1@x.invalid', '2@x.invalid', '3@x.invalid', '4@x.invalid']);
  });
});

describe('isLeadershipOnly', () => {
  it('is true for somebody whose only role is leadership and who holds nothing', () => {
    expect(isLeadershipOnly(person({ roles: ['leadership'] }))).toBe(true);
  });

  it('is false once they hold anything', () => {
    // The safety condition, and the one that matters: a leader who is DRI of a lane
    // stays on the schedule, or the chart goes quiet about real accountability.
    expect(
      isLeadershipOnly(person({ roles: ['leadership'], dri_project_ids: ['p1'] }))
    ).toBe(false);
    expect(
      isLeadershipOnly(person({ roles: ['leadership'], support_project_ids: ['p1'] }))
    ).toBe(false);
    expect(
      isLeadershipOnly(person({ roles: ['leadership'], owned_phase_count: 1 }))
    ).toBe(false);
  });

  it('is false when leadership is one role among several', () => {
    // A lead who also builds is somebody you can staff work to. The narrower claim
    // wins, same as it does for observers.
    expect(isLeadershipOnly(person({ roles: ['leadership', 'software-engineer'] }))).toBe(
      false
    );
  });

  it('is false for nobody-recorded-this', () => {
    // An empty roles list is the workbook-seeded state, not a claim about the person.
    expect(isLeadershipOnly(person({ roles: [] }))).toBe(false);
  });

  it('does not make somebody an observer', () => {
    // Leadership is a delivery role. It changes the schedule, never the roster split.
    const lead = person({ roles: ['leadership'] });
    expect(isObserver(lead)).toBe(false);
    expect(splitObservers([lead]).roster).toHaveLength(1);
  });
});

describe('schedulable', () => {
  it('includes somebody holding nothing', () => {
    // The point of the change: free weeks are the answer to "who could take this".
    expect(schedulable(person({ roles: ['software-engineer'] }))).toBe(true);
  });

  it('excludes observers and leadership-only, and nobody else', () => {
    const people = [
      person({ email: 'eng@x.invalid', roles: ['software-engineer'] }),
      person({ email: 'obs@x.invalid', roles: ['outside-engineering'] }),
      person({ email: 'lead@x.invalid', roles: ['leadership'] }),
      person({ email: 'unset@x.invalid', roles: [] }),
    ];
    expect(people.filter(schedulable).map((p) => p.email)).toEqual([
      'eng@x.invalid',
      'unset@x.invalid',
    ]);
  });

  it('keeps an excluded role on the chart as soon as they hold something', () => {
    expect(
      schedulable(person({ roles: ['leadership'], owned_phase_count: 2 }))
    ).toBe(true);
    expect(
      schedulable(person({ roles: ['outside-engineering'], dri_project_ids: ['p1'] }))
    ).toBe(true);
  });
});
