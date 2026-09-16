/**
 * How the roadmap's lane list is arranged for viewing: the sort, and the split that
 * moves finished projects into their own section.
 *
 * BOTH OF THESE ARE VIEW-ONLY AND NEITHER IS STORED
 * -------------------------------------------------
 * `lane_order` is the roadmap's real, saved arrangement - it is the workbook's own row
 * order and the thing Reorder writes. Everything here sits on top of that and changes
 * only what the current reader sees. Sorting by name does not renumber anybody, and a
 * project moving into the complete section has not been archived: `active` is a
 * separate, stored fact meaning somebody retired the lane, and nothing here touches it.
 *
 * That separation is why sorting and reordering cannot both be on at once. "Move up"
 * means "give this a lower lane_order", and while the list on screen is ordered by
 * something else - name, progress - the arrows would move a row to a position it does
 * not visibly occupy. The page disables Reorder unless the sort is `roadmap`, and this
 * module's job is to make that condition expressible rather than implicit.
 *
 * WHY "COMPLETE" IS laneVerdict's ANSWER AND NOT A NEW ONE
 * -------------------------------------------------------
 * `laneVerdict` already decides what state a lane is in, it is already tested, and its
 * `basis: 'complete'` already means "every non-structural phase is at 100%". A second
 * definition here - all phases ended, or mean progress at 1 - would be a second answer
 * to the same question, and the two would disagree the first time a project had a
 * Maintenance band or a phase with no progress recorded. Maintenance is exactly the
 * case that makes this subtle: it is ongoing support that never finishes, so counting
 * it would mean no project is ever complete.
 */

import type { Project } from '../types';
import { laneVerdict } from './phaseState';

export type SortMode = 'roadmap' | 'name' | 'start' | 'end' | 'progress';

export interface SortOption {
  mode: SortMode;
  label: string;
  /** Shown as the select's title, so the tie-breaks and the null rule are discoverable. */
  description: string;
}

/**
 * The offered sorts, in the order they appear in the picker.
 *
 * `roadmap` is first and is the default because it is the only one that matches what
 * is stored - everyone who has the roadmap in their head has it in that order, and a
 * screen that opens sorted by something else silently disagrees with every printout
 * and every conversation about "the third lane down".
 */
export const SORT_OPTIONS: readonly SortOption[] = [
  {
    mode: 'roadmap',
    label: 'Roadmap order',
    description: 'The saved order. The only sort in which lanes can be rearranged.',
  },
  { mode: 'name', label: 'Name', description: 'A to Z.' },
  {
    mode: 'start',
    label: 'Starts first',
    description: 'Earliest start date first. Undated projects last.',
  },
  {
    mode: 'end',
    label: 'Ends first',
    description: 'Earliest end date first. Undated projects last.',
  },
  {
    mode: 'progress',
    label: 'Least progress',
    description: 'Least complete first. Projects with no recorded progress last.',
  },
];

/** The stored arrangement, which is also the tie-break for every other sort. */
function byRoadmap(a: Project, b: Project): number {
  return a.lane_order - b.lane_order || a.name.localeCompare(b.name);
}

/**
 * Compare two values where null means "not recorded" and must sort LAST.
 *
 * Not treated as zero or as the epoch, in either direction. A project with no dates is
 * not starting in 1970 and is not at 0% - the honest position for an unknown is after
 * everything known, so that sorting by start date never claims an undated project is
 * the most urgent thing on the board. This mirrors laneVerdict's own refusal to average
 * unrecorded progress in as zero.
 */
