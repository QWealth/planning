/**
 * Moving a project up or down the roadmap.
 *
 * `lane_order` has existed on the project row since the workbook seed - it IS the
 * workbook's own row order, and both the backend (list_projects) and the chart sort
 * by it. What has never existed is a way to change it: ProjectEditor sets it once, on
 * create, to one past the current maximum, and nothing has been able to touch it
 * since. So the order everyone reads the roadmap in has been frozen at whatever order
 * the spreadsheet happened to have in July, and a project that has become the most
 * important thing on the board still sits seventh.
 *
 * THE ORDER IS RENUMBERED TO THE ARRAY INDEX, NOT SWAPPED
 * ------------------------------------------------------
 * The obvious implementation of "move up" is to swap the two lanes' lane_order values,
 * and it is wrong here for a reason the stored data will actually hit: lane_order
 * carries no uniqueness constraint. Nothing has ever enforced one - see the
 * nextLaneOrder note in RoadmapPage, which knowingly tolerates a collision with an
 * archived lane - and the sort breaks ties by name. Two lanes sharing an order is
 * therefore a state that exists, and swapping equal values is a no-op: the user
 * clicks Move up, the row does not move, and there is nothing on screen to explain
 * why.
 *
 * Renumbering the whole visible list to 0..n-1 cannot fail that way. It also
 * self-heals - after one save the orders are dense and distinct - and it makes the
 * stored number mean exactly what the screen shows, rather than being a sparse
 * sequence whose gaps nobody can account for.
 *
 * It is deliberately computed over the VISIBLE list, which is the active lanes only,
 * because that is the list the person is looking at and reasoning about. An archived
 * lane keeps whatever order it had and can therefore collide with a renumbered active
 * one. That is the same collision RoadmapPage already tolerates, for the same reason:
 * the cost is two lanes adjacent in an unexpected order, and only if somebody restores
 * an archived lane, against the cost of fetching and rewriting rows nobody asked to
 * touch.
 */

/** The minimum a caller has to know about a project for either function below. */
export interface Ordered {
  project_id: string;
  lane_order: number;
}

/** One row to write: this project should store this lane_order. */
export interface LaneOrderChange {
  project_id: string;
  lane_order: number;
}

/**
 * Move one project one place up (-1) or down (+1), returning the new id order.
 *
 * A move at either end returns the list unchanged rather than wrapping around. A lane
 * that jumped from the bottom of the roadmap to the top because somebody pressed the
 * button once too often is a surprising edit to have to undo, and "already first" is
 * better expressed by disabling the control - which is what `canMove` is for.
 *
 * An unknown id is also returned unchanged rather than throwing: the only way to get
 * one is a lane deleted in another tab between render and click, and a dead button is
 * a kinder answer there than a crashed page.
 */
export function moveLane(
  order: readonly string[],
  projectId: string,
  delta: -1 | 1
): string[] {
  const from = order.indexOf(projectId);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= order.length) {
    return [...order];
  }
  const next = [...order];
  next[from] = next[to];
  next[to] = projectId;
  return next;
}

/** Whether the control should be live, so the button can say so by being disabled. */
export function canMove(
  order: readonly string[],
  projectId: string,
  delta: -1 | 1
): boolean {
  const from = order.indexOf(projectId);
  const to = from + delta;
  return from !== -1 && to >= 0 && to < order.length;
}

/**
 * The rows that actually have to be written, given a desired id order.
 *
 * Only the projects whose stored lane_order differs from their new index are
 * returned, so the common case - one lane nudged one place - is two PATCHes rather
 * than one per lane. That matters beyond tidiness: every PATCH writes an audit row,
 * and rewriting ten unchanged lanes would put ten "updated the project" entries in the
 * history of a change that moved one thing.
 *
 * The first save on data seeded from the workbook may well rewrite everything, because
 * those orders came across sparse. That is correct and happens once.
 *
 * A project in `order` that is not in `projects` is skipped. There is no honest
 * lane_order to send for a row we do not have, and inventing one would write a number
 * over a lane we never read.
 */
export function laneOrderChanges(
  order: readonly string[],
  projects: readonly Ordered[]
): LaneOrderChange[] {
  const stored = new Map(projects.map((p) => [p.project_id, p.lane_order]));
  const changes: LaneOrderChange[] = [];
  order.forEach((projectId, index) => {
    if (!stored.has(projectId)) {
      return;
    }
    if (stored.get(projectId) !== index) {
      changes.push({ project_id: projectId, lane_order: index });
    }
  });
  return changes;
}
