/**
 * The roadmap chart: a stack of project lanes on the shared canvas.
 *
 * The heading row, the gridline/today overlay and the today flag used to live here
 * and now live in ChartCanvas, because the Team page draws people on the same grid
 * and the alignment reasoning behind that overlay is not something to keep two copies
 * of. What is left is what is genuinely about projects: the lane stack, the anchor
 * ids other panels scroll to, and the empty state.
 */

import { useMemo, useState } from 'react';
import styled from 'styled-components';

import { palette, radius } from '../../styles/theme';
import { type Grid } from '../../utils/dates';
import { UNGROUPED, groupLanes, type LaneGroup } from '../../utils/laneView';
import type { Milestone, Person, Phase, Project, ProjectPatch, Task } from '../../types';
import ChartCanvas from './ChartCanvas';
import Lane from './Lane';

/**
 * The real groups, plus any that have been created but are still empty.
 *
 * Empties go just above "Everything else" rather than at the very end, because that
 * group is the remainder and should stay the last thing on the page - and a new group
 * is a place somebody is about to file things into, which is more useful next to the
 * pile they will be filing FROM.
 */
function withEmpties(groups: LaneGroup[], extra?: string[]): LaneGroup[] {
  if (!extra || extra.length === 0) {
    return groups;
  }
  const have = new Set(groups.map((g) => g.category));
  const empties = extra.filter((name) => !have.has(name)).map((category) => ({
    category,
    projects: [],
  }));
  if (empties.length === 0) {
    return groups;
  }
  const last = groups[groups.length - 1];
  return last?.category === UNGROUPED
    ? [...groups.slice(0, -1), ...empties, last]
    : [...groups, ...empties];
}

/** DOM id of a lane, so other panels can scroll to it. */
export function laneAnchorId(projectId: string): string {
  return `lane-${projectId}`;
}

/*
  A category heading, spanning the whole frame above the lanes it covers.

  Inside the chart rather than as a separate Panel per group, and that is the decision
  that matters here. A panel each would give every group its own month header and its
  own today line, at which point the roadmap stops being one timeline and becomes four
  charts that happen to be stacked - and comparing "is Data finishing before App
  starts" across four independent axes is exactly the thing a Gantt exists to make
  possible.

  So the grid stays single and the headings sit inside it. It also means a heading
  scrolls horizontally with the chart, which is the one cost: on a wide roadmap,
  scrolled right, the heading text goes off the left edge. Sticky would fix it and
  would also make the headings float over the bars while scrolling vertically, which
  is worse for a chart people read by position.
*/
const GroupHead = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 8px 5px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${palette.deepMagenta};

  /* No line above the first one: it would sit directly under the column headings and
     read as part of them. */
  & + div > *:first-child {
    border-top: 0;
  }
`;

const GroupRule = styled.span`
  flex: 1;
  height: 1px;
  background: ${palette.hairline};
`;

const GroupCount = styled.span`
  font-weight: 700;
  color: ${palette.inkSoft};
`;

/*
  The control that puts a project into a group, on the group's own heading.

  Deliberately here rather than only in the project editor. Filing nine lanes one at a
  time means nine trips through a form that also holds the name, the DRI and the
  support - a form somebody opened to do one thing and can leave having changed four.
  From the heading the question is the one being asked: what else belongs in Data.

  The editor's field still exists and still works; this is the other end of the same
  fact, put where the grouping is actually being thought about.
*/
const AddToGroup = styled.button`
  border: 1px dashed ${palette.borderStrong};
  border-radius: ${radius.pill};
  background: transparent;
  color: ${palette.inkSoft};
  font: inherit;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 1px 9px;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    color: ${palette.deepMagenta};
    border-color: ${palette.deepMagenta};
  }
`;

/*
  The picker, as a plain <select> rather than a dropdown of our own.

  It is a list of project names and nothing else - no avatars, no metadata, nothing a
  native control cannot draw - and a native select is keyboard-navigable, type-ahead
  searchable and correct on a phone for free. The invite picker next door is bespoke
  because it shows Slack avatars and titles; this one has no such excuse.
*/
const GroupPicker = styled.select`
  font: inherit;
  font-size: 11px;
  max-width: 260px;
  border: 1px solid ${palette.borderStrong};
  border-radius: ${radius.sm};
  background: ${palette.card};
  color: ${palette.ink};
  padding: 1px 4px;
