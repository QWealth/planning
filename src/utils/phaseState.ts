/**
 * What state a project is in, decided from its phases.
 *
 * This is the load-bearing idea of the whole screen. The workbook drew six task rows
 * per project - fifty-four rows for nine projects - and the compression to one row
 * each is only readable if that one row still says where the project has got to.
 * Colour is what carries that, which is why this module is pure, tested, and kept
 * away from anything that renders.
 *
 * THE PRECEDENCE IS NOT LIFECYCLE ORDER, AND THAT IS ON PURPOSE.
 *
 *     Coding > Architecting > Wireframes > Planning > everything else
 *
 * Testing comes after Coding in time but sits in the grey bucket, because giving
 * Testing its own colour was offered and explicitly declined. Ranking it by lifecycle
 * position instead would break the chart: QWAPP is 85% coded with testing running
 * alongside at 50%, so a lifecycle ranking would paint that lane grey and report the
 * most advanced project on the board as the least legible one. If Testing ever earns
 * a colour, add it to STATE_STYLE in styles/theme.ts and give it a rank here - those
 * are the only two edits.
 */

import type { PhaseState } from '../styles/theme';
import type { Phase } from '../types';

export type { PhaseState };

/**
 * Higher wins. `other` is 0 rather than -1 so that it still counts as a real state:
 * a lane whose only started work is a one-off workstream (QWAPP Expansion Packs has
 * four - Tax, Net Worth, Marketing Feed, Workflows, and no lifecycle phase at all)
 * is in progress and grey, not unscheduled.
 */
export const STATE_RANK: Record<PhaseState, number> = {
  coding: 40,
  architecting: 30,
  wireframes: 20,
  planning: 10,
  other: 0,
};

/**
 * Map a phase name onto a state.
 *
 * Matched on the exact lowercased name, not a substring. Substring matching looks
 * more forgiving and is wrong here: the live data contains a phase literally named
 * "Tax" inside the QWAPP Expansion Packs lane, and a project named "Tax" elsewhere,
 * and eight other one-off workstream names. Anything unrecognised is `other`, which
 * is honest - the app does not know what stage "Beneficiaries" represents and should
 * not guess a colour for it.
 */
export function phaseState(name: string): PhaseState {
  switch (name.trim().toLowerCase()) {
    case 'coding':
      return 'coding';
    case 'architecting':
      return 'architecting';
    case 'wireframes':
      return 'wireframes';
    case 'planning':
      return 'planning';
    default:
      return 'other';
  }
}

/** A phase is complete only at exactly 1. `null` is unknown, and unknown is not done. */
export function isComplete(phase: Phase): boolean {
  return phase.progress === 1;
}

export type Basis =
  /** Something has started and is not finished. The common case. */
  | 'in-progress'
  /** Nothing has started yet; the state shown is the next thing due. */
  | 'upcoming'
  /** Every non-structural phase is at 100%. */
  | 'complete'
  /** There is work, but none of it has dates. */
  | 'unscheduled'
  /** No non-structural phases at all. */
  | 'empty';

export interface LaneVerdict {
  state: PhaseState;
  basis: Basis;
  /** The phase the verdict came from, so the UI can name it. Null for empty lanes. */
  driver: Phase | null;
  /** Earliest start across dated phases, or null. */
  start: string | null;
  /** Latest end across dated phases, or null. */
  end: string | null;
  /** Non-structural phases that carry no start and no end. */
  unscheduledCount: number;
  /** Non-structural phases in total. */
  realCount: number;
  /**
   * Mean progress across non-structural phases that HAVE a recorded progress.
   * Null when none of them do. Deliberately not treating null as zero: Net Worth
   * has three phases with no progress recorded, and averaging them in as 0 would
   * report a project as 12% done when the truthful answer is "we do not know".
   */
  progress: number | null;
  /** How many non-structural phases had no progress recorded. Qualifies `progress`. */
  progressUnknownCount: number;
}

/**
 * Reduce a project's phases to the one state its collapsed lane should show.
 *
 * The rules, in order:
 *
 *  1. Structural phases (Maintenance) never decide the colour. They are ongoing
 *     support, carry no dates by construction, and would otherwise paint every
 *     finished project grey forever.
 *  2. Among incomplete phases that have STARTED - start is on or before `today` -
 *     take the highest-ranked. This is "in progress" and is what the lane usually
 *     shows.
 *  3. If nothing has started, take the incomplete phase with the EARLIEST start.
 *     Highest-ranked would be wrong here: for a project whose work is all ahead of
 *     it, the useful answer is what happens next, not what happens furthest away.
 *  4. If there are incomplete phases but none of them have dates at all, the lane is
 *     unscheduled - a state to draw, not a blank.
 *  5. Everything non-structural at 100% is complete.
 */
export function laneVerdict(phases: Phase[], today: string): LaneVerdict {
  const real = phases.filter((p) => !p.structural);

  const dated = real.filter((p) => p.start !== null || p.end !== null);
  const starts = dated.map((p) => p.start).filter((d): d is string => d !== null);
  const ends = dated.map((p) => p.end).filter((d): d is string => d !== null);

  const known = real.filter((p) => p.progress !== null);
  const progress = known.length
    ? known.reduce((sum, p) => sum + (p.progress ?? 0), 0) / known.length
    : null;

  const base = {
    start: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null,
    end: ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : null,
    unscheduledCount: real.filter((p) => p.start === null && p.end === null).length,
    realCount: real.length,
    progress,
    progressUnknownCount: real.length - known.length,
  };

  if (real.length === 0) {
    return { state: 'other', basis: 'empty', driver: null, ...base };
  }

  const incomplete = real.filter((p) => !isComplete(p));
  if (incomplete.length === 0) {
    return { state: 'other', basis: 'complete', driver: null, ...base };
  }

  const started = incomplete.filter((p) => p.start !== null && p.start <= today);
  if (started.length > 0) {
    const driver = highestRanked(started);
    return { state: phaseState(driver.name), basis: 'in-progress', driver, ...base };
  }

  const scheduled = incomplete.filter((p) => p.start !== null);
  if (scheduled.length > 0) {
    // Earliest start; ties broken by phase_order so the answer is stable rather
    // than dependent on however the API happened to sort the list.
    const driver = scheduled.reduce((a, b) => {
      if (a.start === b.start) {
        return a.phase_order <= b.phase_order ? a : b;
      }
      return (a.start as string) < (b.start as string) ? a : b;
    });
    return { state: phaseState(driver.name), basis: 'upcoming', driver, ...base };
  }

  return { state: 'other', basis: 'unscheduled', driver: null, ...base };
}

function highestRanked(phases: Phase[]): Phase {
  return phases.reduce((best, candidate) => {
    const bestRank = STATE_RANK[phaseState(best.name)];
    const rank = STATE_RANK[phaseState(candidate.name)];
    if (rank !== bestRank) {
      return rank > bestRank ? candidate : best;
    }
    // Same rank: the one that started earlier is the one further along.
    if (best.start && candidate.start && best.start !== candidate.start) {
      return candidate.start < best.start ? candidate : best;
    }
    return best.phase_order <= candidate.phase_order ? best : candidate;
  });
}

/** One-line explanation of a verdict, shown under the lane name and in the tooltip. */
export function describeVerdict(verdict: LaneVerdict): string {
  switch (verdict.basis) {
    case 'in-progress':
      return `${verdict.driver?.name} under way`;
    case 'upcoming':
      return `${verdict.driver?.name} starts next`;
    case 'complete':
      return 'All phases complete';
    case 'unscheduled':
      return 'No dates set';
    case 'empty':
      return 'No phases yet';
  }
}
