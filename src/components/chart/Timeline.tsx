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
  onMilestoneSaved: (milestone: Milestone) => void;
  onMilestoneDeleted: (projectId: string, milestoneId: string) => void;
  onProjectSaved: (projectId: string, patch: ProjectPatch) => void;
}

export default function Timeline({
  projects,
  people,
  grid,
  today,
  expanded,
  onToggle,
  onPhaseSaved,
  onMilestoneSaved,
  onMilestoneDeleted,
  onProjectSaved,
}: TimelineProps) {
  return (
    <ChartCanvas grid={grid} today={today} label="Project">
      {projects.length === 0 ? (
        <Empty>No projects match the current filters.</Empty>
      ) : (
        projects.map((project) => (
          // The wrapper exists so a gap in the side panel can scroll its lane into
          // view. Lane itself renders several sibling rows, so there is no single
          // element to hang the anchor on from the inside.
          <div key={project.project_id} id={laneAnchorId(project.project_id)}>
            <Lane
              project={project}
              grid={grid}
              people={people}
              today={today}
              expanded={expanded.has(project.project_id)}
              onToggle={() => onToggle(project.project_id)}
              onPhaseSaved={onPhaseSaved}
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
