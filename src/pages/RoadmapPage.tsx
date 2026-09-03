/**
 * The roadmap: the chart and its toolbar.
 *
 * Was the whole of App.tsx until the Team page arrived. The masthead, the sign-out
 * button and the /api/me authorisation check moved up into AppShell, because both
 * pages need them and asking the API who you are twice per session is wasteful.
 *
 * There were two summary chips above the toolbar - today's date, and "10 projects ·
 * 50 phases · 2 milestones" - and both were removed. Neither was load-bearing: the
 * date is on the chart already, as the TODAY marker on the axis, and a count of lanes
 * is a count of the rows immediately underneath it.
 *
 * ONE THING HERE IS NOT OBVIOUS AND IS DELIBERATE.
 *
 * The visible span is recomputed from the projects in state rather than taken from
 * the roadmap response's span_start/span_end. Editing a date changes the span, and
 * the response fields are a snapshot from before the edit - trusting them means
 * dragging a phase past the end of the chart and watching the bar vanish off the
 * right-hand edge.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';

import Legend from '../components/Legend';
import ProjectEditor from '../components/ProjectEditor';
import { useIdentity } from '../components/AppShell';
import Timeline, { laneAnchorId } from '../components/chart/Timeline';
import { describeError, getRoadmap, saveLaneOrder } from '../services/api';
import { palette } from '../styles/theme';
import { ErrorText, Hint, Panel, PrimaryButton, SecondaryButton } from '../styles/ui';
import type { Milestone, Phase, Project, ProjectPatch, Roadmap } from '../types';
import { buildGrid, todayISO } from '../utils/dates';
import { laneOrderChanges, moveLane } from '../utils/laneOrder';
import { milestoneDates, sortMilestones } from '../utils/milestones';
import { responsibleProjectIds } from '../utils/projects';

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

export default function RoadmapPage() {
  const identity = useIdentity();
  const [roadmap, setRoadmap] = useState<Roadmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Which lanes are open. Empty until the first load, then seeded with your own.
   *
   * Cannot be an initialiser: neither the projects nor the identity exist at mount -
   * one comes from /api/roadmap and the other from /api/me, both in flight - so the
   * seeding is an effect below rather than a `useState(...)` argument.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [addingProject, setAddingProject] = useState(false);

  /**
   * The lane order being arranged, as project ids - or null when not reordering.
   *
   * A DRAFT, deliberately, rather than a PATCH per click. Reordering is not one edit,
   * it is a sequence of them converging on an arrangement, and saving each step would
   * write - and audit - half a dozen intermediate orders nobody ever wanted to look
   * at. It would also race: click Move up twice quickly and two overlapping PATCH
   * pairs land in whatever sequence the network chose.
   *
   * Holding ids rather than projects means the draft cannot go stale against an edit
   * made while the mode is open. A phase saved on a lane mid-rearrangement updates
   * `roadmap`; the order is unaffected because it never held a copy of the lane.
   */
  const [draftOrder, setDraftOrder] = useState<readonly string[] | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);

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
   * Guards the seeding below so it happens exactly once per mount.
   *
   * A ref rather than state, because flipping it must not cause a render - and because
   * the thing it guards is a one-shot: the seed is an OPENING POSITION, not a rule the
   * page keeps enforcing. Without it, every dependency change would re-open lanes the
   * viewer had just deliberately shut, so Collapse all would spring back the moment
   * anything else on the page changed.
   */
  const seeded = useRef(false);

  /**
   * Open the lanes this person is answerable for, once both answers are in.
   *
   * The default used to be all-collapsed, which is right for a stranger and wrong for
   * everybody else: the two lanes you are DRI or Support on are the reason you opened
   * the page, and making you find and expand them every time is a chevron hunt down a
   * list of nine. Everything else stays shut - see isResponsibleFor in
   * utils/projects.ts for why Support counts, and why owning a phase does not.
   *
   * Gated on `identity !== null`, which is "/api/me has answered" rather than "somebody
   * is signed in". Seeding before that lands would open nothing, burn the one-shot, and
   * leave the page in exactly the all-collapsed state this exists to replace.
   *
   * If /api/me never answers, this never runs and the page keeps its old behaviour.
   * That is the correct failure: we do not know whose lanes to open, and guessing would
   * either open all nine or claim a responsibility that is not ours to claim.
   */
  useEffect(() => {
    if (seeded.current || identity === null || !roadmap) {
      return;
    }
    seeded.current = true;
    const mine = responsibleProjectIds(roadmap.projects, identity.email);
    if (mine.size > 0) {
      // Guarded, so a viewer who is on nothing does not get a pointless re-render
      // replacing one empty set with another.
      setExpanded(mine);
    }
  }, [identity, roadmap]);

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

  /**
   * Drop a deleted phase out of its lane.
   *
   * No re-sort needed - removing from an ordered list leaves it ordered - but the
   * lane's whole appearance is derived from `phases`, so this one filter also
   * re-segments the collapsed bar, re-rolls its state and caption, and narrows the
   * chart's span if this phase was holding an edge of it.
   */
  const onPhaseDeleted = useCallback(
    (projectId: string, phaseId: string) => {
      updateLane(projectId, (project) => ({
        ...project,
        phases: project.phases.filter((phase) => phase.phase_id !== phaseId),
      }));
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

  const stored = useMemo(() => {
    const list = roadmap?.projects ?? [];
    // lane_order is the workbook's own row order, which is the order everyone
    // already has in their head. Name is only the tiebreak. Matches the sort in
    // list_projects, so the chart cannot disagree with the API about the order.
    return [...list].sort((a, b) => a.lane_order - b.lane_order || a.name.localeCompare(b.name));
  }, [roadmap]);

  /**
   * What the chart draws: the draft while somebody is arranging it, otherwise stored.
   *
   * A project the draft has never heard of sorts to the end rather than being dropped.
   * The toolbar makes this hard to reach - New project is disabled while reordering -
   * but "arrived from somewhere unexpected" must not mean "vanished off the roadmap",
   * and the end is where a new lane goes anyway. Array sort is stable, so several such
   * lanes keep their stored order relative to each other.
   */
  const projects = useMemo(() => {
    if (!draftOrder) {
      return stored;
    }
    const rank = new Map(draftOrder.map((projectId, index) => [projectId, index]));
    return [...stored].sort(
      (a, b) =>
        (rank.get(a.project_id) ?? Number.POSITIVE_INFINITY) -
        (rank.get(b.project_id) ?? Number.POSITIVE_INFINITY)
    );
  }, [stored, draftOrder]);

  /** The rows a save would actually write, which is not the same as what moved. */
  const pendingOrder = useMemo(
    () => (draftOrder ? laneOrderChanges(draftOrder, stored) : []),
    [draftOrder, stored]
  );

  /**
   * Whether the ARRANGEMENT differs from the stored one - the question Save asks.
   *
   * Not `pendingOrder.length > 0`, and the difference is not pedantic. The workbook
   * seed left lane_order sparse (0, 0, 10, 20), so laneOrderChanges has three rows to
   * renumber the instant the mode opens, before anybody has touched a thing. Gating
   * Save on that offers to save an edit the user did not make, and the toolbar
   * announces "3 lanes will be renumbered" as their opening greeting.
   *
   * Comparing positions instead also gets move-and-move-back right: the arrangement is
   * unchanged, so Save goes quiet, even though the renumbering that would tidy the
   * sparse values is still outstanding. Normalisation is a side effect of saving a real
   * change, never a reason to prompt for one.
   */
  const orderChanged = useMemo(
    () =>
      draftOrder !== null &&
      (draftOrder.length !== stored.length ||
        stored.some((project, index) => draftOrder[index] !== project.project_id)),
    [draftOrder, stored]
  );

  const onMoveProject = useCallback((projectId: string, delta: -1 | 1) => {
    setDraftOrder((current) => (current ? moveLane(current, projectId, delta) : current));
  }, []);

  const saveOrder = useCallback(async () => {
    if (!draftOrder || !orderChanged || pendingOrder.length === 0) {
      setDraftOrder(null);
      return;
    }
    setSavingOrder(true);
    setError(null);
    try {
      await saveLaneOrder(pendingOrder);
      // Applied to state rather than refetched. The whole roadmap - every phase and
      // milestone - is already here, and one changed integer per lane does not justify
      // pulling all of it back over the wire just to learn numbers we chose ourselves.
      const written = new Map(pendingOrder.map((c) => [c.project_id, c.lane_order]));
      setRoadmap((current) =>
        current
          ? {
              ...current,
              projects: current.projects.map((project) => {
                const lane_order = written.get(project.project_id);
                return lane_order === undefined ? project : { ...project, lane_order };
              }),
            }
          : current
      );
      setDraftOrder(null);
    } catch (err) {
      // saveLaneOrder issues the PATCHes in parallel and rejects on the first failure
      // while the rest carry on, so the stored order is now some mixture of old and
      // new. Refetch rather than keep showing the draft: the screen has to end up
      // displaying what is actually stored, however untidy that is.
      const message = describeError(err);
      setDraftOrder(null);
      await load();
      // After load, which clears the error on its way in - so the reason the save
      // failed is set last or it would be wiped by the re-read that follows it.
      setError(message);
    } finally {
      setSavingOrder(false);
    }
  }, [draftOrder, orderChanged, pendingOrder, load]);

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
  const reordering = draftOrder !== null;

  return (
    <>
      <Toolbar>
        {reordering ? (
          <>
            {/* Cancel first and Save second, so the destructive-to-your-work option is
                not the one under the cursor after the last Move click. */}
            <SecondaryButton type="button" onClick={() => setDraftOrder(null)} disabled={savingOrder}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              type="button"
              onClick={() => void saveOrder()}
              disabled={savingOrder || !orderChanged}
            >
              {savingOrder ? 'Saving…' : 'Save order'}
            </PrimaryButton>
            {/* Says where the controls are, because they are in the lane label column
                rather than up here, and a mode whose controls you have to hunt for is
                a mode people back out of. Once something has moved it reports the
                number of ROWS THAT WILL BE WRITTEN, which is often more than the
                number moved - saving also densifies the sparse orders the workbook
                seed left behind, and that is worth stating rather than doing quietly. */}
            <Hint>
              {orderChanged
                ? `${pendingOrder.length} lane${pendingOrder.length === 1 ? '' : 's'} will be renumbered.`
                : 'Use the arrows beside each project name to move it up or down.'}
            </Hint>
          </>
        ) : (
          <>
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
            {/* Disabled rather than hidden while the New project form is open. Entering
                the mode would have to either close that form, losing what was typed
                into it, or leave it open above a chart whose rows are moving. Two lanes
                is the point at which order is a question worth asking, so below that
                the control would be a mode with nothing to do. */}
            <SecondaryButton
              type="button"
              onClick={() => setDraftOrder(projects.map((p) => p.project_id))}
              disabled={projects.length < 2 || addingProject}
            >
              Reorder
            </SecondaryButton>
          </>
        )}
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
            onMoveProject={reordering ? onMoveProject : null}
            onPhaseSaved={onPhaseSaved}
            onPhaseDeleted={onPhaseDeleted}
            onMilestoneSaved={onMilestoneSaved}
            onMilestoneDeleted={onMilestoneDeleted}
            onProjectSaved={onProjectSaved}
          />
        )}
      </Panel>
    </>
  );
}
