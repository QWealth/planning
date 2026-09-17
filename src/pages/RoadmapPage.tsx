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
import { useSearchParams } from 'react-router-dom';
import styled from 'styled-components';

import Legend from '../components/Legend';
import ProjectEditor from '../components/ProjectEditor';
import { useIdentity } from '../components/AppShell';
import Timeline, { laneAnchorId } from '../components/chart/Timeline';
import { describeError, getRoadmap, getTasks, patchProject, saveLaneOrder } from '../services/api';
import { palette, radius } from '../styles/theme';
import {
  ErrorText,
  Hint,
  Panel,
  PrimaryButton,
  SecondaryButton,
  Input,
  Select,
} from '../styles/ui';
import type { Milestone, Phase, Project, ProjectPatch, Roadmap, Task } from '../types';
import { buildGrid, todayISO } from '../utils/dates';
import { laneOrderChanges, moveLane } from '../utils/laneOrder';
import { SORT_OPTIONS, hasCategories, sortLanes, splitComplete } from '../utils/laneView';
import type { SortMode } from '../utils/laneView';
import { milestoneDates, sortMilestones } from '../utils/milestones';
import { responsibleProjectIds } from '../utils/projects';

/*
  The two things you can add, as big targets rather than a dropdown.

  A select would be fewer pixels and would also hide both options behind a click, which
  is the wrong trade when the whole reason this step exists is that the difference
  between them is not obvious. Cards you can read without interacting are the point.
*/
const LegendFooter = styled.div`
  padding: 2px 4px;
`;

const Choices = styled.div`
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
`;

const Choice = styled.button`
  flex: 1;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  text-align: left;
  font: inherit;
  cursor: pointer;
  padding: 12px 14px;
  border: 2px solid ${palette.borderStrong};
  border-radius: ${radius.md};
  background: ${palette.card};
  color: ${palette.ink};

  &:hover {
    border-color: ${palette.deepMagenta};
  }

  &:focus-visible {
    outline: 2px solid ${palette.turquoise};
    outline-offset: 2px;
  }
`;

const ChoiceName = styled.span`
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${palette.deepMagenta};
`;

const ChoiceWhat = styled.span`
  font-size: 12px;
  line-height: 1.45;
  color: ${palette.inkSoft};
`;

/* The inline name field, so making a group never leaves the page. */
const GroupNameForm = styled.form`
  display: flex;
  align-items: center;
  gap: 6px;
`;

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

/* The heading over the finished lanes.

   Inset to 30px like NewProjectHead so it lines up with the lane-name column rather
   than the panel edge, and sized down from a page heading because this section is a
   footnote to the roadmap, not a second roadmap. */
const CompleteHead = styled.h2`
  font-size: 13px;
  margin: 0 0 4px;
  padding-left: 30px;
  color: ${palette.inkSoft};
`;

