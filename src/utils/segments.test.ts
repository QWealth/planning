/**
 * Tests for the lane segmentation.
 *
 * As with phaseState.test.ts, the fixtures are real lanes out of DynamoDB rather
 * than invented ones. Segmentation is the kind of code that passes every neat test
 * you write for it and then produces a seam, a one-day sliver or a dropped phase on
 * the actual data — so the three lanes below are exactly what the API returns for
 * Tax (five phases, four of them concurrent, all four lifecycle states), QWAPP (two
 * phases perfectly coincident), and QWAPP Expansion Packs (four concurrent
 * workstreams, none of them a lifecycle stage).
 *
 * `npm test` from the repo root.
 */

import { describe, expect, it } from 'vitest';

import type { Phase } from '../types';
import { describeSegment, laneSegments, peakConcurrency } from './segments';

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

/** The live Tax lane. */
const TAX = [
  ph('Planning', '2026-08-13', '2026-08-17', 1.0),
  ph('Wireframes', '2026-08-15', '2026-08-19', 1.0),
  ph('Architecting', '2026-08-17', '2026-08-30', 0.5),
  ph('Coding', '2026-08-13', '2026-09-13', 0.1),
  ph('Testing', '2026-09-14', '2026-10-31', 0.0),
  ph('Maintenance', null, null, null, true),
];

