/**
 * Turning a flat list of tasks into the columns the board draws.
 *
 * Pure and separate from the page for the reason every util here is: there is no
 * jsdom in this project, so a function extracted here can be tested and one left
 * inside a component cannot. This file earns it twice over — the parent/child split
 * and the closed-status filter each fail silently when they are wrong, by showing
 * fewer rows rather than by throwing.
 *
 * WHY THE BOARD GROUPS BY STATUS AND NOT BY TICKET
 * ------------------------------------------------
 * A subtask carries its own status, independent of its ticket's. That is the whole
 * reason subtasks exist rather than being a checklist inside a body field: "write the
 * migration" can be done while the ticket around it is still in progress.
 *
 * Group by ticket and every one of those independent statuses gets buried a level
 * down, so the board stops answering the only question a board is for — what is
 * being worked on right now. In-progress subtasks would sit inside a collapsed
 * backlog ticket, invisible, while the column that should hold them reads empty.
 *
 * Grouping by status inverts that cost: subtasks are scattered away from their
 * siblings. That is real, and it is why `parentTitle` exists — each subtask row says
 * what it belongs to, so the context is on the row instead of in the layout. The
 * ticket's own page is where the family is shown together.
 */

import type { Project, StatusInfo, Task } from '../types';
import { groupByProject, responsibleProjectIds, unknownProjectLabel } from './projects';

export interface TaskColumn {
  status: string;
  label: string;
  description: string;
  closed: boolean;
  tasks: Task[];
}

/** A task plus the bits of context the row needs, resolved once rather than per render. */
export interface TaskRow {
  task: Task;
  /** The owning ticket's title, or null for a top-level ticket. */
  parentTitle: string | null;
  /** The project's name, or null when unattached. Deleted projects keep their id. */
  projectName: string | null;
  /** How many subtasks this ticket has. Always 0 for a subtask — the cap is one level. */
  subtaskCount: number;
  /** How many of those are closed. `2 of 5 done` on the row. */
  subtasksClosed: number;
}

/**
 * Index the vocabulary once. Returned rather than rebuilt at each call site so that
 * "is this status closed" has exactly one answer per render.
 */
function closedSet(statuses: readonly StatusInfo[]): Set<string> {
  return new Set(statuses.filter((entry) => entry.closed).map((entry) => entry.status));
}

/**
 * Decorate tasks with the context their rows need.
 *
 * A subtask whose parent is missing keeps `parentTitle: null` and is therefore drawn
 * as a ticket. That is the honest rendering rather than a bug to hide: the backend
 * promotes children when their parent is deleted, so a dangling parent_id in hand
 * means this list is stale, and showing the row at the top level is what the server
 * has already decided. The alternative — filtering it out because the parent lookup
 * missed — makes work disappear from the only page that lists it.
 */
export function decorate(
  tasks: readonly Task[],
  projects: readonly Project[],
  statuses: readonly StatusInfo[]
): Map<string, TaskRow> {
  const closed = closedSet(statuses);
  const projectNames = new Map(projects.map((project) => [project.project_id, project.name]));
  const titles = new Map(tasks.map((task) => [task.item_id, task.title]));

  const childCount = new Map<string, number>();
  const childClosed = new Map<string, number>();
  for (const task of tasks) {
    if (!task.parent_id) {
      continue;
    }
    childCount.set(task.parent_id, (childCount.get(task.parent_id) ?? 0) + 1);
    if (closed.has(task.status)) {
      childClosed.set(task.parent_id, (childClosed.get(task.parent_id) ?? 0) + 1);
    }
  }

  const rows = new Map<string, TaskRow>();
  for (const task of tasks) {
    rows.set(task.item_id, {
      task,
      parentTitle: task.parent_id ? titles.get(task.parent_id) ?? null : null,
      projectName: task.project_id
        ? // A project that has been deleted. The id is the only honest thing left to
          // call it, and saying so beats rendering nothing where a name should be.
          projectNames.get(task.project_id) ?? unknownProjectLabel(task.project_id)
        : null,
      subtaskCount: childCount.get(task.item_id) ?? 0,
      subtasksClosed: childClosed.get(task.item_id) ?? 0,
    });
  }
  return rows;
}

/**
 * Split tasks into one column per status, in the vocabulary's own order.
 *
 * COLUMNS COME FROM THE SERVED VOCABULARY, not from a list here, so a sixth status is
 * one backend deploy. They are emitted even when empty — a board with no "In
 * progress" column looks like a board that failed to load, whereas an empty column
 * under a heading is a fact about the week.
 *
 * A task whose status this build has never heard of is NOT dropped. It goes into a
 * trailing column of its own, named by its raw value. The alternative is a row that
 * exists in the table, is returned by the API, and appears nowhere on screen — which
 * is the failure mode a frontend running behind its backend would otherwise have.
 */
