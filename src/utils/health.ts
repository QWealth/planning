/**
 * Whether a project is ahead, on track, at risk or late.
 *
 * WHY THIS EXISTS ALONGSIDE laneVerdict
 * -------------------------------------
 * `laneVerdict` answers "what kind of work is happening" - Coding, Planning, Testing -
 * and the collapsed lane's dot used to be coloured by it. That is a real fact and it is
 * on screen twice over: the bar segments are already coloured by phase, and the
 * sub-label already says "Coding under way". Spending the one high-contrast mark on the
 * left of every row to repeat it was the waste.
 *
 * The question a roadmap is actually opened to answer is "which of these is in
 * trouble", and nothing on the page answered it. This does.
 *
 * THE COMPARISON, AND WHY IT IS TIME AGAINST PROGRESS
 * ---------------------------------------------------
 * A project that is 40% through its calendar and 40% done is on track. One that is 80%
 * through its calendar and 40% done is not. That is the whole rule: elapsed fraction of
 * the project's own span, against the mean progress recorded across its phases.
 *
 * It uses the lane's OWN dates rather than a shared horizon, so a two-week project and
 * a nine-month one are judged on the same terms. And it uses laneVerdict's `progress`
 * rather than recomputing, because that mean already excludes structural Maintenance
 * bands and already refuses to treat "not recorded" as zero - see its note. Two
 * definitions of "how far along is this" would disagree the first time somebody added a
 * Maintenance band.
 *
 * UNKNOWN IS A STATE, AND IT IS THE IMPORTANT ONE
 * -----------------------------------------------
 * A lane with no progress recorded anywhere cannot be judged, and saying so is the
 * point rather than a gap. Colouring it "on track" would be an invention, and it is the
 * common case: several lanes came across the migration with no progress on any phase.
 * A roadmap that quietly reports unmeasured work as healthy is worse than one that
 * admits it does not know, because the second can be fixed by recording something.
 *
 * THE THRESHOLDS ARE A STEP OF THE SCALE, NOT A FEELING
 * -----------------------------------------------------
 * Progress is entered in tenths - the Slack modal offers 0, 10 … 100 and the web form
 * the same - so ±10% is one step, which is within the noise of how precisely anybody
 * actually knows. AHEAD therefore needs a clear step in hand, and AT RISK two, because
 * the cost of the two calls is not symmetric: a project wrongly called ahead is
 * ignored, and a project wrongly called at risk is merely looked at.
 */

import type { Project } from '../types';
import { laneVerdict, type LaneVerdict } from './phaseState';

export type Health =
  /** Every non-structural phase at 100%. */
  | 'complete'
  /** Past its end date and not finished. The one state that needs no arithmetic. */
  | 'late'
  /** Meaningfully behind where the calendar says it should be. */
  | 'at-risk'
  /** Within a step of the calendar, either way. */
  | 'on-track'
  /** Meaningfully further along than the calendar requires. */
  | 'ahead'
  /** Scheduled, but its start is still in the future. */
  | 'not-started'
  /** No dates, or no progress recorded anywhere. Cannot be judged. */
  | 'unknown';

/** A full step of the scale in hand. See the note on thresholds. */
const AHEAD_BY = 0.1;
/** Two steps behind. Deliberately not symmetric with AHEAD_BY. */
const BEHIND_BY = 0.2;

export interface HealthVerdict {
  health: Health;
  /** 0..1, how far through its own span the project is today. Null without dates. */
  elapsed: number | null;
  /** 0..1 mean recorded progress, straight from laneVerdict. Null when unrecorded. */
  progress: number | null;
  /** progress - elapsed, when both are known. The number the call is made on. */
  delta: number | null;
}

/** Days between two ISO days. Both are plain dates, so no timezone can intrude. */
function days(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
}

/**
 * How far through its own span the project is, 0..1.
 *
 * Null when it has no dates at all. A single-day project - start equal to end - is
 * treated as fully elapsed once today reaches it rather than dividing by zero.
 */
export function elapsedFraction(
  start: string | null,
  end: string | null,
  today: string
): number | null {
  if (!start || !end) {
    return null;
  }
  if (today < start) {
    return 0;
  }
  if (today >= end) {
    return 1;
  }
  const span = days(start, end);
  if (span <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, days(start, today) / span));
}

/**
 * The health of one lane, from a verdict already computed.
 *
 * Takes the verdict rather than the phases so the caller cannot end up with a health
 * reading and a state reading derived from two different passes over the same lane.
 */
export function healthOf(verdict: LaneVerdict, today: string): HealthVerdict {
  const elapsed = elapsedFraction(verdict.start, verdict.end, today);
  const progress = verdict.progress;
  const delta = elapsed === null || progress === null ? null : progress - elapsed;

  const base = { elapsed, progress, delta };

  if (verdict.basis === 'complete') {
    return { health: 'complete', ...base };
  }

  // Ordered before the unknown check on purpose. A lane whose end date has passed with
  // work outstanding is late whether or not anybody recorded a percentage - the date
  // said when, and the date has gone.
  if (verdict.end !== null && today > verdict.end) {
    return { health: 'late', ...base };
  }

  if (verdict.basis === 'empty' || verdict.basis === 'unscheduled' || elapsed === null) {
    return { health: 'unknown', ...base };
  }

  // Scheduled and not begun. Not "on track" - there is nothing yet to be on track
  // with - and not a problem either.
  if (verdict.start !== null && today < verdict.start) {
    return { health: 'not-started', ...base };
  }

  if (progress === null || delta === null) {
    return { health: 'unknown', ...base };
  }

  if (delta >= AHEAD_BY) {
    return { health: 'ahead', ...base };
  }
  if (delta <= -BEHIND_BY) {
    return { health: 'at-risk', ...base };
  }
  return { health: 'on-track', ...base };
}

/** The whole thing for a project, for callers that have not computed a verdict. */
export function projectHealth(project: Project, today: string): HealthVerdict {
  return healthOf(laneVerdict(project.phases, today), today);
}

/** How each state reads in the lane's label and in the key. */
export const HEALTH_LABEL: Record<Health, string> = {
  complete: 'Complete',
  late: 'Late',
  'at-risk': 'At risk',
  'on-track': 'On track',
  ahead: 'Ahead',
  'not-started': 'Not started',
  unknown: 'No reading',
};

/**
 * The sentence under the lane name, which says WHY rather than repeating the label.
 *
 * "At risk" beside a red dot is the dot twice. The useful half is the arithmetic behind
 * it - 40% done, 80% of the way through - because that is what somebody would have to
 * work out for themselves before they could disagree with it.
 */
export function describeHealth(verdict: HealthVerdict): string {
  const { health, elapsed, progress } = verdict;
  if (health === 'complete') {
    return 'Every phase at 100%';
  }
  if (health === 'unknown') {
    return progress === null ? 'No progress recorded' : 'No dates to judge against';
  }
  if (health === 'not-started') {
    return 'Not started yet';
  }
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const done = progress === null ? 'progress not recorded' : `${pct(progress)} done`;
  if (elapsed === null) {
    return done;
  }
  if (health === 'late') {
    return `${done}, past its end date`;
  }
  return `${done}, ${pct(elapsed)} of the way through`;
}
