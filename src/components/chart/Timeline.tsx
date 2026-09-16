/**
 * The roadmap chart: a stack of project lanes on the shared canvas.
 *
 * The heading row, the gridline/today overlay and the today flag used to live here
 * and now live in ChartCanvas, because the Team page draws people on the same grid
 * and the alignment reasoning behind that overlay is not something to keep two copies
 * of. What is left is what is genuinely about projects: the lane stack, the anchor
 * ids other panels scroll to, and the empty state.
 */

import styled from 'styled-components';

import { palette } from '../../styles/theme';
import { type Grid } from '../../utils/dates';
import { groupLanes } from '../../utils/laneView';
import type { Milestone, Person, Phase, Project, ProjectPatch } from '../../types';
import ChartCanvas from './ChartCanvas';
import Lane from './Lane';

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

const Empty = styled.p`
  margin: 0;
  padding: 28px 8px;
  text-align: center;
  color: ${palette.inkSoft};
`;

export interface TimelineProps {
  projects: Project[];
  people: Person[];
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
}

export default function Timeline({
  projects,
  people,
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
}: TimelineProps) {
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
        groupLanes(projects).map((group) => (
          <div key={group.category}>
            <GroupHead>
              {group.category}
              <GroupCount>{group.projects.length}</GroupCount>
              {/* A rule to the right edge rather than a boxed heading. The chart is
                  already a dense field of rectangles and another box in it reads as
                  another bar. */}
              <GroupRule aria-hidden="true" />
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