export function toColumns(
  tasks: readonly Task[],
  statuses: readonly StatusInfo[]
): TaskColumn[] {
  const known = new Map(statuses.map((entry) => [entry.status, entry]));
  const buckets = new Map<string, Task[]>(statuses.map((entry) => [entry.status, []]));

  for (const task of tasks) {
    const bucket = buckets.get(task.status);
    if (bucket) {
      bucket.push(task);
    } else {
      buckets.set(task.status, [task]);
    }
  }

  return [...buckets.entries()].map(([status, group]) => {
    const entry = known.get(status);
    return {
      status,
      label: entry?.label ?? status,
      description: entry?.description ?? '',
      // An unknown status is treated as OPEN, matching the RFC list: defaulting to
      // closed would hide the rows behind a toggle nobody knows to press.
      closed: entry?.closed ?? false,
      tasks: group,
    };
  });
}

/**
 * The columns a section should actually draw.
 *
 * TWO KINDS OF EMPTY COLUMN, AND ONLY ONE IS WORTH DRAWING
 * --------------------------------------------------------
 * An empty "In progress" is a fact about the week - nobody is on anything - and it is
 * drawn, because a board missing a column looks like a board that failed to load.
 *
 * An empty "Done" while closed work is hidden is not a fact about anything. It is
 * guaranteed empty by the toggle, and drawing it spends a fifth of the board's width
 * restating what the "Show N closed" button already says. So the closed columns are
 * dropped while the toggle is off, and come back with it.
 *
 * Filtered on the COLUMN's own `closed` flag rather than on a list of names here, so a
 * sixth status added server-side lands on the correct side of this automatically. An
 * unknown status is flagged open and therefore always shown - which is what we want,
 * since the alternative is a row nobody can find.
 */
export function visibleColumns(
  tasks: readonly Task[],
  statuses: readonly StatusInfo[],
  showClosed: boolean
): TaskColumn[] {
  const all = toColumns(tasks, statuses);
  return showClosed ? all : all.filter((column) => !column.closed);
}

/** One project's worth of the board. */
export interface TaskGroup {
  /** null for the section holding work attached to no project. */
  projectId: string | null;
  title: string;
  tasks: Task[];
}

/**
 * Split the board into one section per project, in the roadmap's own lane order.
 *
 * The ordering, the unattached-first rule and the deleted-project case all live in
 * groupByProject, shared with the RFC list so the two pages cannot come to disagree
 * about what order the projects go in.
 *
 * GROUPED ON THE TASK'S OWN project_id, NOT ITS PARENT'S
 * -----------------------------------------------------
 * A subtask carries its own project_id and it is allowed to differ from its ticket's,
 * or to be absent while the ticket has one. Inheriting the parent's would invent an
 * attachment nobody typed, and - worse - it would disagree with the project filter in
 * the toolbar, which reads `task.project_id` directly. A filter and a heading that
 * answer the same question differently is the kind of thing people discover by
 * noticing a task is missing.
 *
 * The visible consequence is that a subtask can appear under a different banner from
 * its ticket. `parentTitle` on the card is what pays for that, exactly as it pays for
 * grouping by status: the row says what it belongs to, so the context is on the card
 * rather than in the layout.
 */
export function groupTasks(
  tasks: readonly Task[],
  projects: readonly Project[]
): TaskGroup[] {
  return groupByProject(tasks, projects, (task) => task.project_id, 'Not tied to a project').map(
    ({ projectId, title, items }) => ({ projectId, title, tasks: items })
  );
}

/**
 * The React key, and the collapsed-state key, for one section.
 *
 * A function rather than `section.projectId ?? '_unattached'` inline, because the
 * board now keeps a Set of open sections keyed by this and the two spellings have to
 * agree exactly - a mismatch would show as a disclosure arrow that turns without the
 * section opening.
 *
 * The sentinel is prefixed with an underscore, which no `prj_` id can collide with.
 */
export function groupKey(projectId: string | null): string {
  return projectId ?? '_unattached';
}

/**
 * Which sections of the board should start open.
 *
 * THE RULE IS "WHAT AM I ON THE HOOK FOR", NOT "WHAT AM I DRI OF"
 * ---------------------------------------------------------------
 * Three things open a section, and each is a different sense of the same word:
 *
 * - you are DRI or Support on the project - see isResponsibleFor in utils/projects.ts;
 * - you OWN at least one task in it. On a board this matters more than the lane's
 *   roles do: a card with your address on it is work assigned to you personally, and a
 *   board that hid it behind a chevron would be hiding the one thing you came for.
 *   It also keeps "filter by owner: me" honest - without this, filtering to your own
 *   tasks would leave every section shut, which reads as no results;
 * - the UNATTACHED section, always. It has no project and therefore no DRI, so no rule
 *   about responsibility can ever open it, and cross-cutting work is the case that had
 *   no home at all before the work table existed - the same argument groupByProject
 *   makes for listing it first.
 *
 * Everything else starts collapsed, which is the point: nine sections of five columns
 * is a page nobody scrolls to the bottom of.
 *
 * Signed out, or before /api/me answers, only the unattached section opens. The pages
 * seed this ONCE identity is known rather than on every render, so that state is not a
 * flash of a nearly-empty board - see TasksPage.
 */
