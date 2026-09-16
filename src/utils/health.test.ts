/**
 * Tests for the health verdict.
 *
 * The rules that carry the weight here are the two that stop the dot lying: a lane
 * with nothing recorded reads as "no reading" rather than as healthy, and a lane past
 * its end date reads as late whether or not anybody recorded a percentage. Everything
 * else is arithmetic.
 */

import { describe, expect, it } from 'vitest';

import type { Phase, Project } from '../types';
import { elapsedFraction, projectHealth } from './health';

const TODAY = '2026-06-01';

let counter = 0;
function ph(
  start: string | null,
  end: string | null,
  progress: number | null,
  structural = false
): Phase {
  counter += 1;
  return {
    project_id: 'p',
    phase_id: `ph-${counter}`,
    name: structural ? 'Maintenance' : 'Coding',
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

function proj(phases: Phase[]): Project {
  return {
    project_id: 'p',
    name: 'P',
    lane_order: 0,
    dri_email: null,
    support_email: null,
    active: true,
    category: null,
    created_at: null,
    updated_at: null,
    phases,
    milestones: [],
  };
}

const health = (phases: Phase[], today = TODAY) => projectHealth(proj(phases), today).health;

describe('elapsedFraction', () => {
  it('is 0 before the start and 1 after the end', () => {
    expect(elapsedFraction('2026-06-01', '2026-07-01', '2026-05-01')).toBe(0);
    expect(elapsedFraction('2026-06-01', '2026-07-01', '2026-08-01')).toBe(1);
  });

  it('is the fraction of the span in between', () => {
    // 2026-01-01 to 2026-01-11 is ten days; the 6th is five of them.
    expect(elapsedFraction('2026-01-01', '2026-01-11', '2026-01-06')).toBeCloseTo(0.5);
  });

  it('does not divide by zero on a single-day project', () => {
    expect(elapsedFraction('2026-06-01', '2026-06-01', '2026-06-01')).toBe(1);
  });

  it('is null without dates', () => {
    expect(elapsedFraction(null, '2026-07-01', TODAY)).toBeNull();
    expect(elapsedFraction('2026-06-01', null, TODAY)).toBeNull();
  });
});

describe('projectHealth', () => {
  it('calls a lane on track when progress matches the calendar', () => {
    // Half elapsed, half done.
    expect(health([ph('2026-05-01', '2026-07-01', 0.5)])).toBe('on-track');
  });

  it('calls it ahead with a full step in hand', () => {
    expect(health([ph('2026-05-01', '2026-07-01', 0.7)])).toBe('ahead');
  });

  it('does not call it ahead for less than a step', () => {
    // Progress is entered in tenths, so anything under one step is noise.
    expect(health([ph('2026-05-01', '2026-07-01', 0.55)])).toBe('on-track');
  });

  it('calls it at risk two steps behind', () => {
    expect(health([ph('2026-05-01', '2026-07-01', 0.3)])).toBe('at-risk');
  });

  it('does not call it at risk for one step behind', () => {
    // Asymmetric with ahead on purpose: a lane wrongly called at risk gets looked at,
    // one wrongly called ahead gets ignored.
    expect(health([ph('2026-05-01', '2026-07-01', 0.4)])).toBe('on-track');
  });

  it('calls a lane past its end date late, even with no progress recorded', () => {
    // The date said when, and the date has gone. This is checked before the unknown
    // rule for exactly that reason.
    expect(health([ph('2026-01-01', '2026-03-01', null)])).toBe('late');
    expect(health([ph('2026-01-01', '2026-03-01', 0.9)])).toBe('late');
  });

  it('refuses to judge a lane with no progress recorded', () => {
    // The state that matters most. Several lanes came across the migration like this,
    // and reporting unmeasured work as healthy is worse than admitting we cannot say.
    expect(health([ph('2026-05-01', '2026-07-01', null)])).toBe('unknown');
  });

  it('refuses to judge a lane with no dates', () => {
    expect(health([ph(null, null, 0.4)])).toBe('unknown');
  });

  it('separates not-started from on-track', () => {
    // There is nothing yet to be on track with, and it is not a problem either.
    expect(health([ph('2026-08-01', '2026-09-01', 0)])).toBe('not-started');
  });

  it('calls everything-at-100% complete', () => {
    expect(health([ph('2026-01-01', '2026-03-01', 1)])).toBe('complete');
  });

  it('ignores Maintenance bands', () => {
    // Structural phases are ongoing support with no end. Counting one would make every
    // lane carrying one permanently unfinished, and its missing progress would drag
    // the mean down - which is why the mean comes from laneVerdict rather than here.
    expect(
      health([ph('2026-05-01', '2026-07-01', 0.5), ph(null, null, null, true)])
    ).toBe('on-track');
  });

  it('reports the arithmetic it decided on', () => {
    // 1 May to 1 July is 61 days and 1 June is 31 of them, so elapsed is 0.508 rather
    // than a tidy half. Asserted to two places against the real number rather than
    // being rounded to one that reads better - the threshold comparison uses this
    // value, and a test that pretends it is 0.5 is a test of a different function.
    const v = projectHealth(proj([ph('2026-05-01', '2026-07-01', 0.3)]), TODAY);
    expect(v.progress).toBeCloseTo(0.3, 2);
    expect(v.elapsed).toBeCloseTo(31 / 61, 2);
    expect(v.delta).toBeCloseTo(0.3 - 31 / 61, 2);
  });
});
