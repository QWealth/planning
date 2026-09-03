/**
 * Naming a project when the project may not be there any more.
 *
 * Every page that shows work attached to a project has to answer the same awkward
 * question: what do you call a `project_id` that no longer matches a project? The
 * roadmap's lanes can be deleted, and the work table does not cascade - by design,
 * because a task does not stop existing when the lane it was filed under does.
 *
 * The answer used to be spelled out in four places, drifting. It is here once, and
 * the reason it is not simply "" is worth keeping written down: a task attached to a
 * deleted project and a task attached to nothing are DIFFERENT FACTS, and the second
 * is a normal, deliberate state this whole feature exists to represent. Rendering a
 * blank for both makes the deliberate case look like data loss and the data loss look
 * deliberate.
 */

import type { Project } from '../types';

/** What a `project_id` with no project behind it is called, in one place. */
export function unknownProjectLabel(projectId: string): string {
  return `Unknown project (${projectId})`;
}

/**
 * A project's name, or null when the work is attached to nothing.
 *
 * A linear scan, deliberately: the caller is a page showing ONE item and the list is
 * nine lanes long. `decorate` in utils/tasks.ts indexes into a Map instead, because it
 * runs once per row and that is the shape where the difference matters.
 */
export function resolveProjectName(
  projectId: string | null | undefined,
  projects: readonly Project[]
): string | null {
  if (!projectId) {
    return null;
  }
  return (
    projects.find((project) => project.project_id === projectId)?.name ??
    unknownProjectLabel(projectId)
  );
}

export interface ProjectGroup<T> {
  /** null for the unattached section. */
  projectId: string | null;
  title: string;
  items: T[];
}

/**
 * Group anything carrying a `project_id` into sections, in the roadmap's own order.
 *
 * This started life inside groupRfcs and moved here the moment the board needed the
 * same sections. Three of its four rules are decisions rather than mechanics, and each
 * one fails invisibly - by showing fewer rows, or the right rows in the wrong order -
 * so two copies of them drifting apart was only a matter of time.
 *
 * UNATTACHED GOES FIRST, and that is deliberate. "How we do code review", or a task
 * belonging to no lane, is the case that could not be represented at all before the
 * work table existed - there was no project to file it under. Those rows also have no
 * other route to them: a project's work can eventually be surfaced on its lane,
 * whereas a cross-cutting item is only ever reachable from a list like this. Burying
 * them under nine project headings hides exactly what the feature was asked for.
 *
 * The section is OMITTED when empty rather than drawn as a heading with nothing under
 * it, which reads as a failed load.
 *
 * AN ITEM WHOSE PROJECT NO LONGER EXISTS IS STILL SHOWN, under its raw id. Projects
 * are soft-deleted and drop out of the roadmap, and there are no foreign keys in
 * DynamoDB, so a stored project_id can outlive the row it points at. The tempting
 * implementation - build a map of known projects and iterate that - silently drops
 * those items from the only page that lists them, with nothing on screen to say
 * anything is missing. Iterating the ITEMS and looking projects up is what keeps every
 * one of them reachable.
 *
 * ORDER WITHIN a section is the input's own, untouched. The sections themselves are
 * ordered by lane_order - the projects array's index, as served - so they match the
 * chart's top-to-bottom order. Alphabetical would put these headings in a different
 * order from the roadmap's rows, and the two are read one tab apart.
 */
