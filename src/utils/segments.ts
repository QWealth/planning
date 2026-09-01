/**
 * Slice a lane's phases into time segments, so a collapsed row can show more than
 * one thing happening at once.
 *
 * WHY THIS EXISTS, AND WHAT IT REPLACES
 * -------------------------------------
 * utils/phaseState.ts reduces a lane to ONE state, and the collapsed bar was drawn
 * in that one colour from the project's earliest start to its latest end. That is a
 * real answer to "where has this got to", and it is kept — the lane's dot, caption
 * and tooltip still come from it. But it cannot answer "what is happening in
 * September", and in this data that question has an answer with several parts:
 * every lane that has phases overlaps somewhere, peaking at four concurrent phases
 * on Tax, Net Of Fees and QWAPP Expansion Packs.
 *
 * A single-colour hull also actively lied about the gaps. A lane with Planning in
 * January and Coding in December drew one solid bar across the whole year, which
 * reads as eleven months of continuous work. Segments are drawn only where work
 * actually sits, so the quiet months are visibly quiet.
 *
 * BANDS ARE UNIQUE STATES, NOT PHASES
 * -----------------------------------
 * QWAPP Expansion Packs runs four concurrent one-off workstreams — Tax, Net Worth,
 * Marketing Feed, Workflows — and none of them is a recognised lifecycle phase, so
 * all four are `other`. Banding per phase would divide that row into four identical
 * grey slivers, which carries no information and costs a quarter of the row height
 * each. Banding per unique state gives one grey band that says "four workstreams,
 * none of them a named stage", and the four names are in the tooltip.
 *
 * PROGRESS IS NOT DRAWN INSIDE A BAND
 * -----------------------------------
 * Bar.tsx fills a bar proportionally to its progress. A band is a *slice* of a
 * phase, so a proportional fill inside it would read as "62% through this slice",
 * which is a fact nobody has and which changes as the slice is subdivided by
 * unrelated phases starting elsewhere. Progress is a property of the whole phase,
 * so it stays where it can be stated honestly: the lane caption, the tooltip, and
 * the expanded phase rows, which still use the full Bar grammar.
 *
 * The one distinction that DOES survive into the band is recorded-versus-not, drawn
 * as hatching, because that is the distinction this whole app exists to preserve.
 */

import type { PhaseState } from '../styles/theme';
import type { Phase } from '../types';
import { addDays, formatISO, parseISO } from './dates';
import { phaseState, STATE_RANK } from './phaseState';

/** One colour stripe within a segment: every phase of that state active at the time. */
export interface Band {
  state: PhaseState;
  /** The phases this band stands for. Usually one; four on Expansion Packs. */
  phases: Phase[];
  /**
   * Mean progress across the band's phases that HAVE a recorded progress, or null
   * when none of them do. Null is not zero — same rule as everywhere else.
   */
  progress: number | null;
}

/** A stretch of time over which exactly the same set of states is active. */
export interface Segment {
  /** Inclusive ISO day. */
  start: string;
  /** Inclusive ISO day. */
  end: string;
  /** Ordered highest-ranked first, so a colour keeps its vertical position. */
  bands: Band[];
}

const dayAfter = (iso: string): string => formatISO(addDays(parseISO(iso), 1));
const dayBefore = (iso: string): string => formatISO(addDays(parseISO(iso), -1));

/**
 * A phase can be drawn as a band only if both its ends are known.
 *
 * Half-scheduled phases are excluded rather than guessed at. The API allows a start
 * with no end on purpose — you know when something begins before you know when it
 * finishes — and the only ways to band one are to invent an end or to run it to the
 * edge of the chart, both of which draw a commitment nobody made. There are none in
 * the live data today; there will be, and the honest place for them is the expanded
 * row, where Bar draws its faded open edge. (It used to be the gaps report as well,
 * which has since been removed.)
 *
 * Exported so that a caller who needs to SAY what was left out can use the very
 * predicate that left it out. utils/assignments.ts counts a person's undrawable
 * phases with this, which is what stops "2 phases not shown" from disagreeing with
 * the bars beside it - a caption that miscounts its own chart is worse than none.
 */
