/**
 * Tests for the milestone marks.
 *
 * The three things worth pinning here are the three that would be wrong if anyone
 * rewrote this from the shape of the data alone: that `done` beats the date rather
 * than being derived from it, that a milestone due TODAY is not yet missed, and that
 * two milestones on one day become one mark instead of one hiding the other.
 *
 * `npm test` from the repo root.
 */

import { describe, expect, it } from 'vitest';

import type { Milestone, Phase } from '../types';
import { formatLong } from './dates';
import {
  describeMark,
  describeMilestone,
  laneMilestones,
  milestoneDates,
  milestoneStatus,
  missedCount,
  placeMilestones,
  sortMilestones,
  undatedMilestones,
} from './milestones';

const TODAY = '2026-08-28';

let counter = 0;

function ms(
  name: string,
  date: string | null,
  done = false,
  phaseId: string | null = null
): Milestone {
  counter += 1;
  return {
    project_id: 'p',
    milestone_id: `ms-${counter}`,
    name,
    date,
    note: null,
    done,
    phase_id: phaseId,
    created_at: null,
    updated_at: null,
  };
}

function phase(phaseId: string, name = phaseId): Phase {
  return {
    project_id: 'p',
    phase_id: phaseId,
    name,
    phase_order: 0,
    owner_email: null,
    start: null,
    end: null,
    progress: null,
    structural: false,
    created_at: null,
    updated_at: null,
  };
}

describe('milestoneStatus', () => {
  it('calls a future date due', () => {
    expect(milestoneStatus(ms('Beta launch', '2026-10-01'), TODAY)).toBe('due');
  });

  it('does not call today missed', () => {
    // The boundary, and it is the one that matters: flipping to red at midnight on
    // the due date cries wolf on every deadline the moment it arrives, and there is
    // still a working day left to hit it.
    expect(milestoneStatus(ms('Beta launch', TODAY), TODAY)).toBe('due');
    expect(milestoneStatus(ms('Beta launch', '2026-08-27'), TODAY)).toBe('missed');
  });

  it('calls a passed date that is not done missed', () => {
    expect(milestoneStatus(ms('Regulatory deadline', '2026-01-01'), TODAY)).toBe('missed');
  });

  it('lets done beat the date in both directions', () => {
    // This is the whole reason `done` is stored rather than inferred. A past date is
    // NOT evidence that the thing happened, and a done flag on a future date is an
    // early finish, not an error.
    expect(milestoneStatus(ms('Regulatory deadline', '2026-01-01', true), TODAY)).toBe('done');
    expect(milestoneStatus(ms('Beta launch', '2026-12-01', true), TODAY)).toBe('done');
  });

  it('calls an undated milestone due rather than missed', () => {
    // No date is a gap, not a slippage. Reporting it as missed would put a red
    // diamond's worth of alarm on something nobody has committed to yet - and it is
    // not drawn at all, so the alarm would be invisible anyway.
    expect(milestoneStatus(ms('Beta launch', null), TODAY)).toBe('due');
  });
});

describe('undatedMilestones', () => {
  it('separates the ones that cannot be drawn', () => {
    const list = [ms('Beta launch', null), ms('Go live', '2026-09-01'), ms('Sign off', null)];

    expect(undatedMilestones(list).map((m) => m.name)).toEqual(['Beta launch', 'Sign off']);
  });
});

describe('milestoneDates', () => {
  it('yields only real dates, for widening the chart span', () => {
    // A deadline past the last phase must not fall off the right-hand edge - that is
    // the thing it was recorded for.
    const list = [ms('Beta launch', null), ms('Go live', '2027-03-01')];

    expect(milestoneDates(list)).toEqual(['2027-03-01']);
  });
});

