/**
 * Tests for the lane-state reduction.
 *
 * The cases below are the nine real lanes as they stand in DynamoDB today, not
 * invented fixtures. That is the point: the rule "highest-ranked started phase"
 * sounds obviously right in the abstract and only shows its edges against data that
 * actually exists - QWAPP with Testing running alongside Coding, D2 with everything
 * still in the future, QWAPP Expansion Packs with no lifecycle phase at all, Qfeed
 * with progress recorded but no dates anywhere.
 *
 * `npm test` from the repo root.
 */

import { describe, expect, it } from 'vitest';

import type { Phase } from '../types';
import { laneVerdict, phaseState, STATE_RANK } from './phaseState';

/** Today, as of the data below. Passed explicitly so these tests never expire. */
const TODAY = '2026-08-27';

let counter = 0;

function ph(
  name: string,
  start: string | null,
  end: string | null,
  progress: number | null,
  structural = false
): Phase {
  counter += 1;
  return {
    project_id: 'p',
    phase_id: `ph-${counter}`,
    name,
    phase_order: counter,
    owner_email: null,
    start,
    end,
    progress,
    structural,
    created_at: null,
    updated_at: null,
  };
}

describe('phaseState', () => {
  it('recognises the four lifecycle names, case-insensitively', () => {
    expect(phaseState('Planning')).toBe('planning');
    expect(phaseState('  wireframes ')).toBe('wireframes');
    expect(phaseState('ARCHITECTING')).toBe('architecting');
    expect(phaseState('Coding')).toBe('coding');
  });

  it('puts Testing and Maintenance in the grey bucket', () => {
    // Not an oversight - see the module docstring. Testing was offered its own
    // colour and declined.
    expect(phaseState('Testing')).toBe('other');
    expect(phaseState('Maintenance')).toBe('other');
  });

  it('does not substring-match', () => {
    // "Tax" is both a project name and a phase name inside QWAPP Expansion Packs.
    // A looser matcher that looked for "plan" in "Planning" would also catch a
    // future phase called "Replanning" and colour it wrongly.
    expect(phaseState('Tax')).toBe('other');
    expect(phaseState('Marketing Feed')).toBe('other');
    expect(phaseState('Beneficiaries')).toBe('other');
    expect(phaseState('Pre-planning')).toBe('other');
  });

  it('ranks Coding above the rest and everything unknown below Planning', () => {
    expect(STATE_RANK.coding).toBeGreaterThan(STATE_RANK.architecting);
    expect(STATE_RANK.architecting).toBeGreaterThan(STATE_RANK.wireframes);
    expect(STATE_RANK.wireframes).toBeGreaterThan(STATE_RANK.planning);
    expect(STATE_RANK.planning).toBeGreaterThan(STATE_RANK.other);
  });
});