export function placeable(phases: Phase[]): Phase[] {
  return phases.filter(
    (p): p is Phase & { start: string; end: string } =>
      !p.structural && p.start !== null && p.end !== null && p.start <= p.end
  );
}

function buildBands(phases: Phase[]): Band[] {
  const byState = new Map<PhaseState, Phase[]>();
  for (const phase of phases) {
    const state = phaseState(phase.name);
    const existing = byState.get(state);
    if (existing) {
      existing.push(phase);
    } else {
      byState.set(state, [phase]);
    }
  }

  return [...byState.entries()]
    .map(([state, members]) => {
      const known = members.filter((p) => p.progress !== null);
      return {
        state,
        phases: members,
        progress: known.length
          ? known.reduce((sum, p) => sum + (p.progress ?? 0), 0) / known.length
          : null,
      };
    })
    .sort((a, b) => {
      // Highest-ranked on top, always. A stable vertical order is what lets the eye
      // follow "coding" across a row as other phases come and go beneath it; sorting
      // by anything incidental would make the same colour jump between stripes at
      // every boundary.
      const rank = STATE_RANK[b.state] - STATE_RANK[a.state];
      return rank !== 0 ? rank : a.state.localeCompare(b.state);
    });
}

/** The states of a segment, as a string, for comparing two segments' appearance. */
const signature = (bands: Band[]): string => bands.map((b) => b.state).join('|');

/**
 * Cut a lane's phases at every start and every day-after-an-end, and keep the
 * stretches where something is running.
 *
 * A classic sweep over boundaries. Ends are exclusive-shifted by a day because a
 * phase's end date is inclusive here (a phase that starts and ends on the same day
 * is one day of work, not zero — see inclusiveDays), so the point at which it stops
 * being active is the morning after.
 */
export function laneSegments(phases: Phase[]): Segment[] {
  const real = placeable(phases);
  if (real.length === 0) {
    return [];
  }

  const boundaries = [
    ...new Set(real.flatMap((p) => [p.start as string, dayAfter(p.end as string)])),
  ].sort();

  const raw: { start: string; end: string; phases: Phase[] }[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const from = boundaries[i];
    const active = real.filter(
      (p) => (p.start as string) <= from && (p.end as string) >= from
    );
    if (active.length > 0) {
      raw.push({ start: from, end: dayBefore(boundaries[i + 1]), phases: active });
    }
  }

  // Merge neighbours that would look identical. Two contiguous `other` workstreams
  // — one ending the day before the next begins — are two slices with the same one
  // band, and drawing them separately puts a seam in the middle of what is visually
  // a single grey block.
  const merged: { start: string; end: string; phases: Phase[] }[] = [];
  for (const slice of raw) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      dayAfter(previous.end) === slice.start &&
      signature(buildBands(previous.phases)) === signature(buildBands(slice.phases))
    ) {
      previous.end = slice.end;
      previous.phases = [...new Set([...previous.phases, ...slice.phases])];
      continue;
    }
    merged.push({ ...slice });
  }

  return merged.map((slice) => ({
    start: slice.start,
    end: slice.end,
    bands: buildBands(slice.phases),
  }));
}

/** The most states active at any one moment. Drives how thin the stripes get. */
export function peakConcurrency(segments: Segment[]): number {
  return segments.reduce((most, segment) => Math.max(most, segment.bands.length), 0);
}

/**
 * "Coding, Testing" — the band names of a segment, for a tooltip.
 *
 * `name` is pluggable because a phase's own name is only self-explanatory inside its
 * lane. On the Team chart a row mixes phases from several projects, where "Coding and
 * Coding" is a tooltip that tells you nothing and "Coding (Tax) and Coding (QWAPP)"
 * is the whole answer. Naming is the caller's business; banding is not.
 */
export function describeSegment(
  segment: Segment,
  name: (phase: Phase) => string = (phase) => phase.name
): string {
  const names = segment.bands.flatMap((band) => band.phases.map(name));
  if (names.length <= 2) {
    return names.join(' and ');
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