`;

/* An empty group somebody has just made. Absent once anything is in it. */
const GroupEmpty = styled.span`
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  color: ${palette.inkSoft};
`;

const Empty = styled.p`
  margin: 0;
  padding: 28px 8px;
  text-align: center;
  color: ${palette.inkSoft};
`;

export interface TimelineProps {
  projects: Project[];
  people: Person[];
  /**
   * Every task, or undefined until the board has been asked.
   *
   * Passed whole and split per lane here rather than by the caller, so the grouping
   * happens once per render instead of once per lane - and so a lane cannot be handed
   * somebody else's tasks by a caller that filtered wrongly.
   */
  tasks?: Task[];
  /** Categories already in use, forwarded to each lane's inline editor. */
  categories?: string[];
  grid: Grid;
  today: string;
  expanded: ReadonlySet<string>;
  onToggle: (projectId: string) => void;
  onPhaseSaved: (phase: Phase) => void;
  onPhaseDeleted: (projectId: string, phaseId: string) => void;
  onMilestoneSaved: (milestone: Milestone) => void;
  onMilestoneDeleted: (projectId: string, milestoneId: string) => void;
  onProjectSaved: (projectId: string, patch: ProjectPatch) => void;
  /**
   * Reorder mode. When set, every lane swaps its Edit button for move controls.
   *
   * Passed as one optional callback rather than as a `reordering` flag plus a handler,
   * because the two cannot disagree: there is no such thing as reordering with nothing
   * to call, or a move handler that is not meant to be shown.
   *
   * Whether each end of the list is reachable is decided HERE rather than in Lane,
   * from the index in this array, because Lane sees one project and cannot know it is
   * the last one. The array is already in display order - RoadmapPage sorts it - so
   * the index is the position on screen.
   */
  onMoveProject?: ((projectId: string, delta: -1 | 1) => void) | null;
  /**
   * Draw a heading over each run of lanes sharing a category.
   *
   * Purely visual: the incoming array is already in display order, and grouping
   * reorders nothing - see utils/laneView.ts, which does the run-splitting and
   * explains why group order is first-appearance rather than alphabetical.
   *
   * Never true at the same time as `onMoveProject`. RoadmapPage enforces that, for the
   * reason it already disables Reorder under a sort: "move up" means "give this a lower
   * lane_order", and under a heading the arrow would move a row past a boundary that
   * lane_order knows nothing about.
   */
  grouped?: boolean;
  /**
   * Groups to draw even when nothing is in them yet.
   *
   * A group only exists as a value on a project, so one just created has nowhere to
   * live until something is filed under it. Without this, "New group" would name a
   * heading that vanished on the next render - which reads as the button not working.
   */
  extraGroups?: string[];
  /**
   * File a project under a group from its heading. Absent means the headings are
   * read-only, which is what the complete section wants.
   */
  onAddToGroup?: (projectId: string, category: string) => void;
  /** Everything that could be moved into a group - including finished lanes. */
  assignable?: Project[];
}

export default function Timeline({
  projects,
  people,
  tasks,
  categories,
  grid,
  today,
  expanded,
  onToggle,
  onMoveProject,
  onPhaseSaved,
  onPhaseDeleted,
  onMilestoneSaved,
  onMilestoneDeleted,
  onProjectSaved,
  grouped = false,
  extraGroups,
  onAddToGroup,
  assignable,
}: TimelineProps) {
  /*
    Which heading has its picker open. One at a time, keyed by category name: two open
    selects in a column of headings is two places a stray click lands.
  */
  const [picking, setPicking] = useState<string | null>(null);

  /*
    Tasks grouped by project once, rather than a filter per lane inside the map - which
    on this board would be twenty-one passes over 287 rows on every render.
  */
  const tasksByProject = useMemo(() => {
    const out = new Map<string, Task[]>();
    for (const task of tasks ?? []) {
      if (!task.project_id) {
        continue;
      }
      const existing = out.get(task.project_id);
      if (existing) {
        existing.push(task);
      } else {
        out.set(task.project_id, [task]);
      }
    }
    return out;
  }, [tasks]);
  /*
    One lane. Extracted so the flat list and the grouped one are the SAME row rather
    than two that look alike - the second copy is where a prop stops being passed and
    one of the two quietly loses its milestone handler.

    `index` and `total` are the position within whatever list is being drawn, which is
    what decides whether each end is reachable. Lane sees one project and cannot know
    it is the last one.
  */
  const renderLane = (project: Project, index: number, total: number) => (
    // The wrapper exists so a lane can be scrolled into view from outside -
    // RoadmapPage does it to a newly created project, which is otherwise
    // appended below the fold. Lane itself renders several sibling rows, so
    // there is no single element to hang the anchor on from the inside.
    // (The gaps panel used to scroll here too, and has been removed.)
    <div key={project.project_id} id={laneAnchorId(project.project_id)}>
      <Lane
        project={project}
        grid={grid}
        people={people}
        tasks={tasks ? (tasksByProject.get(project.project_id) ?? []) : undefined}
        categories={categories}
        today={today}
        expanded={expanded.has(project.project_id)}
        onToggle={() => onToggle(project.project_id)}
        move={
          onMoveProject
            ? {
                onMove: (delta) => onMoveProject(project.project_id, delta),
                canMoveUp: index > 0,
                canMoveDown: index < total - 1,
              }
            : null
        }
        onPhaseSaved={onPhaseSaved}
        onPhaseDeleted={onPhaseDeleted}
        onMilestoneSaved={onMilestoneSaved}
        onMilestoneDeleted={onMilestoneDeleted}
        onProjectSaved={onProjectSaved}
      />
    </div>
  );

  return (
    <ChartCanvas grid={grid} today={today} label="Project">
      {projects.length === 0 ? (
        <Empty>No projects match the current filters.</Empty>
      ) : grouped ? (
        withEmpties(groupLanes(projects), extraGroups).map((group) => (
          <div key={group.category}>
            <GroupHead>
              {group.category}
              <GroupCount>{group.projects.length}</GroupCount>
              {/* A rule to the right edge rather than a boxed heading. The chart is
                  already a dense field of rectangles and another box in it reads as
                  another bar. */}
              <GroupRule aria-hidden="true" />
              {group.projects.length === 0 ? (
                <GroupEmpty>Nothing in here yet.</GroupEmpty>
              ) : null}
              {/* Never on "Everything else": that group is the absence of a group, so
                  "add a project to it" is a way of saying "unfile this", which is what
                  the picker's own blank option already does from the group it is in. */}
              {onAddToGroup && group.category !== UNGROUPED ? (
                picking === group.category ? (
                  <GroupPicker
                    autoFocus
                    aria-label={`Add a project to ${group.category}`}
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) {
                        onAddToGroup(e.target.value, group.category);
                      }
                      setPicking(null);
                    }}
                    onBlur={() => setPicking(null)}
                  >
                    <option value="">Pick a project…</option>
                    {(assignable ?? [])
                      .filter((p) => (p.category ?? '') !== group.category)
                      .map((p) => (
                        <option key={p.project_id} value={p.project_id}>
                          {p.name}
                          {p.category ? ` — currently ${p.category}` : ''}
                        </option>
                      ))}
                  </GroupPicker>
                ) : (
                  <AddToGroup
                    type="button"
                    onClick={() => setPicking(group.category)}
                    title={`Add a project to ${group.category}`}
                  >
                    + Add project
                  </AddToGroup>
                )
              ) : null}
            </GroupHead>
            {group.projects.map((project, index) =>
              renderLane(project, index, group.projects.length)
            )}
          </div>
        ))
      ) : (
        projects.map((project, index) => renderLane(project, index, projects.length))
      )}
    </ChartCanvas>
  );
}