export function defaultOpenGroups(
  groups: readonly TaskGroup[],
  projects: readonly Project[],
  email: string | null | undefined
): Set<string> {
  const mine = responsibleProjectIds(projects, email);
  const owner = email ? email.toLowerCase() : null;

  const open = new Set<string>();
  for (const group of groups) {
    const owns =
      owner !== null &&
      group.tasks.some((task) => (task.owner_email ?? '').toLowerCase() === owner);
    if (group.projectId === null || owns || mine.has(group.projectId)) {
      open.add(groupKey(group.projectId));
    }
  }
  return open;
}

/**
 * Which of these tasks an "assign all to X" would actually change.
 *
 * Extracted so the button can say how many rows it is about to write, and so the
 * no-op case - everything already owned by that person - is a fact the page can read
 * rather than something it discovers after firing N requests.
 *
 * Already-owned rows are skipped rather than re-sent. Every write is an audit row, and
 * a PATCH setting owner_email to the value it already holds is a log entry recording
 * that nothing happened.
 */
export function tasksToAssign(tasks: readonly Task[], ownerEmail: string): Task[] {
  return tasks.filter((task) => task.owner_email !== ownerEmail);
}

/**
 * The board's filters, applied in one place.
 *
 * `projectId` of `undefined` means "no project filter". `null` is a real, different
 * answer — "show me only the work attached to nothing" — and the two must not
 * collapse, because unattached work is the case this whole feature exists to make
 * representable and is precisely the thing somebody will want to look at alone.
 */
export interface TaskFilter {
  projectId?: string | null;
  ownerEmail?: string;
  showClosed: boolean;
}

export function filterTasks(
  tasks: readonly Task[],
  statuses: readonly StatusInfo[],
  filter: TaskFilter
): Task[] {
  const closed = closedSet(statuses);

  return tasks.filter((task) => {
    if (!filter.showClosed && closed.has(task.status)) {
      return false;
    }
    if (filter.projectId !== undefined && (task.project_id ?? null) !== filter.projectId) {
      return false;
    }
    if (filter.ownerEmail && task.owner_email !== filter.ownerEmail) {
      return false;
    }
    return true;
  });
}

/**
 * Every task that belongs to one ticket, in a stable order.
 *
 * Sorted by `task_order` then by creation, NOT by status. A ticket's page is the one
 * place the family is shown together, and reordering it as statuses change would
 * move rows around under the cursor of somebody working down the list.
 */
export function subtasksOf(tasks: readonly Task[], parentId: string): Task[] {
  return tasks
    .filter((task) => task.parent_id === parentId)
    .sort(
      (a, b) =>
        a.task_order - b.task_order ||
        (a.created_at ?? '').localeCompare(b.created_at ?? '') ||
        a.item_id.localeCompare(b.item_id)
    );
}

/**
 * The tickets a task may be filed under, given the one-level cap.
 *
 * Excludes anything that is already a subtask (it cannot take children), and excludes
 * the task itself (it cannot be its own parent). Also excludes any ticket that would
 * be an illegal move for THIS task specifically: a ticket that already has subtasks
 * of its own cannot be given a parent, so when `task` has children the only legal
 * answer is "no parent" and the list comes back empty.
 *
 * The backend enforces all three; this exists so the select does not offer a choice
 * that is going to come back as a 400.
 */
export function eligibleParents(tasks: readonly Task[], task: Task | null): Task[] {
  if (task && tasks.some((other) => other.parent_id === task.item_id)) {
    return [];
  }
  return tasks.filter(
    (other) => !other.parent_id && other.item_id !== task?.item_id
  );
}

/**
 * Is this date in the past, relative to today?
 *
 * Compared as `YYYY-MM-DD` STRINGS, never as Date objects. `new Date('2026-08-13')`
 * parses as midnight UTC while `new Date()` is local, so in Canada the two differ by
 * enough to call today's date overdue for the first several hours of every morning —
 * the same UTC trap documented for the chart in utils/dates.ts, arrived at from a
 * different direction. Lexicographic comparison of ISO dates is exact and needs no
 * timezone at all.
 */
export function isOverdue(due: string | null, today: string): boolean {
  return Boolean(due) && (due as string) < today;
}

/** Today as `YYYY-MM-DD` in the viewer's own timezone, for comparison with `due`. */
export function todayISO(now: Date = new Date()): string {
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
