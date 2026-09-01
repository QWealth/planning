/**
 * The roadmap: the chart, its toolbar, and the "still to decide" side panel.
 *
 * Was the whole of App.tsx until the Team page arrived. The masthead, the sign-out
 * button and the /api/me authorisation check moved up into AppShell, because both
 * pages need them and asking the API who you are twice per session is wasteful.
 *
 * ONE THING HERE IS NOT OBVIOUS AND IS DELIBERATE.
 *
 * The visible span is recomputed from the projects in state rather than taken from
 * the roadmap response's span_start/span_end. Editing a date changes the span, and
 * the response fields are a snapshot from before the edit - trusting them means
 * dragging a phase past the end of the chart and watching the bar vanish off the
 * right-hand edge.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';

import Legend from '../components/Legend';
import ProjectEditor from '../components/ProjectEditor';
import Timeline, { laneAnchorId } from '../components/chart/Timeline';
import { describeError, getRoadmap } from '../services/api';
import { palette } from '../styles/theme';
import {
  Chip,
  ErrorText,
  Panel,
  PrimaryButton,
  SecondaryButton,
} from '../styles/ui';
import type { Milestone, Phase, Project, ProjectPatch, Roadmap } from '../types';
import { buildGrid, formatLong, todayISO } from '../utils/dates';
import { milestoneDates, sortMilestones } from '../utils/milestones';

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
`;

const Spacer = styled.div`
  flex: 1;
`;

const Status = styled.p`
  margin: 0;
  color: ${palette.inkSoft};
`;

/* ProjectEditor's own grid carries the left padding that lines it up under a lane
   name. Standing on its own in a panel there is nothing to line up with, so the
   heading is inset to match rather than the form being un-indented for this one use. */
const NewProjectHead = styled.h2`
  font-size: 15px;
  padding-left: 30px;
`;