describe('laneVerdict, against the nine live lanes', () => {
  it('QWAPP: Coding wins over the Testing running beside it', () => {
    // The case that decides the whole precedence rule. Testing is later in the
    // lifecycle; ranking by lifecycle would paint the most advanced project grey.
    const verdict = laneVerdict(
      [
        ph('Planning', null, null, 1.0),
        ph('Wireframes', null, null, 1.0),
        ph('Architecting', null, null, 1.0),
        ph('Coding', '2026-08-13', '2026-09-13', 0.85),
        ph('Testing', '2026-08-13', '2026-09-13', 0.5),
        ph('Maintenance', null, null, null, true),
      ],
      TODAY
    );
    expect(verdict.state).toBe('coding');
    expect(verdict.basis).toBe('in-progress');
    expect(verdict.driver?.name).toBe('Coding');
    expect(verdict.start).toBe('2026-08-13');
    expect(verdict.end).toBe('2026-09-13');
  });

  it('D2: nothing started yet, so it reports what starts NEXT, not what ranks highest', () => {
    // Every date is in the future. Wireframes on 7 Sep is the next thing to happen;
    // Coding on 28 Sep ranks higher but is a month away and answers the wrong
    // question.
    const verdict = laneVerdict(
      [
        ph('Planning', '2026-09-14', '2026-09-21', 0.5),
        ph('Wireframes', '2026-09-07', '2026-09-14', 0.6),
        ph('Architecting', '2026-09-21', '2026-09-21', 0.5),
        ph('Coding', '2026-09-28', '2026-10-28', 0.25),
        ph('Testing', '2026-10-28', '2026-11-09', 0.25),
        ph('Maintenance', null, null, null, true),
      ],
      TODAY
    );
    expect(verdict.state).toBe('wireframes');
    expect(verdict.basis).toBe('upcoming');
    expect(verdict.driver?.name).toBe('Wireframes');
  });

  it('Qfeed: progress recorded but no dates anywhere is "unscheduled", not empty', () => {
    const verdict = laneVerdict(
      [
        ph('Planning', null, null, 0.5),
        ph('Wireframes', null, null, 0.5),
        ph('Architecting', null, null, null),
        ph('Coding', null, null, null),
        ph('Testing', null, null, null),
        ph('Maintenance', null, null, null, true),
      ],
      TODAY
    );
    expect(verdict.basis).toBe('unscheduled');
    expect(verdict.start).toBeNull();
    expect(verdict.unscheduledCount).toBe(5);
    expect(verdict.realCount).toBe(5);
    // Two phases know their progress, three do not. The average is over the two
    // that do, and the count says how much of the lane it speaks for.
    expect(verdict.progress).toBeCloseTo(0.5);
    expect(verdict.progressUnknownCount).toBe(3);
  });

  it('QWAPP Expansion Packs: only unrecognised workstreams, so grey but in progress', () => {
    const verdict = laneVerdict(
      [
        ph('Tax', '2026-08-24', '2026-08-30', 0.0),
        ph('Net Worth', '2026-08-24', '2026-08-30', 0.0),
        ph('Marketing Feed', '2026-08-24', '2026-08-30', 0.0),
        ph('Workflows', '2026-08-24', '2026-08-30', 0.0),
        ph('Maintenance', null, null, null, true),
      ],
      TODAY
    );
    expect(verdict.state).toBe('other');
    expect(verdict.basis).toBe('in-progress');
    expect(verdict.progress).toBe(0);
  });

  it('Net Worth: a phase with progress null still counts as started and incomplete', () => {
    // Architecting has no progress recorded. "Unknown" must not be read as "done",
    // or the lane would report Planning - a less advanced state - as its driver.
    const verdict = laneVerdict(
      [
        ph('Planning', '2026-08-24', '2026-08-28', 0.5),
        ph('Wireframes', null, null, 1.0),
        ph('Architecting', '2026-08-24', '2026-08-28', null),
        ph('Coding', '2026-09-01', '2026-09-30', null),
        ph('Testing', '2026-09-30', '2026-10-07', null),
        ph('Maintenance', null, null, null, true),
      ],
      TODAY
    );
    expect(verdict.state).toBe('architecting');
    expect(verdict.driver?.name).toBe('Architecting');
    expect(verdict.progressUnknownCount).toBe(3);
    // Averaged over the two phases that have a figure, not over all five.
    expect(verdict.progress).toBeCloseTo(0.75);
  });

  it('Enhanced Data Delivery: a phase starting after today is not yet started', () => {
    // Coding begins on 31 Aug, four days out. Only Planning has actually begun, so
    // that is the lane's state - not the highest-ranked phase on the list.
    const verdict = laneVerdict(
      [
        ph('Planning', '2026-08-24', '2026-08-31', 0.25),
        ph('Accounts', '2026-09-13', '2026-09-20', null),
        ph('Transactions', '2026-09-20', '2026-09-27', null),
        ph('Addresses', '2026-09-26', '2026-10-03', null),
        ph('Beneficiaries', '2026-08-31', '2026-09-13', 0.25),
        ph('Coding', '2026-08-31', '2026-10-03', 0.6),
        ph('Testing', null, null, 0.5),
        ph('Maintenance', null, null, null, true),
      ],
      TODAY
    );
    expect(verdict.state).toBe('planning');
    expect(verdict.basis).toBe('in-progress');
    expect(verdict.start).toBe('2026-08-24');
    expect(verdict.end).toBe('2026-10-03');
  });

  it('structural phases never decide the colour and never count as gaps', () => {
    const verdict = laneVerdict(
      [ph('Coding', '2026-08-01', '2026-08-31', 1.0), ph('Maintenance', null, null, null, true)],
      TODAY
    );
    expect(verdict.basis).toBe('complete');
    expect(verdict.realCount).toBe(1);
    expect(verdict.unscheduledCount).toBe(0);
  });

  it('a lane of nothing but Maintenance is empty, not complete', () => {
    const verdict = laneVerdict([ph('Maintenance', null, null, null, true)], TODAY);
    expect(verdict.basis).toBe('empty');
    expect(verdict.progress).toBeNull();
  });

  it('progress 0 and progress null are not the same lane', () => {
    const zero = laneVerdict([ph('Coding', '2026-08-01', '2026-08-31', 0)], TODAY);
    const unknown = laneVerdict([ph('Coding', '2026-08-01', '2026-08-31', null)], TODAY);
    expect(zero.progress).toBe(0);
    expect(unknown.progress).toBeNull();
    expect(unknown.progressUnknownCount).toBe(1);
  });

  it('a phase starting exactly today counts as started', () => {
    const verdict = laneVerdict([ph('Coding', TODAY, '2026-09-30', 0)], TODAY);
    expect(verdict.basis).toBe('in-progress');
  });
});
