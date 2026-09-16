/**
 * Tests for arranging the roadmap's lane list.
 *
 * Two rules carry most of the weight here and both are about honesty rather than
 * ordering: an unknown value sorts LAST rather than being read as zero or as the epoch,
 * and "complete" is laneVerdict's answer rather than a second definition invented for
 * the section heading. The Maintenance case is the one that would break a naive
 * implementation - it is ongoing support with no dates, so a project carrying one is
 * still complete when its real work is done.
 */

import { describe, expect, it } from 'vitest';

import type { Phase, Project } from '../types';
import { UNGROUPED, groupLanes, hasCategories, sortLanes, splitComplete } from './laneView';

const TODAY = '2026-08-27';

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

function proj(name: string, lane_order: number, phases: Phase[] = []): Project {
  return {
    project_id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    lane_order,
    dri_email: null,
    support_email: null,
    active: true,
    created_at: null,
    updated_at: null,
    phases,
    milestones: [],
  };
}

const names = (list: Project[]) => list.map((p) => p.name);

describe('sortLanes', () => {
  it('roadmap order is lane_order, with name as the tie-break', () => {
    const list = [proj('Zeta', 2), proj('Alpha', 1), proj('Beta', 1)];
    expect(names(sortLanes(list, 'roadmap', TODAY))).toEqual(['Alpha', 'Beta', 'Zeta']);
  });

  it('never mutates the array it is given', () => {
    // The page holds this list in state and passes it straight in; an in-place sort
    // would reorder the source and make the next render disagree with the last.
    const list = [proj('Zeta', 2), proj('Alpha', 1)];
    sortLanes(list, 'name', TODAY);
    expect(names(list)).toEqual(['Zeta', 'Alpha']);
  });

  it('sorts by name', () => {
    const list = [proj('Qfeed', 0), proj('D2', 1), proj('Net Worth', 2)];
    expect(names(sortLanes(list, 'name', TODAY))).toEqual(['D2', 'Net Worth', 'Qfeed']);
  });

  it('sorts by earliest start', () => {
    const list = [
      proj('Late', 0, [ph('2026-09-01', '2026-10-01', 0.2)]),
      proj('Early', 1, [ph('2026-07-01', '2026-08-01', 0.2)]),
    ];
    expect(names(sortLanes(list, 'start', TODAY))).toEqual(['Early', 'Late']);
  });

  it('sorts by earliest end', () => {
    const list = [
      proj('Ends later', 0, [ph('2026-07-01', '2026-12-01', 0.2)]),
      proj('Ends sooner', 1, [ph('2026-07-01', '2026-09-01', 0.2)]),
    ];
    expect(names(sortLanes(list, 'end', TODAY))).toEqual(['Ends sooner', 'Ends later']);
  });

  it('puts undated projects LAST when sorting by date, not first', () => {
    /*
      The rule that matters. Treating a missing start as the epoch would file the one
      project nobody has scheduled at the very top of a list sorted by urgency, which
      reads as "this is the next thing happening" - the opposite of what is known.
    */
    const list = [
      proj('Undated', 0, [ph(null, null, 0.5)]),
      proj('Dated', 1, [ph('2026-09-01', '2026-10-01', 0.5)]),
    ];
    expect(names(sortLanes(list, 'start', TODAY))).toEqual(['Dated', 'Undated']);
    expect(names(sortLanes(list, 'end', TODAY))).toEqual(['Dated', 'Undated']);
  });

  it('sorts by least progress, with unrecorded progress last', () => {
    // Same rule as the dates: "we have not recorded this" is not "0% done", and
    // sorting it to the front would put it where the most urgent lane belongs.
    const list = [
      proj('Half', 0, [ph('2026-07-01', '2026-10-01', 0.5)]),
      proj('Unknown', 1, [ph('2026-07-01', '2026-10-01', null)]),
      proj('Barely', 2, [ph('2026-07-01', '2026-10-01', 0.1)]),
    ];
    expect(names(sortLanes(list, 'progress', TODAY))).toEqual(['Barely', 'Half', 'Unknown']);
  });

  it('breaks every tie with the roadmap order, so the result is stable', () => {
    // Without an explicit tie-break the order of equal rows is the input order, which
    // changes as the page refetches - lanes would shuffle on every save.
    const list = [
      proj('Third', 3, [ph('2026-07-01', '2026-10-01', 0.5)]),
      proj('First', 1, [ph('2026-07-01', '2026-10-01', 0.5)]),
      proj('Second', 2, [ph('2026-07-01', '2026-10-01', 0.5)]),
    ];
    expect(names(sortLanes(list, 'progress', TODAY))).toEqual(['First', 'Second', 'Third']);
  });
});

