/**
 * One project: the collapsed lane, and the phase rows underneath when it is opened.
 *
 * The collapsed row is the product. The workbook drew six task rows per project -
 * fifty-four rows for nine projects, which is more than fits on a screen and far
 * more than fits in a head - and the whole point of compressing each group to a
 * single row is that the single row still answers "where has this got to". It does
 * that with one composite bar spanning the project's earliest start to its latest
 * end, coloured by the state that utils/phaseState.ts picks out.
 *
 * Phases stay collapsed by default. Expanding is for when the summary raises a
 * question, not for reading the roadmap.
 *
 * The expanded view also lists MILESTONES, one row each, below the phases. They are
 * not phases and are not mixed in with them - a deadline is a moment something is due,
 * not owned work with a duration - but they need a row somewhere, because the diamond
 * on the collapsed lane names itself only on hover, and an undated milestone has no
 * diamond at all. Without these rows an undated milestone is invisible everywhere
 * except the "still to decide" panel, which is exactly the wrong place to have to go
 * to give it a date.
 */

import { useState } from 'react';
import styled from 'styled-components';

import { palette, radius, STATE_STYLE } from '../../styles/theme';
import { Chip } from '../../styles/ui';
import { formatMedium, placeDay, type Grid } from '../../utils/dates';
import {
  describeMilestone,
  laneMilestones,
  milestoneStatus,
  missedCount,
  undatedMilestones,
} from '../../utils/milestones';
import { describeVerdict, laneVerdict, phaseState } from '../../utils/phaseState';
import { laneSegments, peakConcurrency } from '../../utils/segments';
import type { Milestone, Person, Phase, Project, ProjectPatch } from '../../types';
import MilestoneEditor from '../MilestoneEditor';
import PhaseEditor from '../PhaseEditor';
import ProjectEditor from '../ProjectEditor';
import Bar, { describeProgress, describeSpan } from './Bar';
import MilestoneMarks, { MilestoneDiamond } from './MilestoneMarks';
import SegmentedBar from './SegmentedBar';
import {
  AddButton,
  AddRow,
  DateLabel,
  Disclosure,
  EditButton,
  EditorRow,
  LaneLabelCell,
  LaneName,
  LaneRow,
  MilestonePin,
  MoveButton,
  PhaseLabelCell,
  PhaseName,
  PhaseRow,
  SubLabel,
  Track,
  UnscheduledStrip,
} from './parts';

const Stack = styled.div`
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
`;

/** The state's colour as a dot, so the lane name carries the state too. */
const StateDot = styled.span<{ $fill: string }>`
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: ${(p) => p.$fill};
  border: 1px solid rgba(46, 21, 36, 0.15);
`;

const NameRow = styled.div`
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
`;

/** A phase with no dates: small and stated, not a full-width banner. */
const NoDates = styled.span`
  position: absolute;
  top: 50%;
  left: 0;
  transform: translateY(-50%);
  font-size: 11px;
  font-weight: 600;
  color: ${palette.slateDeep};
  border: 1px dashed ${palette.borderStrong};
  border-radius: ${radius.pill};
  padding: 1px 9px;
  white-space: nowrap;
`;

const SupportChip = styled(Chip)`
  position: absolute;
  top: 50%;
  left: 0;
  transform: translateY(-50%);
  color: ${palette.slateDeep};
  border-color: ${palette.border};
  background: rgba(180, 162, 172, 0.12);
`;

