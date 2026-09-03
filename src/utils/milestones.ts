/**
 * Milestones, reduced to the marks a lane should draw.
 *
 * A milestone is a moment something is due, not a piece of work - so it is not a bar
 * and it does not carry progress. The chart draws it as a diamond above the lane's
 * bar, which raises the two questions this module answers: WHICH milestones can be
 * drawn at all, and what does each one MEAN today.
 *
 * WHAT GETS DRAWN
 * ---------------
 * Only the dated ones. `date` is nullable on purpose - "there has to be a beta launch
 * and nobody has committed to when" is a real state the API stores rather than
 * refusing - and there is no honest place on a time axis to put a thing with no time.
 * Dropping them silently would be the workbook's own failure mode, so they are
 * counted and surfaced instead: `undatedMilestones` here, and the lane's tooltip names
 * them. The gaps report used to carry the same count as `undated_milestones`; it has
 * been removed, so these two are now the only places an undated milestone is
 * announced.
 *
 * DONE IS NOT DERIVED FROM THE DATE
 * ---------------------------------
 * The three statuses are `done`, `missed` and `due`, and `missed` only exists because
 * doneness is stored rather than inferred. A milestone past its date and not marked
 * done is a commitment that slipped, which is the single most useful thing this whole
 * feature can tell anyone. Inferring "it is in the past, so it happened" would report
 * every slipped deadline as an achievement.
 *
 * A done milestone stays drawn, and stays on its original date. It is history: moving
 * it or hiding it would lose the record that the date was met.
 *
 * MARKS CLUSTER BY DATE
 * ---------------------
 * Two milestones on one day are one mark, because two diamonds at the same percentage
 * are one diamond with another invisible underneath it - data hidden by geometry,
 * which is exactly what this app exists to stop. The cluster takes the most urgent
 * status among its members, so a missed deadline cannot be concealed by a completed
 * one sharing its date, and the renderer prints the count next to it.
 *
 * UNDER A PHASE, OR UNDER THE LANE
 * --------------------------------
 * A milestone may name the phase it belongs to, and may name none. `placeMilestones`
 * answers where each one is listed when the lane is opened; the COLLAPSED lane
 * deliberately does not care, because a diamond's position is its date and a date
 * does not change by being filed under Infra.
 */

import type { Milestone, Phase } from '../types';
import { formatLong } from './dates';

export type MilestoneStatus =
  /** Marked done. Finished business, whatever the date says. */
  | 'done'
  /** Its date has passed and it is NOT done. A slipped commitment. */
  | 'missed'
  /** Still ahead, or due today. */
  | 'due';

/** How loudly a status speaks. A cluster shows the highest. */
const URGENCY: Record<MilestoneStatus, number> = {
  missed: 2,
  due: 1,
  done: 0,
};

/** One diamond on a lane: everything due on a single day. */
export interface MilestoneMark {
  /** Inclusive ISO day. Every milestone in the cluster carries exactly this date. */
  date: string;
  /** The milestones falling on it, most urgent first. Usually one. */
  milestones: Milestone[];
  /** The most urgent status among them. */
  status: MilestoneStatus;
}

/**
 * What a milestone means as of `today`.
 *
 * `done` is checked before the date, which is the whole point: a milestone that was
 * met is met, and one that was not is missed no matter how long ago it was due.
 */
export function milestoneStatus(milestone: Milestone, today: string): MilestoneStatus {
  if (milestone.done) {
    return 'done';
  }
  // Due today is not yet missed - there is a working day left to hit it, and marking
  // it red at midnight would cry wolf on every deadline the moment it arrived.
  if (milestone.date !== null && milestone.date < today) {
    return 'missed';
  }
  return 'due';
}

/** The ones with no date. Not drawable, so they are reported rather than dropped. */
export function undatedMilestones(milestones: Milestone[]): Milestone[] {
  return milestones.filter((m) => m.date === null);
}

/** Every date a milestone sits on, so the chart's span can be widened to hold them. */
export function milestoneDates(milestones: Milestone[]): string[] {
  return milestones.map((m) => m.date).filter((d): d is string => d !== null);
}

/**
 * Dated milestones, clustered by day and ordered along the axis.
 *
 * Chronological rather than by urgency: these are positions on a time axis, and the
 * render order is also the DOM order, so sorting by anything else would make the
 * tab order of a row jump about the chart.
 */
export function laneMilestones(milestones: Milestone[], today: string): MilestoneMark[] {
  const byDate = new Map<string, Milestone[]>();
  for (const milestone of milestones) {
    if (milestone.date === null) {
      continue;
    }
    const existing = byDate.get(milestone.date);
    if (existing) {
      existing.push(milestone);
    } else {
      byDate.set(milestone.date, [milestone]);
    }
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, members]) => {
      const ordered = [...members].sort(
        (a, b) =>
          URGENCY[milestoneStatus(b, today)] - URGENCY[milestoneStatus(a, today)] ||
          a.name.localeCompare(b.name)
      );
      return {
        date,
        milestones: ordered,
        status: milestoneStatus(ordered[0], today),
      };
    });
}

