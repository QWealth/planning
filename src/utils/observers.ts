/**
 * Who is on the team, and who is only watching.
 *
 * The roster answers "who could pick this up". Somebody from operations, product or
 * compliance is on the roster because they have a login and a row, but they are never
 * the answer to that question, and listing them among the engineers makes the list
 * longer without making it more useful. So they move to a section of their own below.
 *
 * TWO CONDITIONS, AND BOTH MATTER
 * -------------------------------
 * An observer is somebody whose ONLY role is `outside-engineering` AND who holds
 * nothing. Either condition alone is not enough, and the reasons differ:
 *
 *   the sole-role part   A person who ticked "Outside engineering" *and* "BA" is a BA.
 *                        The roles picker is additive - it says "pick as many as
 *                        apply" - so treating any single tick as decisive would let a
 *                        second, more specific answer silently demote somebody out of
 *                        the roster. The narrower claim wins because it is the one
 *                        that carries information.
 *
 *   the holds-nothing    This is the safety condition, and it is the important one. If
 *   part                 somebody from outside engineering really is DRI of a lane,
 *                        hiding them below the fold would make that lane look
 *                        unowned - the chart would be silent about accountability that
 *                        genuinely exists. A role is a description of a person; it is
 *                        never allowed to conceal work. So work always wins: hold
 *                        something and you stay on the roster and on the chart,
 *                        whatever your role says.
 *
 * The second condition also makes this change compose with what the Team page already
 * does rather than fighting it. The chart independently drops everybody holding
 * nothing, so every observer was already absent from the chart before this existed -
 * which means moving them cannot remove a single bar. All that changes is which list
 * their name appears in underneath.
 *
 * "Holds nothing" is read off the person's own PersonWorkload counts, the same three
 * numbers the roster row draws its DRI / Support / phases chips from. Deliberately not
 * the chart's separate assignments map: the row and its placement must agree, and a
 * person shown with no chips who was nonetheless kept out of the observers list would
 * be inexplicable to somebody reading the page.
 */

import type { PersonWorkload } from '../types';

/** The catch-all role. Matches `Role.OUTSIDE_ENGINEERING` in fast/app/roles.py. */
export const OUTSIDE_ENGINEERING = 'outside-engineering';

/**
 * Does this person carry anything at all?
 *
 * Maintenance bands count, via `owned_phase_count` - carrying ongoing support is real
 * load, and somebody whose whole job is keeping a thing alive is not an observer.
 */
export function holdsNothing(person: PersonWorkload): boolean {
  return (
    person.dri_project_ids.length === 0 &&
    person.support_project_ids.length === 0 &&
    person.owned_phase_count === 0
  );
}

/**
 * Both conditions. See the header for why it is both and not either.
 *
 * Note the sole-role test is on length, so somebody with no roles at all is NOT an
 * observer - an empty `roles` is the workbook-seeded state, meaning "nobody recorded
 * this", and quietly reclassifying those people would turn missing data into a claim.
 */
export function isObserver(person: PersonWorkload): boolean {
  return (
    person.roles.length === 1 &&
    person.roles[0] === OUTSIDE_ENGINEERING &&
    holdsNothing(person)
  );
}

/** The other role that is never an answer to "who could take this". */
export const LEADERSHIP = 'leadership';

/**
 * Sole-role leadership, holding nothing.
 *
 * Deliberately the SAME SHAPE as isObserver - sole role, and the holds-nothing safety
 * condition - because it is the same claim about a different role, and two rules that
 * mean "not staffable" should not be written two different ways. A leader who is DRI
 * of a lane stays on the schedule, for exactly the reason in the header: a role
 * describes a person and is never allowed to conceal work.
 *
 * It does NOT make somebody an observer. Leadership is a delivery role - it belongs on
 * the roster with the team, not in the watching-from-outside section. The distinction
 * only matters to the schedule, which is a picture of capacity: a row of empty weeks
 * against somebody whose job is direction rather than delivery reads as spare capacity
 * that is not there.
 */
export function isLeadershipOnly(person: PersonWorkload): boolean {
  return (
    person.roles.length === 1 && person.roles[0] === LEADERSHIP && holdsNothing(person)
  );
}

/**
 * Does the schedule draw a row for this person?
 *
 * Everybody does, including people holding nothing - that emptiness is the answer to
 * "who is free", which is half of what the chart is for, and dropping those rows meant
 * the one question the chart could not answer was the one people opened it to ask.
 *
 * The two exceptions are the roles that are never the answer to "who could take this":
 * somebody watching from outside engineering, and somebody whose only role is
 * leadership. Both are on the roster, and both would otherwise show as a person with
 * a year of free time.
 */
export function schedulable(person: PersonWorkload): boolean {
  return !isObserver(person) && !isLeadershipOnly(person);
}

export interface RosterSplit {
  /** The team: everybody who is staffable or is carrying something. */
  roster: PersonWorkload[];
  /** Watching: sole-role outside-engineering, holding nothing. */
  observers: PersonWorkload[];
}

/**
 * Split the roster in two, preserving the incoming order in both halves.
 *
 * Order is preserved rather than re-sorted because the caller has already sorted -
 * re-sorting here would silently override that and the two lists would disagree about
 * what "first" means.
 */
export function splitObservers(people: PersonWorkload[]): RosterSplit {
  const roster: PersonWorkload[] = [];
  const observers: PersonWorkload[] = [];
  for (const person of people) {
    (isObserver(person) ? observers : roster).push(person);
  }
  return { roster, observers };
}
