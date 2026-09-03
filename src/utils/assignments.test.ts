/**
 * Tests for the person-centric view of the roadmap.
 *
 * The cases that matter here are the ones the project-centric chart never has to
 * face, because they only exist once the data is transposed: one person owning
 * phases in three different lanes at once, somebody who is both DRI and Support on
 * the same project, a role on a lane with no dates to infer a span from, and the
 * addresses that differ only in case - which is the one that silently splits a person
 * into two rows, each looking half as busy as they are.
 *
 * `npm test` from the repo root.
 */

import { describe, expect, it } from 'vitest';

import type { Milestone, Phase, Project } from '../types';
import {
  assignmentsByPerson,
  datedSpan,
  describeRoles,
  noAssignments,
  peakOverlap,
  projectSpan,
} from './assignments';

let counter = 0;

function ph(
  name: string,
  owner: string | null,
  start: string | null,
  end: string | null,
  structural = false
): Phase {
  counter += 1;
  return {
    project_id: 'p',
    phase_id: `ph-${counter}`,
    name,
    phase_order: counter,
    owner_email: owner,
    start,
    end,
    progress: null,
    structural,
    created_at: null,
    updated_at: null,
  };
}

function pr(
  name: string,
  dri: string | null,
  support: string | null,
  phases: Phase[],
  milestones: Milestone[] = []
): Project {
  counter += 1;
  return {
    project_id: `pj-${counter}`,
    name,
    lane_order: counter,
    dri_email: dri,
    support_email: support,
    active: true,
    created_at: null,
    updated_at: null,
    phases,
    milestones,
  };
}

function ms(name: string, date: string | null): Milestone {
  counter += 1;
  return {
    project_id: 'p',
    milestone_id: `ms-${counter}`,
    name,
    date,
    note: null,
    done: false,
    // Nothing in this module reads it: an assignment comes from a phase's owner and
    // its dates, and a milestone is neither owned nor durable work. Fixed at null
    // rather than parameterised so a future test cannot come to depend on it here.
    phase_id: null,
    created_at: null,
    updated_at: null,
  };
}

describe('projectSpan', () => {
  it('runs from the earliest start to the latest end, not the last phase listed', () => {
    // Deliberately out of order, and the longest phase starts first and ends last -
    // taking phases[0] or phases[n-1] would pass on tidier data.
    const project = pr('Tax', null, null, [
      ph('Architecting', null, '2026-08-17', '2026-08-30'),
      ph('Coding', null, '2026-08-13', '2026-09-13'),
      ph('Planning', null, '2026-08-15', '2026-08-19'),
    ]);
    expect(projectSpan(project)).toEqual({ start: '2026-08-13', end: '2026-09-13' });
  });

  it('ignores structural and half-scheduled phases, exactly as the chart does', () => {
    const project = pr('QWAPP', null, null, [
      ph('Maintenance', null, null, null, true),
      ph('Coding', null, '2026-09-01', null),
      ph('Testing', null, '2026-09-10', '2026-09-20'),
    ]);
    expect(projectSpan(project)).toEqual({ start: '2026-09-10', end: '2026-09-20' });
  });

  it('is null for a lane with nothing datable rather than a tick at today', () => {
    expect(projectSpan(pr('Unscheduled', null, null, []))).toBeNull();
    expect(
      projectSpan(pr('Maintenance only', null, null, [ph('Maintenance', null, null, null, true)]))
    ).toBeNull();
  });

  it('is not widened by a milestone past the last phase', () => {
    // The deliberate decision recorded in the module header: a span is drawn work-
    // shaped, so stretching it to a deadline paints work across weeks that have none.
    const project = pr(
      'QWAPP',
      null,
      null,
      [ph('Coding', null, '2026-08-01', '2026-08-15')],
      [ms('Partner onboarding', '2026-08-31')]
    );
    expect(projectSpan(project)).toEqual({ start: '2026-08-01', end: '2026-08-15' });
  });
});