const Summary = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
`;

export default function RoadmapPage() {
  const [roadmap, setRoadmap] = useState<Roadmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [addingProject, setAddingProject] = useState(false);

  // Captured once per mount. Recomputed on every render it would be a new string
  // each time, so every memo below - including the grid - would rebuild constantly.
  const today = useMemo(() => todayISO(), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoadmap(await getRoadmap());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Rewrite one lane in place, leaving the rest of the roadmap alone.
   *
   * Every edit below is a change to a single project, so they all go through here
   * rather than each spelling out the same nested map. The lane list itself is never
   * reordered by this - a lane that moved while somebody was editing a phase inside it
   * would take the open editor with it.
   */
  const updateLane = useCallback(
    (projectId: string, change: (project: Project) => Project) => {
      setRoadmap((current) =>
        current
          ? {
              ...current,
              projects: current.projects.map((project) =>
                project.project_id === projectId ? change(project) : project
              ),
            }
          : current
      );
    },
    []
  );

  /**
   * An edit AND an addition, on one callback.
   *
   * Both endpoints answer with a whole PhaseOut, so the only difference is whether the
   * id is already in the lane - which this can just check. Two callbacks would mean
   * two nearly identical reducers and one of them eventually forgetting to re-sort.
   *
   * The re-sort is not cosmetic: a new phase arrives with the phase_order the form
   * gave it, and appending without sorting would put it last on screen even when its
   * order says otherwise - then move it on the next refresh, which reads as the app
   * having lost the edit.
   */
  const onPhaseSaved = useCallback(
    (saved: Phase) => {
      updateLane(saved.project_id, (project) => {
        const known = project.phases.some((phase) => phase.phase_id === saved.phase_id);
        const phases = known
          ? project.phases.map((phase) => (phase.phase_id === saved.phase_id ? saved : phase))
          : [...project.phases, saved];
        return {
          ...project,
          phases: [...phases].sort(
            (a, b) => a.phase_order - b.phase_order || a.name.localeCompare(b.name)
          ),
        };
      });
    },
    [updateLane]
  );

  /** Same upsert-and-re-sort as onPhaseSaved. Order comes from utils/milestones.ts. */
  const onMilestoneSaved = useCallback(
    (saved: Milestone) => {
      updateLane(saved.project_id, (project) => {
        const known = project.milestones.some((m) => m.milestone_id === saved.milestone_id);
        const milestones = known
          ? project.milestones.map((m) => (m.milestone_id === saved.milestone_id ? saved : m))
          : [...project.milestones, saved];
        return { ...project, milestones: sortMilestones(milestones) };
      });
    },
    [updateLane]
  );

  const onMilestoneDeleted = useCallback(
    (projectId: string, milestoneId: string) => {
      updateLane(projectId, (project) => ({
        ...project,
        milestones: project.milestones.filter((m) => m.milestone_id !== milestoneId),
      }));
    },
    [updateLane]
  );

  const onProjectSaved = useCallback(
    (projectId: string, patch: ProjectPatch) => {
      // Merged field by field. The PATCH response is ProjectOut and carries no
      // phases, so assigning it over the lane would empty it - the type forbids that
      // outright, and this is the reason why.
      updateLane(projectId, (project) => ({ ...project, ...patch }));
    },
    [updateLane]
  );

  /**
   * A new lane, appended and opened.
   *
   * Opened rather than left collapsed because a lane created from this form has no
   * dates on anything, so collapsed it draws as "Not scheduled" - an empty grey strip
   * that gives no sign the six phases it was just seeded with are there. Expanding it
   * puts the next thing to do on screen instead of hiding it behind a chevron.
   *
   * Appended without re-sorting the lane list: `projects` is sorted by lane_order for
   * rendering anyway, and the new lane's order is one past the current maximum, so it
   * lands at the bottom either way.
   */
  const onProjectCreated = useCallback(
    (created: Project) => {
      setRoadmap((current) =>
        current ? { ...current, projects: [...current.projects, created] } : current
      );
      setExpanded((current) => new Set(current).add(created.project_id));
      setAddingProject(false);
      requestAnimationFrame(() => {
        document
          .getElementById(laneAnchorId(created.project_id))
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    },
    []
  );

  const toggle = useCallback((projectId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(projectId)) {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  const projects = useMemo(() => {
    const list = roadmap?.projects ?? [];
    // lane_order is the workbook's own row order, which is the order everyone
    // already has in their head. Name is only the tiebreak.
    return [...list].sort((a, b) => a.lane_order - b.lane_order || a.name.localeCompare(b.name));
  }, [roadmap]);

  const grid = useMemo(() => {
    const dates = projects.flatMap((project) => [
      ...project.phases.flatMap((phase) =>
        [phase.start, phase.end].filter((d): d is string => d !== null)
      ),
      // Milestone dates widen the span too. A regulatory deadline set past the last
      // phase is the single most important thing on the chart and must not fall off
      // the right-hand edge - that it sits beyond the work is precisely why it was
      // recorded. The backend's span_start/span_end already account for these; this
      // recomputation has to as well or the two disagree after an edit.
      ...milestoneDates(project.milestones),
    ]);
    // Nothing scheduled anywhere: still draw a grid, centred on today, so the
    // toolbar and the lanes have something to sit against instead of collapsing.
    const start = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : today;
    const end = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : today;
    return buildGrid(start, end, today);
  }, [projects, today]);

  const milestoneTotal = useMemo(
    () => projects.reduce((n, project) => n + project.milestones.length, 0),
    [projects]
  );

  // One past the highest lane_order loaded, which is the highest ACTIVE one - this
  // page no longer fetches archived lanes at all - so a new lane can be given the same
  // order as an archived lane nobody can see. That is deliberately tolerated rather
  // than solved with an extra round trip: lane_order carries no uniqueness constraint,
  // the sort in `projects` above breaks ties by name, and the visible consequence of a
  // collision is two lanes adjacent in a different order than expected, and only if an
  // archived lane is ever restored.
  const nextLaneOrder = useMemo(
    () => projects.reduce((max, project) => Math.max(max, project.lane_order + 1), 0),
    [projects]
  );

  const allExpanded = projects.length > 0 && expanded.size === projects.length;

  return (
    <>
      <Summary>
        <Chip title={formatLong(today)}>Today {formatLong(today)}</Chip>
        {roadmap ? (
          <Chip>
            {projects.length} projects ·{' '}
            {projects.reduce((n, p) => n + p.phases.filter((ph) => !ph.structural).length, 0)}{' '}
            phases
            {/* Milestones are counted alongside phases, never added to them: they are
                deadlines rather than work, and one total covering both would be a
                number that means nothing. Suppressed entirely at zero so the header
                does not advertise a feature nothing is using yet. */}
            {milestoneTotal > 0 ? ` · ${milestoneTotal} milestones` : ''}
          </Chip>
        ) : null}
      </Summary>

      <Toolbar>
        {/* The only primary button on the screen, and first in the toolbar. Everything
            else here changes what is shown; this is the one that adds something. */}
        <PrimaryButton
          type="button"
          onClick={() => setAddingProject((open) => !open)}
          aria-expanded={addingProject}
        >
          {addingProject ? 'Close' : 'New project'}
        </PrimaryButton>
        <SecondaryButton
          type="button"
          onClick={() =>
            setExpanded(allExpanded ? new Set() : new Set(projects.map((p) => p.project_id)))
          }
          disabled={projects.length === 0}
        >
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </SecondaryButton>
        <Spacer />
        <Legend />
      </Toolbar>

      {error ? <ErrorText role="alert">{error}</ErrorText> : null}

      {/* Above the chart rather than inside it. A new lane has no row to open an
          inline editor under, and putting the form where the chart's first row would
          be shifts every lane down by the height of a form. */}
      {addingProject ? (
        <Panel aria-label="New project">
          <NewProjectHead>New project</NewProjectHead>
          <ProjectEditor
            project={null}
            people={roadmap?.people ?? []}
            nextLaneOrder={nextLaneOrder}
            onCreated={onProjectCreated}
            onCancel={() => setAddingProject(false)}
          />
        </Panel>
      ) : null}

      <Panel>
        {loading && !roadmap ? (
          <Status>Loading the roadmap…</Status>
        ) : (
          <Timeline
            projects={projects}
            people={roadmap?.people ?? []}
            grid={grid}
            today={today}
            expanded={expanded}
            onToggle={toggle}
            onPhaseSaved={onPhaseSaved}
            onMilestoneSaved={onMilestoneSaved}
            onMilestoneDeleted={onMilestoneDeleted}
            onProjectSaved={onProjectSaved}
          />
        )}
      </Panel>
    </>
  );
}