const CompleteNote = styled.p`
  margin: 0 0 12px;
  padding-left: 30px;
  font-size: 12px;
  color: ${palette.inkSoft};
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
  /*
    The add flow: closed, choosing what to add, or on one of the two forms.

    One value rather than two booleans, because the states are genuinely exclusive -
    two booleans allow "naming a group while the project form is open", which is a
    state nothing should be able to reach and which two separate setters eventually do.
  */
  const [adding, setAdding] = useState<null | 'choose' | 'project' | 'group'>(null);
  const [newGroupName, setNewGroupName] = useState('');

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

  /*
    How the list is ORDERED ON SCREEN, which is not the same as how it is stored.

    Deliberately not persisted - not to the row, not to localStorage. lane_order is the
    roadmap's shared arrangement and the one everybody discusses; a sort is one reader
    looking at the same roadmap a different way for a minute. Remembering it would mean
    somebody opens the page a week later, sees it ordered by progress, and has no idea
    why it disagrees with the order they remember.
  */
  const [sortMode, setSortMode] = useState<SortMode>('roadmap');

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
   * `/?project=<id>` — somebody arriving from somewhere else in the app.
   *
   * The board, the roster and the milestone log all link here by project id, because
   * all three are places you notice something and this is the place you do something
   * about it. Landing on the roadmap scrolled to the top, with the lane in question
   * somewhere below the fold and shut, is the same as not having linked at all.
   *
   * Runs on its own one-shot rather than folding into the seeding above, and the order
   * matters: this opens the lane IN ADDITION to whatever the seed opened, because
   * arriving by link is not a reason to close the two lanes you are answerable for.
   *
   * The scroll is deferred a frame for the reason onProjectCreated's is - the lane has
   * to be in the DOM before getElementById can find it - and it is `smooth` and
   * `center` for the same reason: landing hard at the top edge reads as a page load
   * rather than as an arrival at something.
   */
  const [params] = useSearchParams();
  const linkedProject = params.get('project');
  const jumped = useRef(false);

  useEffect(() => {
    if (jumped.current || !linkedProject || !roadmap) {
      return;
    }
    // Only for a lane that is actually here. A stale link to a deleted project
    // silently does nothing, which is better than scrolling somewhere arbitrary.
    if (!roadmap.projects.some((p) => p.project_id === linkedProject)) {
      return;
    }
    jumped.current = true;
    setExpanded((current) => new Set(current).add(linkedProject));
    requestAnimationFrame(() => {
      document
        .getElementById(laneAnchorId(linkedProject))
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, [linkedProject, roadmap]);

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
   * File a project under a group, from the group's own heading.
   *
   * Optimistic: the lane moves as soon as the request is sent, and the page is not
   * reloaded. A grouping change is one field and its whole effect is visible on screen,
   * so waiting on a round trip before moving the row would make a one-click action feel
   * like a form. A failure puts the error in the banner and the next reload corrects
   * the row - which is the same bargain every other edit on this page makes.
   */
  const onAddToGroup = useCallback(
    (projectId: string, category: string) => {
      updateLane(projectId, (project) => ({ ...project, category }));
      // The group has somewhere real to live now, so drop it from the pending list -
      // leaving it would draw the heading twice, once empty and once with the lane.
      setNewGroups((current) => current.filter((name) => name !== category));
      void patchProject(projectId, { category }).catch((err) => setError(describeError(err)));
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
      setAdding(null);
      requestAnimationFrame(() => {
        document
          .getElementById(laneAnchorId(created.project_id))
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    },
    []
  );

  /*
    The board's tasks, fetched the first time anybody opens a lane.

    Lazily, because the collapsed roadmap shows none of them and 287 rows is a request
    the ordinary visit does not need - somebody checking where DocuTelligence has got
    to never expands anything. Once, because the second lane to open wants the same
    list, and `null` vs `[]` is what tells the two apart.

    Failures are swallowed on purpose. Tasks are a detail inside an expanded lane, and
    turning a roadmap into an error banner because the board did not answer would be
    the tail wagging the dog; the lane simply lists nothing, as it did before.
  */
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const loadingTasks = useRef(false);

  const ensureTasks = useCallback(() => {
    if (tasks !== null || loadingTasks.current) {
      return;
    }
    loadingTasks.current = true;
    void getTasks()
      .then(setTasks)
      .catch(() => {
        // Left null, so a later expand tries again rather than the page remembering
        // one bad moment for the rest of the session.
        loadingTasks.current = false;
      });
  }, [tasks]);

  const toggle = useCallback(
    (projectId: string) => {
      // Asked for on every toggle rather than only on the first open. It is a no-op
      // once they are in hand, and gating it on "is this an open rather than a close"
      // would be a second piece of state to keep honest for nothing.
      ensureTasks();
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(projectId)) {
          next.add(projectId);
        }
        return next;
      });
    },
    [ensureTasks]
  );

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
  /** Every lane, in the order chosen for viewing. The grid spans this, not one half. */
  const arranged = useMemo(() => sortLanes(stored, sortMode, today), [stored, sortMode, today]);

  /**
   * Split into what is running and what has finished, AFTER sorting, so both sections
   * come out in the chosen order. See utils/laneView.ts for why "complete" defers to
   * laneVerdict rather than being decided here.
   */
  const { live: arrangedLive, complete } = useMemo(
    () => splitComplete(arranged, today),
    [arranged, today]
  );

  /**
   * The running lanes AS STORED - the baseline a reorder is measured against.
   *
   * It has to be the same population as `draftOrder`, which only ever holds the
   * running lanes, or the two disagree on length and `orderChanged` reports a change
   * before anybody has touched anything.
   */
  const storedLive = useMemo(() => splitComplete(stored, today).live, [stored, today]);

  const projects = useMemo(() => {
    if (!draftOrder) {
      return arrangedLive;
    }
    const rank = new Map(draftOrder.map((projectId, index) => [projectId, index]));
    return [...arrangedLive].sort(
      (a, b) =>
        (rank.get(a.project_id) ?? Number.POSITIVE_INFINITY) -
        (rank.get(b.project_id) ?? Number.POSITIVE_INFINITY)
    );
  }, [arrangedLive, draftOrder]);

  /**
   * The rows a save would actually write, which is not the same as what moved.
   *
   * Computed over the running lanes only, which renumbers them 0..n-1 and leaves the
   * finished ones holding whatever order they had. So a running lane and a finished
   * one routinely end up sharing a lane_order, and that is fine here in a way it is
   * not for the archived collision the nextLaneOrder note describes: the two
   * populations are split before either is rendered, so they are never sorted against
   * each other and a shared number is never visible.
   *
   * It surfaces in exactly one case - a complete project whose progress is edited back
   * down, rejoining the running list already holding somebody else's number. The sort
   * breaks ties by name, so the result is deterministic rather than jumpy, and the
   * next save renumbers it away.
   */
  const pendingOrder = useMemo(
    () => (draftOrder ? laneOrderChanges(draftOrder, storedLive) : []),
    [draftOrder, storedLive]
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
      (draftOrder.length !== storedLive.length ||
        storedLive.some((project, index) => draftOrder[index] !== project.project_id)),
    [draftOrder, storedLive]
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
    // Spans EVERY lane, finished ones included. The complete section draws its bars
    // against this same grid, so a shorter span would put the two sections on
    // different scales and make a finished project's bar meaningless next to a
    // running one directly above it.
    const dates = arranged.flatMap((project) => [
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
  }, [arranged, today]);

  // One past the highest lane_order loaded, which is the highest ACTIVE one - this
  // page no longer fetches archived lanes at all - so a new lane can be given the same
  // order as an archived lane nobody can see. That is deliberately tolerated rather
  // than solved with an extra round trip: lane_order carries no uniqueness constraint,
  // the sort in `projects` above breaks ties by name, and the visible consequence of a
  // collision is two lanes adjacent in a different order than expected, and only if an
  // archived lane is ever restored.
  const nextLaneOrder = useMemo(
    () => stored.reduce((max, project) => Math.max(max, project.lane_order + 1), 0),
    [stored]
  );

  const reordering = draftOrder !== null;

  /*
    Rearranging is only meaningful in the stored order.

    "Move up" means "give this a lower lane_order". While the list is sorted by name or
    progress, position on screen is not lane_order, so the arrow would move a row to a
    place it does not visibly occupy - and the save would write an arrangement nobody
    could see they were making. Disabled with the reason stated, rather than hidden.
  */
  /*
    Whether grouping is worth offering, and whether it is on.

    Offered only once somebody has filed something. A "Group by category" toggle on a
    roadmap where nothing is categorised does exactly one thing - draw a single heading
    reading "Everything else" over the whole list - which is a promise of an
    arrangement the data cannot deliver.

    Default ON once the data supports it, because somebody who has gone and filed nine
    lanes did it in order to see them grouped, and making them find a toggle
    afterwards is asking them to ask for what they already asked for.
  */
  /*
    Whether the roadmap is drawn in groups, which is now a fact about the data rather
    than a toggle.

    There was a "Group by category" button and it was removed. A toggle is only worth
    its place when both settings are useful, and "show me these twenty-one lanes as one
    undifferentiated list" is not something anybody wants twice - the ungrouped view was
    the old behaviour kept alive by habit. Grouping simply happens once anything is
    filed, and the one thing the toggle really controlled - whether Reorder is
    available - is now stated in words where the button used to be.
  */
  const groupable = useMemo(() => hasCategories(stored), [stored]);

  /*
    Groups that exist because somebody just made one, and nothing is in them yet.

    Held here rather than stored, because a group IS a value on a project - there is no
    row for one and there does not need to be. The consequence is that an empty group
    does not survive a reload, which is honest: a group with nothing in it is a heading
    and an intention, not a fact about the roadmap. It lives long enough to file the
    first project into, which is the whole job.
  */
  const [newGroups, setNewGroups] = useState<string[]>([]);

  // Offered as soon as a group exists at all, including one that is still empty -
  // otherwise making the very first group would hide the toggle that shows it.
  const grouped = groupable || newGroups.length > 0;

  /*
    Every category in use, for the editor's datalist. Sorted, because this one IS a
    plain list rather than an arrangement of the roadmap - nothing about the order of
    a set of suggestions carries meaning, and alphabetical is the order somebody
    scanning for "did we already call it Data?" can actually scan.
  */
  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const project of stored) {
      const category = (project.category ?? '').trim();
      if (category) {
        seen.add(category);
      }
    }
    // Groups made but not yet filled count too. Without this a brand-new group is
    // offered on its own heading and missing from the project editor's picker, so the
    // two controls for the same fact would disagree about what exists.
    for (const name of newGroups) {
      seen.add(name);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [stored, newGroups]);

  /*
    Reorder is off while grouped, for the reason it is already off under a sort: "move
    up" means "give this a lower lane_order", and under a heading the arrow would move
    a row across a boundary lane_order knows nothing about - so the lane would either
    jump to another group or refuse to move, and neither is what the arrow promises.
  */
  const canReorder = sortMode === 'roadmap' && !grouped;

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
            {/*
              One button that adds things, and then asks what.

              There were two - "New project" and "New group" - which is the same leak
              the Team page's Add/Invite pair had: the person arriving has decided to
              put something on the roadmap and is then asked to pick which of two
              implementations they meant. Worse here, because the honest answer is
              often "a group, and then a project in it", which two buttons make into
              two separate decisions taken in the right order by luck.

              So: +, then a choice with the two options described. Still one click for
              anybody who knows what they want, because the chooser IS the next thing
              under the cursor rather than a modal to dismiss.
            */}
            <PrimaryButton
              type="button"
              onClick={() => {
                setAdding(adding ? null : 'choose');
                setNewGroupName('');
              }}
              aria-expanded={adding !== null}
              title="Add a project or a group"
            >
              {adding ? 'Close' : '+ Add'}
            </PrimaryButton>
            {/* Sorting changes only what this reader sees; it writes nothing. The
                title on each option carries the tie-break and the nulls-last rule,
                which are the two things that otherwise look like bugs. */}
            <Select
              aria-label="Sort projects"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              disabled={arranged.length < 2}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.mode} value={option.mode} title={option.description}>
                  {option.label}
                </option>
              ))}
            </Select>
            {/* Disabled rather than hidden while the New project form is open. Entering
                the mode would have to either close that form, losing what was typed
                into it, or leave it open above a chart whose rows are moving. Two lanes
                is the point at which order is a question worth asking, so below that
                the control would be a mode with nothing to do. */}
            <SecondaryButton
              type="button"
              onClick={() => setDraftOrder(projects.map((p) => p.project_id))}
              disabled={projects.length < 2 || adding !== null || !canReorder}
            >
              Reorder
            </SecondaryButton>
            {/*
              Says why, rather than leaving a greyed button to be puzzled over.

              A visible hint and NOT a `title` on the button. A tooltip never reaches a
              touch or keyboard user, and putting one here also cost the button its
              accessible name - the name computation took the title over the text, so
              the control announced itself as a sentence of explanation rather than as
              "Reorder".
            */}
            {!canReorder && projects.length >= 2 ? (
              <Hint>
                {/* Grouping is no longer a toggle, so this says what to do rather
                    than pointing at a control that is gone: emptying a group is
                    still possible, one lane at a time, from the project editor. */}
                {grouped
                  ? 'Lanes are arranged in groups. Reordering works on an ungrouped roadmap.'
                  : `Sorted by ${SORT_OPTIONS.find((o) => o.mode === sortMode)?.label}. Switch to Roadmap order to rearrange.`}
              </Hint>
            ) : null}
          </>
        )}
        <Spacer />
      </Toolbar>

      {error ? <ErrorText role="alert">{error}</ErrorText> : null}

      {/* Above the chart rather than inside it. A new lane has no row to open an
          inline editor under, and putting the form where the chart's first row would
          be shifts every lane down by the height of a form. */}
      {adding === 'choose' ? (
        <Panel aria-label="What would you like to add?">
          <NewProjectHead>What are you adding?</NewProjectHead>
          <Choices>
            {/*
              Both described rather than just named. "Project" and "Group" alone assume
              the reader already knows this app's vocabulary, and the one person who
              most needs this panel is the one who does not.
            */}
            <Choice type="button" onClick={() => setAdding('project')}>
              <ChoiceName>A project</ChoiceName>
              <ChoiceWhat>
                A lane on the roadmap, with its own phases, dates and DRI.
              </ChoiceWhat>
            </Choice>
            <Choice type="button" onClick={() => setAdding('group')}>
              <ChoiceName>A group</ChoiceName>
              <ChoiceWhat>
                A heading that lanes are filed under — App, Data, QC. Projects go in
                after.
              </ChoiceWhat>
            </Choice>
          </Choices>
        </Panel>
      ) : null}

      {adding === 'group' ? (
        <Panel aria-label="New group">
          <NewProjectHead>New group</NewProjectHead>
          <GroupNameForm
            onSubmit={(e) => {
              e.preventDefault();
              const name = newGroupName.trim();
              if (name) {
                setNewGroups((current) =>
                  current.includes(name) ? current : [...current, name]
                );
              }
              setAdding(null);
              setNewGroupName('');
            }}
          >
            <Input
              autoFocus
              maxLength={40}
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="e.g. App, Data, QC"
              aria-label="New group name"
              // Escape closes it. Without this the only way out of a form opened by
              // mistake is to submit it empty, which is a strange thing to work out.
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setAdding(null);
                }
              }}
            />
            <PrimaryButton type="submit" disabled={!newGroupName.trim()}>
              Add group
            </PrimaryButton>
            <SecondaryButton type="button" onClick={() => setAdding(null)}>
              Cancel
            </SecondaryButton>
          </GroupNameForm>
          <Hint>
            It appears as a heading straight away. Use “+ Add project” on it to file
            lanes in — a group with nothing in it is not saved.
          </Hint>
        </Panel>
      ) : null}

      {adding === 'project' ? (
        <Panel aria-label="New project">
          <NewProjectHead>New project</NewProjectHead>
          <ProjectEditor
            project={null}
            people={roadmap?.people ?? []}
            categories={categories}
            nextLaneOrder={nextLaneOrder}
            onCreated={onProjectCreated}
            onCancel={() => setAdding(null)}
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
            categories={categories}
            grid={grid}
            today={today}
            expanded={expanded}
            onToggle={toggle}
            tasks={tasks ?? undefined}
            onMoveProject={reordering ? onMoveProject : null}
            grouped={grouped}
            extraGroups={newGroups}
            onAddToGroup={onAddToGroup}
            // Every lane, finished ones included: "put QVault v2 into Data" is a
            // reasonable thing to want, and the complete section is still the roadmap.
            assignable={stored}
            onPhaseSaved={onPhaseSaved}
            onPhaseDeleted={onPhaseDeleted}
            onMilestoneSaved={onMilestoneSaved}
            onMilestoneDeleted={onMilestoneDeleted}
            onProjectSaved={onProjectSaved}
          />
        )}
      </Panel>

      {/*
        Finished work, below the roadmap rather than removed from it.

        Absent entirely when nothing has finished, rather than an empty panel headed
        "Complete" - a heading over nothing reads as something that failed to load.

        These lanes keep their move controls off even while reordering: they are not in
        `draftOrder`, so an arrow here would have nothing to reorder against. They are
        still expandable and still editable, because a finished project is a record
        people go back and correct, not a read-only archive.
      */}
      {complete.length > 0 ? (
        <Panel aria-label="Complete projects">
          <CompleteHead>Complete</CompleteHead>
          <CompleteNote>
            {complete.length} project{complete.length === 1 ? '' : 's'} with every phase at
            100%. Ongoing Maintenance bands are not counted, so a project stays here once
            its real work is done.
          </CompleteNote>
          <Timeline
            projects={complete}
            people={roadmap?.people ?? []}
            tasks={tasks ?? undefined}
            categories={categories}
            grid={grid}
            today={today}
            expanded={expanded}
            onToggle={toggle}
            onMoveProject={null}
            onPhaseSaved={onPhaseSaved}
            onPhaseDeleted={onPhaseDeleted}
            onMilestoneSaved={onMilestoneSaved}
            onMilestoneDeleted={onMilestoneDeleted}
            onProjectSaved={onProjectSaved}
          />
        </Panel>
      ) : null}

      {/*
        The key, at the bottom.

        It was in the toolbar, wedged right of the controls, where it was the widest
        thing on the row and pushed the buttons about on a narrow window. It is also
        not a control: it is reference material, consulted when a mark on the chart
        raises a question - and the chart is what you are looking at when that happens,
        so the key belongs after it rather than above it.

        Below the complete section rather than between the two, so there is one key for
        both charts instead of one that appears to belong to the first.
      */}
      <LegendFooter>
        <Legend />
      </LegendFooter>
    </>
  );
}