describe('assignmentsByPerson', () => {
  it('collects one person’s phases from across several lanes', () => {
    const map = assignmentsByPerson([
      pr('Tax', null, null, [ph('Coding', 'ha@q.com', '2026-08-01', '2026-08-10')]),
      pr('QWAPP', null, null, [
        ph('Wireframes', 'ha@q.com', '2026-07-01', '2026-07-20'),
        ph('Testing', 'meherzad@q.com', '2026-07-05', '2026-07-09'),
      ]),
    ]);

    expect(map.get('ha@q.com')?.owned.map((p) => p.name)).toEqual(['Wireframes', 'Coding']);
    expect(map.get('meherzad@q.com')?.owned.map((p) => p.name)).toEqual(['Testing']);
  });

  it('treats addresses case-insensitively, as the backend does', () => {
    // Two rows for one person is the failure this guards: each would look half as
    // loaded as they are, and neither would be wrong on its own terms.
    const map = assignmentsByPerson([
      pr('Tax', 'Ha@Q.com', null, [ph('Coding', 'HA@q.com', '2026-08-01', '2026-08-10')]),
    ]);

    expect([...map.keys()]).toEqual(['ha@q.com']);
    expect(map.get('ha@q.com')?.owned).toHaveLength(1);
    expect(map.get('ha@q.com')?.roles).toHaveLength(1);
  });

  it('infers a span for a DRI and for a Support, from that lane’s phases', () => {
    const map = assignmentsByPerson([
      pr('Tax', 'ha@q.com', 'meherzad@q.com', [
        ph('Coding', null, '2026-08-13', '2026-09-13'),
        ph('Planning', null, '2026-08-01', '2026-08-05'),
      ]),
    ]);

    expect(map.get('ha@q.com')?.roles).toEqual([
      {
        project_id: expect.any(String),
        project_name: 'Tax',
        role: 'dri',
        start: '2026-08-01',
        end: '2026-09-13',
      },
    ]);
    expect(map.get('meherzad@q.com')?.roles[0].role).toBe('support');
  });

  it('records both roles when one person holds both on the same lane', () => {
    // Not deduplicated in the data - both spans are kept so both bands draw. It is
    // only the WORDS that collapse, to "DRI and Support", which is the true and
    // materially worse position: nobody else is watching that lane.
    const map = assignmentsByPerson([
      pr('Tax', 'ha@q.com', 'ha@q.com', [ph('Coding', null, '2026-08-01', '2026-08-10')]),
    ]);

    expect(map.get('ha@q.com')?.roles.map((r) => r.role)).toEqual(['dri', 'support']);
    expect(describeRoles(map.get('ha@q.com')!)).toBe('DRI and Support on Tax');
  });

  it('names each project once, grouping the sole-cover lanes ahead of the rest', () => {
    // The label cell is 248px. Saying "DRI of X · Support on X" spent it naming one
    // lane twice and then truncated, losing the END of the list to a repetition the
    // reader had to spot for themselves.
    const map = assignmentsByPerson([
      pr('Tax', 'ha@q.com', 'ha@q.com', [ph('Coding', null, '2026-08-01', '2026-08-10')]),
      pr('QWAPP', 'ha@q.com', 'meherzad@q.com', [ph('Coding', null, '2026-08-01', '2026-08-10')]),
      pr('D2', 'meherzad@q.com', 'ha@q.com', [ph('Coding', null, '2026-08-01', '2026-08-10')]),
    ]);

    expect(describeRoles(map.get('ha@q.com')!)).toBe(
      'DRI and Support on Tax · DRI of QWAPP · Support on D2'
    );
  });

  it('does not merge two lanes that merely share a name', () => {
    // Grouped by project_id, not by name. Merging on the name would say somebody is
    // "DRI and Support on Tax" when they hold one role on each of two different Taxes,
    // which invents sole cover where there is none - the one claim this label makes
    // that somebody might act on.
    const map = assignmentsByPerson([
      pr('Tax', 'ha@q.com', null, [ph('Coding', null, '2026-08-01', '2026-08-10')]),
      pr('Tax', null, 'ha@q.com', [ph('Coding', null, '2026-08-01', '2026-08-10')]),
    ]);

    expect(describeRoles(map.get('ha@q.com')!)).toBe('DRI of Tax · Support on Tax');
  });

  it('keeps a role on an undatable lane, separately, instead of dropping it', () => {
    const map = assignmentsByPerson([pr('Someday', 'ha@q.com', null, [])]);
    const ha = map.get('ha@q.com')!;

    expect(ha.roles).toEqual([]);
    expect(ha.undatedRoles).toEqual([
      { project_id: expect.any(String), project_name: 'Someday', role: 'dri' },
    ]);
    // And it still shows up in the words, which is the only place it can appear.
    expect(describeRoles(ha)).toBe('DRI of Someday');
  });

  it('separates owned phases the chart cannot place, without losing them', () => {
    const map = assignmentsByPerson([
      pr('QWAPP', null, null, [
        ph('Maintenance', 'ha@q.com', null, null, true),
        ph('Coding', 'ha@q.com', '2026-08-01', null),
        ph('Testing', 'ha@q.com', '2026-08-01', '2026-08-10'),
      ]),
    ]);
    const ha = map.get('ha@q.com')!;

    expect(ha.owned).toHaveLength(3);
    expect(ha.undrawable.map((p) => p.name).sort()).toEqual(['Coding', 'Maintenance']);
  });

  it('has no entry for somebody named nowhere, and noAssignments fills the hole', () => {
    const map = assignmentsByPerson([pr('Tax', 'ha@q.com', null, [])]);

    expect(map.has('joe@q.com')).toBe(false);
    expect(noAssignments('Joe@Q.com')).toEqual({
      email: 'joe@q.com',
      owned: [],
      undrawable: [],
      roles: [],
      undatedRoles: [],
    });
  });

  it('ignores unowned phases rather than gathering them under an empty key', () => {
    const map = assignmentsByPerson([
      pr('Tax', null, null, [ph('Coding', null, '2026-08-01', '2026-08-10')]),
    ]);
    expect([...map.keys()]).toEqual([]);
  });
});