describe('laneMilestones', () => {
  it('drops undated milestones rather than guessing a position', () => {
    expect(laneMilestones([ms('Beta launch', null)], TODAY)).toEqual([]);
    expect(laneMilestones([], TODAY)).toEqual([]);
  });

  it('orders marks along the axis, not by urgency', () => {
    // Render order is DOM order, so chronological keeps a row's tab order moving
    // left to right across the chart instead of hopping about it.
    const marks = laneMilestones(
      [
        ms('Go live', '2026-12-01'),
        ms('Regulatory deadline', '2026-01-01'),
        ms('Beta launch', '2026-09-15'),
      ],
      TODAY
    );

    expect(marks.map((m) => m.date)).toEqual(['2026-01-01', '2026-09-15', '2026-12-01']);
  });

  it('clusters milestones sharing a day into one mark', () => {
    // Two diamonds at the same percentage are one diamond with another invisible
    // underneath it. Hiding a deadline behind a deadline is exactly the kind of
    // silent loss this app exists to stop.
    const marks = laneMilestones(
      [ms('Beta launch', '2026-09-15'), ms('Board demo', '2026-09-15')],
      TODAY
    );

    expect(marks).toHaveLength(1);
    expect(marks[0].milestones.map((m) => m.name)).toEqual(['Beta launch', 'Board demo']);
  });

  it('gives a cluster the most urgent status in it', () => {
    // A missed deadline must not be concealed by a completed one that happens to
    // share its date.
    const [mark] = laneMilestones(
      [ms('Signed off', '2026-01-01', true), ms('Regulatory deadline', '2026-01-01')],
      TODAY
    );

    expect(mark.status).toBe('missed');
    // Most urgent first, so the renderer's first name is the one that matters.
    expect(mark.milestones[0].name).toBe('Regulatory deadline');
  });

  it('ranks due above done within a cluster', () => {
    const [mark] = laneMilestones(
      [ms('Already signed off', '2026-12-01', true), ms('Go live', '2026-12-01')],
      TODAY
    );

    expect(mark.status).toBe('due');
    expect(mark.milestones[0].name).toBe('Go live');
  });

  it('keeps a done milestone on the chart, on its original date', () => {
    // It is history. Hiding it or moving it loses the record that the date was met.
    const marks = laneMilestones([ms('Beta launch', '2026-06-01', true)], TODAY);

    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ date: '2026-06-01', status: 'done' });
  });
});

describe('missedCount', () => {
  it('counts milestones, not diamonds', () => {
    // Two deadlines blown on the same day are two broken commitments, even though
    // they are drawn as a single mark.
    const marks = laneMilestones(
      [
        ms('Regulatory deadline', '2026-01-01'),
        ms('Audit sign-off', '2026-01-01'),
        ms('Beta launch', '2026-12-01'),
      ],
      TODAY
    );

    expect(marks).toHaveLength(2);
    expect(missedCount(marks, TODAY)).toBe(2);
  });

  it('is zero when everything is done or ahead', () => {
    const marks = laneMilestones(
      [ms('Beta launch', '2026-01-01', true), ms('Go live', '2026-12-01')],
      TODAY
    );

    expect(missedCount(marks, TODAY)).toBe(0);
  });
});

describe('describeMilestone', () => {
  // The date itself is spelled with formatLong rather than a literal. Hard-coding
  // "Thu 1 Oct 2026" pins the ICU version rather than this module - Node 20 renders
  // September as "Sept" and Node 18 as "Sep", and a test that fails on a runtime
  // upgrade teaches people to stop reading test failures.
  it('says what state it is in, in words', () => {
    // Not colour alone: the diamond's meaning has to survive a screen reader and a
    // monochrome print.
    expect(describeMilestone(ms('Beta launch', '2026-10-01'), TODAY)).toBe(
      `Beta launch — due ${formatLong('2026-10-01')}`
    );
    expect(describeMilestone(ms('Regulatory deadline', '2026-01-01'), TODAY)).toBe(
      `Regulatory deadline — MISSED, was due ${formatLong('2026-01-01')}`
    );
    expect(describeMilestone(ms('Beta launch', '2026-01-01', true), TODAY)).toBe(
      `Beta launch — done, was due ${formatLong('2026-01-01')}`
    );
    expect(describeMilestone(ms('Beta launch', null), TODAY)).toBe('Beta launch — no date set');
  });
});

describe('sortMilestones', () => {
  it('orders by date with the undated ones last', () => {
    // Undated last is the deliberate choice, and it is the one a rewrite would get
    // wrong: null sorts before any string, so the obvious comparator puts the
    // milestones nobody has committed to at the top of a list of deadlines.
    const list = [
      ms('No date', null),
      ms('December', '2026-12-01'),
      ms('September', '2026-09-01'),
    ];

    expect(sortMilestones(list).map((m) => m.name)).toEqual([
      'September',
      'December',
      'No date',
    ]);
  });

  it('breaks a shared date by name, so the order is stable', () => {
    // Two milestones on one day are drawn as a single diamond but listed as two rows,
    // and rows that swap places between renders look like the app lost an edit.
    const list = [ms('Board demo', '2026-09-15'), ms('Beta launch', '2026-09-15')];

    expect(sortMilestones(list).map((m) => m.name)).toEqual(['Beta launch', 'Board demo']);
  });

  it('leaves the array it was given alone', () => {
    const list = [ms('December', '2026-12-01'), ms('September', '2026-09-01')];

    sortMilestones(list);

    // Sorting in place would mutate React state that was handed in by reference, and
    // the re-render that should follow simply would not happen.
    expect(list.map((m) => m.name)).toEqual(['December', 'September']);
  });
});

