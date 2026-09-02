/**
 * Tests for moving a lane up and down the roadmap.
 *
 * The case worth pinning hardest is the duplicate lane_order, because it is the whole
 * reason laneOrderChanges renumbers instead of swapping. Nothing has ever enforced
 * uniqueness on that field, the stored data was seeded from a spreadsheet, and a swap
 * of two equal numbers is a Move up button that silently does nothing.
 *
 * `npm test` from the repo root.
 */

import { describe, expect, it } from 'vitest';

import { canMove, laneOrderChanges, moveLane, type Ordered } from './laneOrder';

function project(project_id: string, lane_order: number): Ordered {
  return { project_id, lane_order };
}

/**
 * Apply a change set and re-sort exactly as the app does, so a test can assert the
 * order the user ends up looking at rather than only the payload that was sent.
 *
 * The tiebreak on project_id stands in for the tiebreak on name in RoadmapPage and
 * list_projects; the ids here are single letters chosen so the two agree.
 */
function applied(projects: readonly Ordered[], changes: readonly Ordered[]): string[] {
  const moved = new Map(changes.map((c) => [c.project_id, c.lane_order]));
  return [...projects]
    .map((p) => ({ ...p, lane_order: moved.get(p.project_id) ?? p.lane_order }))
    .sort((a, b) => a.lane_order - b.lane_order || a.project_id.localeCompare(b.project_id))
    .map((p) => p.project_id);
}

describe('moveLane', () => {
  const order = ['a', 'b', 'c'];

  it('swaps a project with the one above it', () => {
    expect(moveLane(order, 'b', -1)).toEqual(['b', 'a', 'c']);
  });

  it('swaps a project with the one below it', () => {
    expect(moveLane(order, 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('leaves the first project alone rather than wrapping it to the bottom', () => {
    expect(moveLane(order, 'a', -1)).toEqual(order);
  });

  it('leaves the last project alone rather than wrapping it to the top', () => {
    expect(moveLane(order, 'c', 1)).toEqual(order);
  });

  it('ignores a project that is not in the list', () => {
    expect(moveLane(order, 'gone', -1)).toEqual(order);
  });

  it('does not mutate the list it was given', () => {
    const original = ['a', 'b', 'c'];
    moveLane(original, 'b', -1);
    expect(original).toEqual(['a', 'b', 'c']);
  });
});

describe('canMove', () => {
  const order = ['a', 'b', 'c'];

  it('is false at the top and true below it', () => {
    expect(canMove(order, 'a', -1)).toBe(false);
    expect(canMove(order, 'b', -1)).toBe(true);
  });

  it('is false at the bottom and true above it', () => {
    expect(canMove(order, 'c', 1)).toBe(false);
    expect(canMove(order, 'b', 1)).toBe(true);
  });

  it('is false for a project that is not in the list', () => {
    expect(canMove(order, 'gone', 1)).toBe(false);
  });

  it('is false in both directions for a list of one', () => {
    expect(canMove(['only'], 'only', -1)).toBe(false);
    expect(canMove(['only'], 'only', 1)).toBe(false);
  });
});

describe('laneOrderChanges', () => {
  it('writes nothing when the order already matches the stored numbers', () => {
    const projects = [project('a', 0), project('b', 1), project('c', 2)];
    expect(laneOrderChanges(['a', 'b', 'c'], projects)).toEqual([]);
  });

  it('writes only the two lanes a single swap actually moved', () => {
    const projects = [project('a', 0), project('b', 1), project('c', 2)];
    // One PATCH per changed row, and 'c' has not moved, so it is not rewritten -
    // otherwise a one-lane nudge leaves an audit row against every project.
    const changes = laneOrderChanges(['b', 'a', 'c'], projects);
    expect(changes).toEqual([
      { project_id: 'b', lane_order: 0 },
      { project_id: 'a', lane_order: 1 },
    ]);
    expect(applied(projects, changes)).toEqual(['b', 'a', 'c']);
  });

  it('renumbers a sparse order densely, which is the first save on seeded data', () => {
    // The workbook seed used the spreadsheet's own row numbers, so gaps are normal.
    const projects = [project('a', 10), project('b', 20), project('c', 30)];
    expect(laneOrderChanges(['a', 'b', 'c'], projects)).toEqual([
      { project_id: 'a', lane_order: 0 },
      { project_id: 'b', lane_order: 1 },
      { project_id: 'c', lane_order: 2 },
    ]);
  });

  it('moves lanes that share a lane_order, which a swap could not', () => {
    // THE CASE THIS FUNCTION EXISTS FOR. Two lanes both on 0 are separated only by
    // the name tiebreak, so the chart shows a, b. Swapping their stored orders writes
    // 0 and 0 again and the row does not move: a Move up button that does nothing,
    // with nothing on screen to say why.
    //
    // Renumbering leaves b on the 0 it already had - so b is not rewritten - and
    // gives a the 1 that puts it below. Two rows written, and only one of them is a
    // lane the user pointed at.
    const projects = [project('a', 0), project('b', 0), project('c', 1)];
    const changes = laneOrderChanges(['b', 'a', 'c'], projects);
    expect(changes).toEqual([
      { project_id: 'a', lane_order: 1 },
      { project_id: 'c', lane_order: 2 },
    ]);
    expect(applied(projects, changes)).toEqual(['b', 'a', 'c']);
  });

  it('skips an id it has no stored project for', () => {
    // A lane deleted in another tab. There is no honest number to send for a row we
    // never read, and writing one would stamp an order onto it sight unseen.
    const projects = [project('a', 0), project('c', 1)];
    expect(laneOrderChanges(['a', 'gone', 'c'], projects)).toEqual([
      { project_id: 'c', lane_order: 2 },
    ]);
  });

  it('handles an empty roadmap', () => {
    expect(laneOrderChanges([], [])).toEqual([]);
  });
});