describe('peakOverlap', () => {
  it('counts concurrent phases, not concurrent states', () => {
    // The distinction from segments.peakConcurrency. Two Coding phases at once are
    // one band on the chart and two commitments in a diary; on a person's row it is
    // the second number that answers "can they take this on".
    const at = [
      ph('Coding', 'ha@q.com', '2026-08-01', '2026-08-31'),
      ph('Coding', 'ha@q.com', '2026-08-10', '2026-08-20'),
      ph('Testing', 'ha@q.com', '2026-08-15', '2026-08-18'),
    ];
    expect(peakOverlap(at)).toBe(3);
  });

  it('counts a phase that ends the day another begins as consecutive, not concurrent', () => {
    expect(
      peakOverlap([
        ph('Planning', 'ha@q.com', '2026-08-01', '2026-08-10'),
        ph('Coding', 'ha@q.com', '2026-08-11', '2026-08-20'),
      ])
    ).toBe(1);
  });

  it('counts a same-day overlap, because an end date is inclusive', () => {
    expect(
      peakOverlap([
        ph('Planning', 'ha@q.com', '2026-08-01', '2026-08-10'),
        ph('Coding', 'ha@q.com', '2026-08-10', '2026-08-20'),
      ])
    ).toBe(2);
  });

  it('is zero when nothing can be placed', () => {
    expect(peakOverlap([])).toBe(0);
    expect(peakOverlap([ph('Maintenance', 'ha@q.com', null, null, true)])).toBe(0);
  });
});

describe('datedSpan', () => {
  it('spans a person’s own phases across lanes, and NOT the lanes they merely run', () => {
    // The bug this pins down: handing the chart the union of owned work and role
    // spans drew Paul's extent hairline from his single August phase out to the
    // December end of a project he owns nothing in, retracing the role band it sat
    // inside and towing the "1 phase" caption three months away from the phase.
    const map = assignmentsByPerson([
      pr('Net Of Fees', 'paul@q.com', null, [
        ph('Planning', 'paul@q.com', '2026-08-24', '2026-08-24'),
        ph('Coding', 'someone@q.com', '2026-09-01', '2026-12-14'),
      ]),
    ]);
    const paul = map.get('paul@q.com')!;

    expect(datedSpan(paul.owned)).toEqual({ start: '2026-08-24', end: '2026-08-24' });
    // The role still spans the whole project - that is what the band behind is for.
    expect(paul.roles[0]).toMatchObject({ start: '2026-08-24', end: '2026-12-14' });
  });

  it('is null when nothing they own can be placed', () => {
    const map = assignmentsByPerson([
      pr('Someday', 'ha@q.com', null, [ph('Maintenance', 'ha@q.com', null, null, true)]),
    ]);
    expect(datedSpan(map.get('ha@q.com')!.owned)).toBeNull();
  });
});