describe('describeMark', () => {
  it('names a lone milestone exactly as describeMilestone does', () => {
    const [mark] = laneMilestones([ms('Beta launch', '2026-10-01')], TODAY);

    expect(describeMark(mark, TODAY)).toBe(`Beta launch — due ${formatLong('2026-10-01')}`);
  });

  it('names every member of a cluster', () => {
    const [mark] = laneMilestones(
      [ms('Beta launch', '2026-09-15'), ms('Board demo', '2026-09-15')],
      TODAY
    );

    expect(describeMark(mark, TODAY)).toBe(
      `2 milestones on ${formatLong('2026-09-15')}: Beta launch, Board demo`
    );
  });
});

describe('placeMilestones', () => {
  it('puts an attached milestone under its phase and the rest on the lane', () => {
    const infra = phase('ph-infra');
    const placement = placeMilestones(
      [ms('Hardened', '2026-09-01', false, 'ph-infra'), ms('Regulatory deadline', '2026-12-31')],
      [infra]
    );

    expect(placement.byPhase.get('ph-infra')?.map((m) => m.name)).toEqual(['Hardened']);
    expect(placement.onLane.map((m) => m.name)).toEqual(['Regulatory deadline']);
  });

  it('leaves out phases that have no milestones', () => {
    // An empty entry would make the caller draw a heading for nothing.
    const placement = placeMilestones([ms('Deadline', '2026-12-31')], [phase('ph-1')]);

    expect(placement.byPhase.size).toBe(0);
  });

  it('keeps a milestone whose phase is missing, on the lane', () => {
    // The server detaches milestones when a phase is deleted, so a phase_id that
    // matches nothing means this payload is stale - and the lane is where the row is
    // about to end up anyway. Dropping it would make a commitment disappear from the
    // only screen that lists it.
    const placement = placeMilestones([ms('Orphan', '2026-09-01', false, 'gone')], [phase('ph-1')]);

    expect(placement.byPhase.size).toBe(0);
    expect(placement.onLane.map((m) => m.name)).toEqual(['Orphan']);
  });

  it('sorts each group by date, undated last', () => {
    const placement = placeMilestones(
      [
        ms('Someday', null, false, 'ph-1'),
        ms('December', '2026-12-01', false, 'ph-1'),
        ms('September', '2026-09-01', false, 'ph-1'),
      ],
      [phase('ph-1')]
    );

    expect(placement.byPhase.get('ph-1')?.map((m) => m.name)).toEqual([
      'September',
      'December',
      'Someday',
    ]);
  });

  it('sorts the lane group too', () => {
    const placement = placeMilestones([ms('Later', '2026-12-01'), ms('Sooner', '2026-09-01')], []);

    expect(placement.onLane.map((m) => m.name)).toEqual(['Sooner', 'Later']);
  });

  it('separates milestones belonging to different phases', () => {
    const placement = placeMilestones(
      [
        ms('Infra done', '2026-09-01', false, 'ph-infra'),
        ms('Built', '2026-10-01', false, 'ph-build'),
      ],
      [phase('ph-infra'), phase('ph-build')]
    );

    expect(placement.byPhase.get('ph-infra')?.map((m) => m.name)).toEqual(['Infra done']);
    expect(placement.byPhase.get('ph-build')?.map((m) => m.name)).toEqual(['Built']);
    expect(placement.onLane).toEqual([]);
  });

  it('leaves the array it was given alone', () => {
    const list = [ms('B', '2026-12-01', false, 'ph-1'), ms('A', '2026-09-01', false, 'ph-1')];

    placeMilestones(list, [phase('ph-1')]);

    expect(list.map((m) => m.name)).toEqual(['B', 'A']);
  });

  it('treats no milestones as no placement at all', () => {
    const placement = placeMilestones([], [phase('ph-1')]);

    expect(placement.byPhase.size).toBe(0);
    expect(placement.onLane).toEqual([]);
  });
});