describe('splitComplete', () => {
  it('separates finished lanes from running ones', () => {
    const done = proj('Done', 0, [ph('2026-06-01', '2026-07-01', 1)]);
    const running = proj('Running', 1, [ph('2026-07-01', '2026-10-01', 0.4)]);

    const split = splitComplete([done, running], TODAY);
    expect(names(split.complete)).toEqual(['Done']);
    expect(names(split.live)).toEqual(['Running']);
  });

  it('a Maintenance band does not keep a finished project out of the complete list', () => {
    /*
      The case that breaks the obvious implementation. Maintenance is structural,
      ongoing, and carries no dates by construction, so "every phase at 100%" or "every
      phase has ended" would report this lane as unfinished forever. laneVerdict already
      excludes structural phases, which is exactly why this defers to it.
    */
    const project = proj('Shipped', 0, [
      ph('2026-06-01', '2026-07-01', 1),
      ph(null, null, null, true),
    ]);
    expect(names(splitComplete([project], TODAY).complete)).toEqual(['Shipped']);
  });

  it('one unfinished phase is enough to keep a lane running', () => {
    const project = proj('Nearly', 0, [
      ph('2026-06-01', '2026-07-01', 1),
      ph('2026-07-01', '2026-08-01', 0.9),
    ]);
    expect(names(splitComplete([project], TODAY).live)).toEqual(['Nearly']);
  });

  it('a project with no phases is NOT complete', () => {
    // Otherwise every newly created lane is filed under "done" before anybody has had
    // the chance to plan it, which is where it would then be overlooked.
    const project = proj('Brand new', 0, []);
    expect(names(splitComplete([project], TODAY).live)).toEqual(['Brand new']);
    expect(split0(project)).toEqual([]);
  });

  it('preserves the order it is given, so it composes with sortLanes', () => {
    // Sort first, then split. If this re-sorted, choosing "Name" would silently
    // reorder only one of the two sections.
    const list = sortLanes(
      [
        proj('Zeta done', 9, [ph('2026-06-01', '2026-07-01', 1)]),
        proj('Alpha done', 8, [ph('2026-06-01', '2026-07-01', 1)]),
        proj('Beta running', 7, [ph('2026-07-01', '2026-10-01', 0.4)]),
      ],
      'name',
      TODAY
    );
    const split = splitComplete(list, TODAY);
    expect(names(split.complete)).toEqual(['Alpha done', 'Zeta done']);
    expect(names(split.live)).toEqual(['Beta running']);
  });

  it('does not confuse complete with archived', () => {
    // `active` is a stored decision somebody made; completeness is computed from the
    // phases. A retired lane that never finished must not appear under "Complete".
    const retired = { ...proj('Retired', 0, [ph('2026-07-01', '2026-10-01', 0.3)]), active: false };
    expect(names(splitComplete([retired], TODAY).live)).toEqual(['Retired']);
  });
});

/** Helper for the empty-project case above. */
function split0(project: Project): Project[] {
  return splitComplete([project], TODAY).complete;
}

describe('groupLanes', () => {
  /** A project filed under a category. `proj` leaves it unset. */
  const filed = (name: string, order: number, category: string | null): Project => ({
    ...proj(name, order),
    category,
  });

  it('puts lanes sharing a category under one group', () => {
    const groups = groupLanes([
      filed('QWAPP', 0, 'App'),
      filed('Qfeed', 1, 'Data'),
      filed('QWAPP Expansion Packs', 2, 'App'),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['App', 'Data']);
    expect(groups[0].projects.map((p) => p.name)).toEqual([
      'QWAPP',
      'QWAPP Expansion Packs',
    ]);
  });

  it('orders groups by first appearance, not alphabetically', () => {
    // The incoming order is already the answer to "how should these be arranged" -
    // either lane_order or the sort somebody chose. Alphabetising the headings on top
    // of it would move a whole group the first time anybody renamed a category.
    const groups = groupLanes([filed('Z', 0, 'Zebra'), filed('A', 1, 'Apple')]);
    expect(groups.map((g) => g.category)).toEqual(['Zebra', 'Apple']);
  });

  it('preserves the incoming order within a group', () => {
    // Grouping composes with the sort rather than overriding it: grouped-and-by-name
    // means each category's lanes are ordered by name.
    const groups = groupLanes([
      filed('B', 0, 'App'),
      filed('A', 1, 'App'),
    ]);
    expect(groups[0].projects.map((p) => p.name)).toEqual(['B', 'A']);
  });

  it('puts unfiled lanes last, under one heading', () => {
    // "Everything else" above three named groups reads as a filing failure at the top
    // of the page; below them it reads as the remainder, which is what it is.
    const groups = groupLanes([
      filed('Loose', 0, null),
      filed('QWAPP', 1, 'App'),
      filed('Also loose', 2, '   '),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['App', UNGROUPED]);
    expect(groups[1].projects.map((p) => p.name)).toEqual(['Loose', 'Also loose']);
  });

  it('loses nobody', () => {
    const projects = [
      filed('a', 0, 'App'),
      filed('b', 1, null),
      filed('c', 2, 'Data'),
      filed('d', 3, 'App'),
    ];
    const seen = groupLanes(projects).flatMap((g) => g.projects.map((p) => p.name));
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles an empty roadmap', () => {
    expect(groupLanes([])).toEqual([]);
  });
});

describe('hasCategories', () => {
  it('is false when nobody has filed anything', () => {
    // A "Group by category" toggle here would draw one heading over the whole list,
    // which is a promise of an arrangement the data cannot deliver.
    expect(hasCategories([proj('A', 0), proj('B', 1)])).toBe(false);
  });

  it('ignores whitespace-only categories', () => {
    expect(hasCategories([{ ...proj('A', 0), category: '  ' }])).toBe(false);
  });

  it('is true as soon as one lane is filed', () => {
    expect(hasCategories([proj('A', 0), { ...proj('B', 1), category: 'Data' }])).toBe(true);
  });
});