export function groupByProject<T>(
  items: readonly T[],
  projects: readonly Project[],
  projectIdOf: (item: T) => string | null | undefined,
  unattachedTitle: string
): ProjectGroup<T>[] {
  const names = new Map(projects.map((project) => [project.project_id, project.name]));
  const order = new Map(projects.map((project, index) => [project.project_id, index]));

  const unattached: T[] = [];
  const byProject = new Map<string, T[]>();

  for (const item of items) {
    const projectId = projectIdOf(item);
    if (!projectId) {
      unattached.push(item);
      continue;
    }
    const bucket = byProject.get(projectId);
    if (bucket) {
      bucket.push(item);
    } else {
      byProject.set(projectId, [item]);
    }
  }

  const attached: ProjectGroup<T>[] = [...byProject.entries()]
    .map(([projectId, group]) => ({
      projectId,
      // A project that has been deleted still needs a heading, and its id is the only
      // honest thing left to call it.
      title: names.get(projectId) ?? unknownProjectLabel(projectId),
      items: group,
    }))
    .sort((a, b) => {
      // Unknown projects sort LAST rather than to position 0, which is where a missing
      // lane_order would otherwise put them - above every real project.
      const left = order.get(a.projectId as string) ?? Number.MAX_SAFE_INTEGER;
      const right = order.get(b.projectId as string) ?? Number.MAX_SAFE_INTEGER;
      return left - right || a.title.localeCompare(b.title);
    });

  return unattached.length
    ? [{ projectId: null, title: unattachedTitle, items: unattached }, ...attached]
    : attached;
}

/**
 * Whether this person is answerable for this project.
 *
 * DRI **or** Support, and the "or" is the decision. A Support is not a spectator: the
 * pair exists so that no lane has a single point of failure, and utils/assignments.ts
 * records both roles even when one person holds both, for exactly that reason. A view
 * that opened only your DRI lanes would hide half of what you are on the hook for,
 * which is the half you are most likely to have forgotten about.
 *
 * Owning a PHASE inside the project deliberately does not count. That is a dated piece
 * of work with a bar of its own, and it is answered by the Team page's per-person
 * chart; this question is about the lane, not about a stretch of it.
 *
 * Compared lower-cased, because these are addresses rather than keys - the same
 * normalisation ProjectEditor applies on the way in and assignmentsByPerson applies on
 * the way out. A null email is nobody: an unauthenticated view is not responsible for
 * anything, and neither is an unfilled DRI field, so a null-to-null match must not
 * count as agreement.
 */
export function isResponsibleFor(project: Project, email: string | null | undefined): boolean {
  if (!email) {
    return false;
  }
  const mine = email.toLowerCase();
  return (
    (project.dri_email ?? '').toLowerCase() === mine ||
    (project.support_email ?? '').toLowerCase() === mine
  );
}

/**
 * The ids of the projects this person is answerable for.
 *
 * A Set rather than a list because every caller asks "is this one mine" once per row
 * while rendering, and because that is the shape the pages' `expanded` state already
 * has - see RoadmapPage, which seeds it from this directly.
 */
export function responsibleProjectIds(
  projects: readonly Project[],
  email: string | null | undefined
): Set<string> {
  return new Set(
    projects.filter((project) => isResponsibleFor(project, email)).map((p) => p.project_id)
  );
}

export interface ProjectOption {
  value: string;
  label: string;
}

/**
 * The options a project `<select>` should offer, given what the row currently holds.
 *
 * WHY THE CURRENT VALUE IS PASSED IN
 * ----------------------------------
 * Because of a failure that is invisible until somebody saves. A select whose value
 * matches none of its options reports `selectedIndex: -1` and draws EMPTY - while
 * React Hook Form, which keeps its own copy of the value rather than reading the DOM,
 * still holds the dead id and will happily submit it.
 *
 * So the field silently claims the task is attached to nothing, the form silently
 * disagrees, and the only way to notice is to read the request. Adding an option for
 * the value actually held closes that gap: the select shows the truth, and changing it
 * to something real becomes a visible, deliberate edit that marks the field dirty.
 *
 * It is appended LAST rather than sorted in, for the reason utils/rfcs.ts sorts
 * unknown groups last: a dead id is not a choice anybody is looking for, and putting
 * it among the live names is how it gets picked by accident.
 */
export function projectOptions(
  projects: readonly Project[],
  currentId: string | null | undefined,
  unattachedLabel: string
): ProjectOption[] {
  const options: ProjectOption[] = [
    // First, and a real answer rather than a placeholder. Labelled rather than blank
    // so it does not read as "you have not picked one yet".
    { value: '', label: unattachedLabel },
    ...projects.map((project) => ({ value: project.project_id, label: project.name })),
  ];

  if (currentId && !projects.some((project) => project.project_id === currentId)) {
    options.push({ value: currentId, label: unknownProjectLabel(currentId) });
  }

  return options;
}