/**
 * A lane's milestones in the order they should be listed: by date, undated last.
 *
 * Matches the order the API already returns (ProjectDetail sorts milestones by date),
 * which is the point of it existing on the client at all. A milestone added or
 * re-dated through a form comes back from a single POST or PATCH, not from a fresh
 * roadmap fetch, so it has to be re-sorted into place locally or the expanded lane
 * shows the new row at the bottom and jumps it into position on the next refresh.
 *
 * Undated ones sort LAST rather than first, even though an empty string would sort
 * first. They are the ones needing an answer, but a list of deadlines reads
 * chronologically and burying the agreed dates under the unagreed ones would make the
 * common reading harder to serve the rarer one - which the "still to decide" panel
 * already serves properly.
 */
export function sortMilestones(milestones: Milestone[]): Milestone[] {
  return [...milestones].sort((a, b) => {
    if (a.date === b.date) {
      return a.name.localeCompare(b.name);
    }
    if (a.date === null) {
      return 1;
    }
    if (b.date === null) {
      return -1;
    }
    return a.date.localeCompare(b.date);
  });
}

/** Where each of a lane's milestones gets listed when the lane is opened. */
export interface MilestonePlacement {
  /** phase_id -> the milestones filed under it, sorted. Only phases that have any. */
  byPhase: Map<string, Milestone[]>;
  /** The ones listed against the lane itself, sorted. */
  onLane: Milestone[];
}

/**
 * Split a lane's milestones into the ones that sit under a phase and the rest.
 *
 * A milestone MAY name the phase it belongs to and may name none, and both are
 * ordinary: "Infra hardening signed off" is a moment inside Infra, while "Regulatory
 * deadline" is a date the whole lane answers to and is not a step in any one stage of
 * it. So this returns two things rather than one grouping, and the caller draws the
 * attached ones directly beneath their phase and the unattached ones under the lane.
 *
 * A MILESTONE WHOSE PHASE IS NOT IN THIS LIST FALLS BACK TO THE LANE
 * ------------------------------------------------------------------
 * It is not dropped, and the reason is the same one that keeps a subtask with a
 * dangling parent_id on the board: the server has already decided. Deleting a phase
 * detaches its milestones rather than deleting them, so a phase_id in hand that
 * matches no phase means this payload is stale - and the lane is where the row is
 * about to end up anyway. Filtering it out instead would make a commitment vanish
 * from the only screen that lists it, which is the failure this app exists to end.
 *
 * Sorted with sortMilestones on both sides, so a milestone attached through the form
 * lands in date order under its new phase without waiting for a refetch.
 */
export function placeMilestones(
  milestones: Milestone[],
  phases: readonly Phase[]
): MilestonePlacement {
  const known = new Set(phases.map((phase) => phase.phase_id));
  const byPhase = new Map<string, Milestone[]>();
  const onLane: Milestone[] = [];

  for (const milestone of milestones) {
    const phaseId = milestone.phase_id;
    if (!phaseId || !known.has(phaseId)) {
      onLane.push(milestone);
      continue;
    }
    const existing = byPhase.get(phaseId);
    if (existing) {
      existing.push(milestone);
    } else {
      byPhase.set(phaseId, [milestone]);
    }
  }

  for (const [phaseId, group] of byPhase) {
    byPhase.set(phaseId, sortMilestones(group));
  }
  return { byPhase, onLane: sortMilestones(onLane) };
}

/**
 * How many individual milestones on this lane are missed deadlines.
 *
 * Counted over milestones rather than over marks: two deadlines blown on the same day
 * are two broken commitments, even though they are drawn as one diamond.
 */
export function missedCount(marks: MilestoneMark[], today: string): number {
  return marks.reduce(
    (total, mark) =>
      total + mark.milestones.filter((m) => milestoneStatus(m, today) === 'missed').length,
    0
  );
}

/** A full sentence for one milestone, for a tooltip and for a screen reader. */
export function describeMilestone(milestone: Milestone, today: string): string {
  if (milestone.date === null) {
    return `${milestone.name} — no date set${milestone.done ? ', done' : ''}`;
  }
  switch (milestoneStatus(milestone, today)) {
    case 'done':
      return `${milestone.name} — done, was due ${formatLong(milestone.date)}`;
    case 'missed':
      return `${milestone.name} — MISSED, was due ${formatLong(milestone.date)}`;
    case 'due':
      return `${milestone.name} — due ${formatLong(milestone.date)}`;
  }
}

/** A full sentence for a whole cluster. */
export function describeMark(mark: MilestoneMark, today: string): string {
  if (mark.milestones.length === 1) {
    return describeMilestone(mark.milestones[0], today);
  }
  const names = mark.milestones.map((m) => m.name).join(', ');
  return `${mark.milestones.length} milestones on ${formatLong(mark.date)}: ${names}`;
}