function nullsLast<T extends string | number>(a: T | null, b: T | null): number | null {
  if (a === null && b === null) {
    return null; // Both unknown: fall through to the caller's tie-break.
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return null; // Both known: the caller compares them.
}

/**
 * Arrange lanes for display. Pure, and never mutates the input.
 *
 * `today` is threaded through because laneVerdict needs it to decide what has started.
 * It is a parameter rather than read from the clock here so the result is a function of
 * its inputs and can be tested without freezing time.
 */
export function sortLanes(projects: Project[], mode: SortMode, today: string): Project[] {
  const list = [...projects];

  if (mode === 'roadmap') {
    return list.sort(byRoadmap);
  }

  if (mode === 'name') {
    return list.sort((a, b) => a.name.localeCompare(b.name) || byRoadmap(a, b));
  }

  // One verdict per project, computed once rather than inside the comparator, which
  // would recompute it O(n log n) times per lane.
  const verdicts = new Map(projects.map((p) => [p.project_id, laneVerdict(p.phases, today)]));

  return list.sort((a, b) => {
    const va = verdicts.get(a.project_id);
    const vb = verdicts.get(b.project_id);

    if (mode === 'progress') {
      const unknown = nullsLast(va?.progress ?? null, vb?.progress ?? null);
      if (unknown !== null) {
        return unknown;
      }
      const diff = (va?.progress ?? 0) - (vb?.progress ?? 0);
      return diff || byRoadmap(a, b);
    }

    const key = mode === 'start' ? 'start' : 'end';
    const unknown = nullsLast(va?.[key] ?? null, vb?.[key] ?? null);
    if (unknown !== null) {
      return unknown;
    }
    // ISO day strings, so a string compare IS a date compare.
    return (va?.[key] ?? '').localeCompare(vb?.[key] ?? '') || byRoadmap(a, b);
  });
}

export interface LaneSplit {
  /** Everything still in flight, in the order given. */
  live: Project[];
  /** Every non-structural phase at 100%. Drawn in its own section below. */
  complete: Project[];
}

/**
 * Split the lanes into what is still running and what has finished.
 *
 * Order within each half is preserved exactly, so this composes with sortLanes rather
 * than competing with it - sort first, then split, and both sections come out in the
 * chosen order.
 *
 * A project with NO phases at all is not complete. laneVerdict calls that `empty`, and
 * treating an empty lane as finished would file every newly created project under
 * "done" the moment it was added, before anybody had a chance to plan it.
 */
export function splitComplete(projects: Project[], today: string): LaneSplit {
  const live: Project[] = [];
  const complete: Project[] = [];

  for (const project of projects) {
    if (laneVerdict(project.phases, today).basis === 'complete') {
      complete.push(project);
    } else {
      live.push(project);
    }
  }

  return { live, complete };
}

/*
  ---------------------------------------------------------------- grouping

  The third view-only arrangement, and the same rule applies: nothing here is stored
  and nothing here renumbers anybody. `category` is a stored field on the project, but
  whether the roadmap is currently drawn grouped by it is a choice the reader makes.
*/

/** The heading shown over projects that have not been filed under anything. */
export const UNGROUPED = 'Everything else';

export interface LaneGroup {
  /** The category, or UNGROUPED. Drawn as the heading. */
  category: string;
  projects: Project[];
}

/**
 * Split an already-sorted list into runs, one per category.
 *
 * Takes the list AFTER sortLanes rather than sorting it itself, so grouping composes
 * with whichever sort is on rather than overriding it: grouped-and-by-progress means
 * each category's lanes are ordered by progress, which is what somebody who picked
 * both would expect. Doing the sort in here would quietly make the sort control a
 * no-op while grouping was on.
 *
 * GROUP ORDER IS FIRST APPEARANCE, NOT ALPHABETICAL. The incoming order is already
 * the answer to "how should these be arranged" - it is either the team's own
 * lane_order or the sort they chose - and alphabetising the headings on top of it
 * would put "App" above "QC" for a reason nobody asked for, and would move a whole
 * group the first time somebody renamed a category.
 *
 * UNGROUPED IS ALWAYS LAST, which is the one exception to that rule. A group headed
 * "Everything else" above three named ones reads as a filing failure at the top of the
 * page; below them it reads as the remainder, which is what it is. It is also the pile
 * that shrinks as people file things, so it is the one that should not be in the way.
 */
export function groupLanes(projects: Project[]): LaneGroup[] {
  const groups = new Map<string, Project[]>();

  for (const project of projects) {
    // Trimmed on the way in by the API, so this is only guarding against a stored
    // value from before that validator existed.
    const category = (project.category ?? '').trim() || UNGROUPED;
    const existing = groups.get(category);
    if (existing) {
      existing.push(project);
    } else {
      groups.set(category, [project]);
    }
  }

  const named: LaneGroup[] = [];
  let leftovers: LaneGroup | null = null;
  for (const [category, list] of groups) {
    const group = { category, projects: list };
    if (category === UNGROUPED) {
      leftovers = group;
    } else {
      named.push(group);
    }
  }

  return leftovers ? [...named, leftovers] : named;
}

/**
 * Whether grouping would show anything, which is whether anybody has filed anything.
 *
 * Used to decide whether to offer the control at all. A "Group by category" toggle on
 * a roadmap where every project is uncategorised does exactly one thing - draw one
 * heading reading "Everything else" over the whole list - and offering it is a promise
 * of an arrangement the data cannot deliver.
 */
export function hasCategories(projects: Project[]): boolean {
  return projects.some((p) => (p.category ?? '').trim().length > 0);
}