describe('laneSegments', () => {
  it('returns nothing for a lane with no placeable phases', () => {
    expect(laneSegments([])).toEqual([]);
    expect(laneSegments([ph('Planning', null, null, 0.5)])).toEqual([]);
  });

  it('ignores structural phases', () => {
    // Maintenance has no dates by construction, but it must be excluded by KIND and
    // not merely by being undated - a Maintenance row that someone dates by hand
    // must still not paint a band across the lane forever.
    expect(laneSegments([ph('Maintenance', '2026-01-01', '2026-12-31', null, true)])).toEqual([]);
  });

  it('ignores half-scheduled phases rather than inventing the missing end', () => {
    expect(laneSegments([ph('Coding', '2026-08-13', null, 0.5)])).toEqual([]);
    expect(laneSegments([ph('Coding', null, '2026-09-13', 0.5)])).toEqual([]);
  });

  it('gives a single phase one segment covering exactly its own dates', () => {
    const [segment, ...rest] = laneSegments([ph('Coding', '2026-08-13', '2026-09-13', 0.85)]);

    expect(rest).toHaveLength(0);
    expect(segment.start).toBe('2026-08-13');
    expect(segment.end).toBe('2026-09-13');
    expect(segment.bands).toHaveLength(1);
    expect(segment.bands[0].state).toBe('coding');
  });

  it('leaves a gap between phases that do not touch', () => {
    // The whole reason the old single hull was wrong: this lane is NOT four months
    // of continuous work, and drawing one bar from January to April said it was.
    const segments = laneSegments([
      ph('Planning', '2026-01-01', '2026-01-31', 1),
      ph('Coding', '2026-04-01', '2026-04-30', 0),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0].end).toBe('2026-01-31');
    expect(segments[1].start).toBe('2026-04-01');
  });

  it('splits the live Tax lane at every boundary, losing no day and no phase', () => {
    const segments = laneSegments(TAX);

    expect(segments.map((s) => [s.start, s.end, s.bands.map((b) => b.state)])).toEqual([
      // Planning + Coding start together on the 13th.
      ['2026-08-13', '2026-08-14', ['coding', 'planning']],
      // Wireframes joins on the 15th.
      ['2026-08-15', '2026-08-16', ['coding', 'wireframes', 'planning']],
      // Architecting joins on the 17th - the same day Planning ends, so all four.
      ['2026-08-17', '2026-08-17', ['coding', 'architecting', 'wireframes', 'planning']],
      // Planning has ended; Wireframes runs to the 19th.
      ['2026-08-18', '2026-08-19', ['coding', 'architecting', 'wireframes']],
      ['2026-08-20', '2026-08-30', ['coding', 'architecting']],
      ['2026-08-31', '2026-09-13', ['coding']],
      // Testing picks up the day after Coding ends. `other`, by design.
      ['2026-09-14', '2026-10-31', ['other']],
    ]);
  });

  it('keeps an inclusive end date inclusive', () => {
    // Planning ends on the 17th and Architecting starts on the 17th, so the 17th
    // must carry BOTH. Treating the end as exclusive would drop Planning a day early
    // and silently shorten every phase on the chart by one day.
    const seventeenth = laneSegments(TAX).find((s) => s.start === '2026-08-17');

    expect(seventeenth?.bands.map((b) => b.state)).toContain('planning');
    expect(seventeenth?.bands.map((b) => b.state)).toContain('architecting');
  });

  it('orders bands by rank so a colour keeps its vertical position', () => {
    // Coding is top of every segment it appears in, whatever else is running and
    // whatever order the API returned the phases in. Without this the coding stripe
    // would migrate up and down the row as phases start and finish.
    for (const segment of laneSegments(TAX)) {
      if (segment.bands.some((b) => b.state === 'coding')) {
        expect(segment.bands[0].state).toBe('coding');
      }
    }
  });

  it('collapses same-state concurrent phases into one band', () => {
    // QWAPP Expansion Packs. Four concurrent workstreams, none a lifecycle stage, so
    // one grey band rather than four identical grey slivers.
    const segments = laneSegments([
      ph('Tax', '2026-08-24', '2026-08-30', 0),
      ph('Net Worth', '2026-08-24', '2026-08-30', 0),
      ph('Marketing Feed', '2026-08-24', '2026-08-30', 0),
      ph('Workflows', '2026-08-24', '2026-08-30', 0),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0].bands).toHaveLength(1);
    expect(segments[0].bands[0].state).toBe('other');
    // The four names are not lost - they are what the tooltip is built from.
    expect(segments[0].bands[0].phases.map((p) => p.name)).toEqual([
      'Tax',
      'Net Worth',
      'Marketing Feed',
      'Workflows',
    ]);
  });

  it('merges contiguous slices that would look identical', () => {
    // Two `other` workstreams back to back produce two slices with the same single
    // band. Drawn separately they abut, and the seam reads as a boundary that means
    // something.
    const segments = laneSegments([
      ph('Accounts', '2026-08-01', '2026-08-10', 0),
      ph('Beneficiaries', '2026-08-11', '2026-08-20', 0),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ start: '2026-08-01', end: '2026-08-20' });
  });

  it('handles two perfectly coincident phases', () => {
    // The live QWAPP lane: Coding and Testing on exactly the same dates. One
    // segment, two bands, and Testing is grey because it was explicitly declined a
    // colour of its own.
    const segments = laneSegments([
      ph('Coding', '2026-08-13', '2026-09-13', 0.85),
      ph('Testing', '2026-08-13', '2026-09-13', 0.5),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0].bands.map((b) => b.state)).toEqual(['coding', 'other']);
  });

  it('averages progress within a band and never treats null as zero', () => {
    const [segment] = laneSegments([
      ph('Tax', '2026-08-24', '2026-08-30', 0.4),
      ph('Workflows', '2026-08-24', '2026-08-30', 0.6),
    ]);
    expect(segment.bands[0].progress).toBeCloseTo(0.5);

    const [unknown] = laneSegments([
      ph('Tax', '2026-08-24', '2026-08-30', null),
      ph('Workflows', '2026-08-24', '2026-08-30', null),
    ]);
    expect(unknown.bands[0].progress).toBeNull();

    // One recorded, one not: the mean is of what is known, not of what is assumed.
    // Averaging the null in as 0 would report 20% and would be a number nobody said.
    const [mixed] = laneSegments([
      ph('Tax', '2026-08-24', '2026-08-30', 0.4),
      ph('Workflows', '2026-08-24', '2026-08-30', null),
    ]);
    expect(mixed.bands[0].progress).toBeCloseTo(0.4);
  });

  it('survives a same-day phase', () => {
    // Three phases in Net Of Fees and one in D2 start and end on the same date. An
    // exclusive-end sweep would produce a zero-length segment, or none at all.
    const segments = laneSegments([ph('Planning', '2026-08-13', '2026-08-13', 1)]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ start: '2026-08-13', end: '2026-08-13' });
  });

  it('produces segments that are ordered, non-overlapping and non-empty', () => {
    const segments = laneSegments(TAX);

    for (const segment of segments) {
      expect(segment.start <= segment.end).toBe(true);
      expect(segment.bands.length).toBeGreaterThan(0);
    }
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i - 1].end < segments[i].start).toBe(true);
    }
  });
});

describe('peakConcurrency', () => {
  it('reports the most states running at once', () => {
    expect(peakConcurrency(laneSegments(TAX))).toBe(4);
    expect(peakConcurrency(laneSegments([ph('Coding', '2026-08-13', '2026-09-13', 1)]))).toBe(1);
    expect(peakConcurrency([])).toBe(0);
  });
});

describe('describeSegment', () => {
  it('names what is running, readably', () => {
    const segments = laneSegments(TAX);

    expect(describeSegment(segments[0])).toBe('Coding and Planning');
    expect(describeSegment(segments[2])).toBe('Coding, Architecting, Wireframes and Planning');
    expect(describeSegment(segments[segments.length - 1])).toBe('Testing');
  });
});
