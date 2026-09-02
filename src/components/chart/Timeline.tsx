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
import type { Milestone, Person, Phase, Project, ProjectPatch } from '../../types';
import ChartCanvas from './ChartCanvas';
import Lane from './Lane';

/** DOM id of a lane, so other panels can scroll to it. */
export function laneAnchorId(projectId: string): string {
  return `lane-${projectId}`;
}

const Empty = styled.p`
  margin: 0;
  padding: 28px 8px;
  text-align: center;
  color: ${palette.inkSoft};
`;

export interface TimelineProps {
  projects: Project[];
  people: Person[];
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
}

export default function Timeline({
  projects,
  people,
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
}: TimelineProps) {
  return (
    <ChartCanvas grid={grid} today={today} label="Project">
      {projects.length === 0 ? (
        <Empty>No projects match the current filters.</Empty>
      ) : (
        projects.map((project, index) => (
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
              today={today}
              expanded={expanded.has(project.project_id)}
              onToggle={() => onToggle(project.project_id)}
              move={
                onMoveProject
                  ? {
                      onMove: (delta) => onMoveProject(project.project_id, delta),
                      canMoveUp: index > 0,
                      canMoveDown: index < projects.length - 1,
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
        ))
      )}
    </ChartCanvas>
  );
}