/** Move controls for this lane, or null when the roadmap is not being reordered. */
export interface LaneMove {
  onMove: (delta: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export interface LaneProps {
  project: Project;
  grid: Grid;
  people: Person[];
  today: string;
  expanded: boolean;
  onToggle: () => void;
  /**
   * Present only while reordering, and it replaces Edit rather than joining it.
   *
   * Both in the same cell would not fit - 264px, minus the disclosure, minus a name
   * that already ellipsises - and they are anyway two different jobs: reordering is a
   * mode you turn on to arrange the board, and opening an editor mid-rearrangement
   * puts a form under a row that is about to move out from under it.
   */
  move?: LaneMove | null;
  /** Upsert on phase_id: the same callback carries an edit and a newly added phase. */
  onPhaseSaved: (phase: Phase) => void;
  onPhaseDeleted: (projectId: string, phaseId: string) => void;
  /** Upsert on milestone_id, for the same reason. */
  onMilestoneSaved: (milestone: Milestone) => void;
  onMilestoneDeleted: (projectId: string, milestoneId: string) => void;
  onProjectSaved: (projectId: string, patch: ProjectPatch) => void;
}

export default function Lane({
  project,
  grid,
  people,
  today,
  expanded,
  onToggle,
  move,
  onPhaseSaved,
  onPhaseDeleted,
  onMilestoneSaved,
  onMilestoneDeleted,
  onProjectSaved,
}: LaneProps) {
  const [editingProject, setEditingProject] = useState(false);
  const [editingPhaseId, setEditingPhaseId] = useState<string | null>(null);
  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(null);
  const [adding, setAdding] = useState<'phase' | 'milestone' | null>(null);

  const verdict = laneVerdict(project.phases, today);
  const style = STATE_STYLE[verdict.state];
  // The verdict still decides the lane's dot, caption and one-line summary - "where
  // has this got to" is a single-answer question. The bar is segmented separately,
  // because "what is happening in September" is not.
  const segments = laneSegments(project.phases);
  // Milestones are not phases and are not folded into the verdict: a deadline is a
  // moment something is due, not work in progress, so it cannot move a lane's colour
  // or its average. It gets its own band of diamonds above the bar.
  const marks = laneMilestones(project.milestones, today);
  const missed = missedCount(marks, today);
  const undated = undatedMilestones(project.milestones);

  // Where a newly added phase goes: after everything already there. The API defaults
  // phase_order to 0 (see create_phase in fast/app/db/queries/projects.py), so without
  // this every phase anyone adds would sort above the work that was there first.
  const nextPhaseOrder = project.phases.reduce((max, p) => Math.max(max, p.phase_order + 1), 0);

  const nameOf = (email: string | null) =>
    email ? (people.find((p) => p.email === email)?.name ?? email) : null;

  const dri = nameOf(project.dri_email);
  const support = nameOf(project.support_email);
  // "DRI unassigned" is printed rather than left blank. Four of the nine lanes have
  // no DRI and the workbook showed that as an empty cell, which reads as "nothing to
  // see" instead of "nobody owns this".
  const owners = dri
    ? `DRI ${dri}${support ? ` · Support ${support}` : ''}`
    : 'DRI unassigned';

  // Undated milestones are named here because they are the ones the chart CANNOT
  // draw. A diamond has to sit somewhere on a time axis, and there is no honest
  // position for a deadline nobody has committed to - so the lane says so in words
  // rather than leaving the count to look like zero.
  const milestoneNote = [
    project.milestones.length
      ? `${project.milestones.length} milestone${project.milestones.length === 1 ? '' : 's'}`
      : null,
    missed ? `${missed} missed` : null,
    undated.length ? `${undated.length} with no date set` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');

  const laneTitle = [
    project.name,
    describeVerdict(verdict),
    describeSpan(verdict.start, verdict.end),
    verdict.progress === null
      ? 'no progress recorded on any phase'
      : `average progress ${describeProgress(verdict.progress)} across ${
          verdict.realCount - verdict.progressUnknownCount
        } of ${verdict.realCount} phases`,
    milestoneNote,
  ]
    .filter((part) => part !== '')
    .join(' — ');

  // "3 at once" is stated as well as drawn. The split bar shows concurrency to
  // someone looking at that lane; the caption puts it in words next to the bar, so
  // scanning nine lanes for "where are we doing four things in parallel" does not
  // depend on counting stripes 6px tall.
  const peak = peakConcurrency(segments);
  const concurrency = peak > 1 ? ` · ${peak} at once` : '';

  // A missed deadline earns a place in the caption even on a lane that is otherwise
  // finished, which is why it is appended after the 'complete' branch rather than
  // inside the else. "All phases done" and "and the launch date went by unmet" are
  // both true at once, and the second is the one somebody needs to act on.
  const slipped = missed ? ` · ${missed} missed` : '';

  const laneCaption =
    (verdict.basis === 'complete'
      ? 'Complete'
      : `${style.label} · ${describeProgress(verdict.progress)}${concurrency}`) + slipped;

  return (
    <>
      <LaneRow>
        <LaneLabelCell>
          <Disclosure
            type="button"
            $open={expanded}
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`}
          >
            {/* A triangle glyph rather than an icon dependency; parts.ts rotates it. */}
            &#9656;
          </Disclosure>
          <Stack>
            <NameRow>
              <StateDot $fill={style.fill} aria-hidden />
              <LaneName title={project.name}>{project.name}</LaneName>
            </NameRow>
            <SubLabel title={owners}>
              {describeVerdict(verdict)} · {owners}
            </SubLabel>
          </Stack>
          {move ? (
            <>
              {/* Named after the project, not after the direction. Nine lanes each
                  offering "Move up" gives a screen reader nine identical controls and
                  no way to tell which row it is on. */}
              <MoveButton
                type="button"
                onClick={() => move.onMove(-1)}
                disabled={!move.canMoveUp}
                aria-label={`Move ${project.name} up`}
              >
                &#9650;
              </MoveButton>
              <MoveButton
                type="button"
                onClick={() => move.onMove(1)}
                disabled={!move.canMoveDown}
                aria-label={`Move ${project.name} down`}
              >
                &#9660;
              </MoveButton>
            </>
          ) : (
            <EditButton type="button" onClick={() => setEditingProject((open) => !open)}>
              Edit
            </EditButton>
          )}
        </LaneLabelCell>

        <Track>
          {segments.length > 0 && verdict.start && verdict.end ? (
            <SegmentedBar
              grid={grid}
              segments={segments}
              start={verdict.start}
              end={verdict.end}
              caption={laneCaption}
              title={laneTitle}
            />
          ) : verdict.start || verdict.end ? (
            // No segment is drawable, but a date exists - so every dated phase here
            // is half-scheduled. Bar handles that with its faded open edge; the
            // segmenter deliberately refuses to guess the missing end.
            <Bar
              grid={grid}
              start={verdict.start}
              end={verdict.end}
              state={verdict.state}
              progress={verdict.progress}
              caption={laneCaption}
              title={laneTitle}
            />
          ) : (
            <UnscheduledStrip title={laneTitle}>
              {verdict.basis === 'empty' ? 'No phases yet' : 'Not scheduled'}
            </UnscheduledStrip>
          )}

          {/* Outside the three-way branch above, deliberately: a lane with a dated
              deadline and no dated work is a real and useful thing to see, and
              nesting the marks inside the bar branches would hide exactly the case
              where a milestone is the only fact the lane has. */}
          <MilestoneMarks grid={grid} marks={marks} today={today} project={project.name} />
        </Track>
      </LaneRow>

      {/* Not rendered while reordering. The form is bound to a lane that is currently
          sliding up and down the board, and leaving it on screen would put its Save
          button under a different project each time the row moved.
          `editingProject` is left true, so the editor reopens when the mode ends -
          but unmounting discards the react-hook-form state, so it reopens showing the
          stored values rather than anything half-typed. That is the honest outcome:
          the alternative is a form that silently looks dirty against a row nobody
          edited. */}
      {editingProject && !move ? (
        <EditorRow>
          <ProjectEditor
            project={project}
            people={people}
            onCancel={() => setEditingProject(false)}
            onSaved={(patch) => {
              onProjectSaved(project.project_id, patch);
              setEditingProject(false);
            }}
          />
        </EditorRow>
      ) : null}

      {expanded
        ? project.phases.map((phase) => {
            const state = phaseState(phase.name);
            const owner = nameOf(phase.owner_email);
            const title = `${project.name} — ${phase.name}: ${describeSpan(
              phase.start,
              phase.end
            )}, ${phase.structural ? 'ongoing support' : describeProgress(phase.progress)}`;

            return (
              <div key={phase.phase_id}>
                <PhaseRow>
                  <PhaseLabelCell>
                    <PhaseName title={phase.name}>{phase.name}</PhaseName>
                    <SubLabel>{owner ?? 'unassigned'}</SubLabel>
                    <EditButton
                      type="button"
                      onClick={() =>
                        setEditingPhaseId((current) =>
                          current === phase.phase_id ? null : phase.phase_id
                        )
                      }
                    >
                      Edit
                    </EditButton>
                  </PhaseLabelCell>
                  <Track>
                    {phase.structural ? (
                      // Maintenance. It has no dates by construction and is not a
                      // gap, so it gets a label rather than an empty row that looks
                      // like missing data.
                      <SupportChip title={title}>Ongoing support</SupportChip>
                    ) : phase.start || phase.end ? (
                      <Bar
                        grid={grid}
                        start={phase.start}
                        end={phase.end}
                        state={state}
                        progress={phase.progress}
                        caption={describeProgress(phase.progress)}
                        title={title}
                      />
                    ) : (
                      <NoDates title={title}>No dates set</NoDates>
                    )}
                  </Track>
                </PhaseRow>

                {editingPhaseId === phase.phase_id ? (
                  <EditorRow>
                    <PhaseEditor
                      phase={phase}
                      people={people}
                      onCancel={() => setEditingPhaseId(null)}
                      onSaved={(saved) => {
                        onPhaseSaved(saved);
                        setEditingPhaseId(null);
                      }}
                      onDeleted={(projectId, phaseId) => {
                        // Close the editor first: it is rendered under the row for
                        // the phase that just stopped existing, and leaving it open
                        // would strand a form editing nothing.
                        setEditingPhaseId(null);
                        onPhaseDeleted(projectId, phaseId);
                      }}
                    />
                  </EditorRow>
                ) : null}
              </div>
            );
          })
        : null}

      {expanded && adding === 'phase' ? (
        <EditorRow>
          <PhaseEditor
            phase={null}
            projectId={project.project_id}
            nextPhaseOrder={nextPhaseOrder}
            people={people}
            onCancel={() => setAdding(null)}
            onSaved={(saved) => {
              onPhaseSaved(saved);
              setAdding(null);
            }}
          />
        </EditorRow>
      ) : null}

      {expanded
        ? project.milestones.map((milestone) => {
            const status = milestoneStatus(milestone, today);
            const title = `${project.name} — ${describeMilestone(milestone, today)}`;
            // placeDay is only meaningful for a milestone that has a date. An undated
            // one gets the same "no dates" treatment a phase does rather than a
            // diamond parked at 0%, which would read as a deadline of "the start of
            // the chart" - an invented commitment, which is the one thing the whole
            // nullable-date design exists to avoid.
            const leftPct = milestone.date ? placeDay(grid, milestone.date) : null;

            return (
              <div key={milestone.milestone_id}>
                <PhaseRow>
                  <PhaseLabelCell>
                    <MilestoneDiamond status={status} />
                    <PhaseName title={milestone.name}>{milestone.name}</PhaseName>
                    {/* formatMedium, not formatLong. The label column is 264px and
                        this row spends some of it on a diamond, so a full "Wed, 1 Jul
                        2026" pushed the milestone's NAME into an ellipsis - and a row
                        that truncates its own subject to keep the weekday has its
                        priorities backwards. The weekday is still a hover away.
                        DateLabel rather than SubLabel so the date is never itself the
                        thing that gets clipped; see its definition in parts.ts. */}
                    <DateLabel title={title}>
                      {milestone.date ? formatMedium(milestone.date) : 'no date set'}
                    </DateLabel>
                    <EditButton
                      type="button"
                      onClick={() =>
                        setEditingMilestoneId((current) =>
                          current === milestone.milestone_id ? null : milestone.milestone_id
                        )
                      }
                    >
                      Edit
                    </EditButton>
                  </PhaseLabelCell>
                  <Track>
                    {leftPct !== null && leftPct >= 0 && leftPct <= 100 ? (
                      <MilestonePin $leftPct={leftPct} title={title} role="img" aria-label={title}>
                        <MilestoneDiamond status={status} />
                      </MilestonePin>
                    ) : (
                      <NoDates title={title}>No date set</NoDates>
                    )}
                  </Track>
                </PhaseRow>

                {editingMilestoneId === milestone.milestone_id ? (
                  <EditorRow>
                    <MilestoneEditor
                      milestone={milestone}
                      projectId={project.project_id}
                      onCancel={() => setEditingMilestoneId(null)}
                      onSaved={(saved) => {
                        onMilestoneSaved(saved);
                        setEditingMilestoneId(null);
                      }}
                      onDeleted={(milestoneId) => {
                        onMilestoneDeleted(project.project_id, milestoneId);
                        setEditingMilestoneId(null);
                      }}
                    />
                  </EditorRow>
                ) : null}
              </div>
            );
          })
        : null}

      {expanded && adding === 'milestone' ? (
        <EditorRow>
          <MilestoneEditor
            milestone={null}
            projectId={project.project_id}
            onCancel={() => setAdding(null)}
            onSaved={(saved) => {
              onMilestoneSaved(saved);
              setAdding(null);
            }}
          />
        </EditorRow>
      ) : null}

      {expanded ? (
        <AddRow>
          {/* Only one form open at a time. Two half-filled creates stacked under one
              lane is a good way to submit the wrong one, and there is no case for
              writing a phase and a milestone simultaneously. */}
          <AddButton type="button" onClick={() => setAdding(adding === 'phase' ? null : 'phase')}>
            + Add phase
          </AddButton>
          <AddButton
            type="button"
            onClick={() => setAdding(adding === 'milestone' ? null : 'milestone')}
          >
            + Add milestone
          </AddButton>
          {project.milestones.length === 0 ? (
            <SubLabel>No milestones on this lane.</SubLabel>
          ) : null}
        </AddRow>
      ) : null}
    </>
  );
}
