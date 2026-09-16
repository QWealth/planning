/**
 * The backlog: every ticket and subtask, in columns by status.
 *
 * WHAT THIS PAGE IS FOR
 * ---------------------
 * The roadmap says what is being built and roughly when. The RFCs say why. This says
 * what is actually on somebody's plate this week - including the work that belongs to
 * no project at all, which is the half the workbook could never hold.
 *
 * COLUMNS BY STATUS, NOT ROWS BY TICKET
 * -------------------------------------
 * Argued out in utils/tasks.ts, where the grouping lives. The short version: a subtask
 * carries its own status, so grouping by ticket buries every in-progress subtask
 * inside a collapsed backlog ticket and leaves the column that should hold them
 * reading empty. The cost is that siblings are scattered, and `parentTitle` on each
 * row is what pays it - the ticket's own page at /tasks/{id} is where the family is
 * shown together.
 *
 * SECTIONED BY PROJECT, THEN COLUMNED BY STATUS
 * ---------------------------------------------
 * One banner per project, in the roadmap's own lane order, with that project's own
 * five-column board underneath it. The grouping is groupTasks, shared with the RFC
 * list - see utils/projects.ts for why unattached work comes first and why a task
 * whose project was deleted still gets a heading.
 *
 * The columns are computed PER SECTION rather than once for the whole board, which is
 * the point: "what is in progress" is a question about a project, and one global
 * In-progress column mixing nine lanes together answered a question nobody asks.
 *
 * EACH SECTION COLLAPSES, AND MOST OF THEM START THAT WAY
 * -------------------------------------------------------
 * The per-section columns cost vertical space - nine sections of five columns is a
 * page nobody reaches the bottom of - so a section's board folds away behind the
 * banner's disclosure arrow, and only the sections you are on the hook for start open.
 * "On the hook for" is three things and they are argued out in defaultOpenGroups in
 * utils/tasks.ts. The banner keeps its name and its count either way, so a shut
 * section still says how much is in it, and Expand all in the toolbar is the way out.
 *
 * FOUR REQUESTS, NOT ONE PER TICKET
 * ---------------------------------
 * The tasks, the status vocabulary, the roadmap for project names, and the roster for
 * the assign-all picker - fired together because none depends on another's answer. The
 * tasks come back as ONE flat list containing both levels; fetching subtasks per
 * ticket would be thirty round trips on a Lambda that scales to zero.
 *
 * The roadmap is fetched WITH archived lanes, so a task attached to a project that has
 * since been archived shows its name rather than a raw uuid. The roster is fetched
 * WITHOUT inactive people: assigning a backlog to somebody who has left is not a
 * choice the picker should offer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import styled from 'styled-components';

import AssignAll from '../components/AssignAll';
import { useIdentity } from '../components/AppShell';
import { Disclosure } from '../components/chart/parts';
import {
  describeError,
  getPeople,
  getRoadmap,
  getTaskStatuses,
  getTasks,
} from '../services/api';
import { palette, radius } from '../styles/theme';
import {
  ErrorText,
  Hint,
  Panel,
  PrimaryButton,
  SecondaryButton,
  Select,
  ToggleButton,
} from '../styles/ui';
import type { Person, Project, StatusInfo, Task } from '../types';
import {
  decorate,
  defaultOpenGroups,
  filterTasks,
  groupKey,
  groupTasks,
  isOverdue,
  todayISO,
  visibleColumns,
} from '../utils/tasks';

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

const Filter = styled(Select)`
  width: auto;
  min-width: 160px;
`;

/*
  The board: a fixed-width track, as many as fit, wrapping when they do not.

  WHY THE TRACK IS FIXED AND NOT `1fr`
  ------------------------------------
  With `1fr` the columns divide the whole width, so hiding the two closed columns
  stretched the remaining three to 430px each and the board stopped looking like a
  board - three wide lists of mostly whitespace with a title floating alone at the
  left. A fixed track means a card is the same readable width whether three columns
  are showing or five, and `justify-content: start` puts the slack on the right
  instead of inside the cards.

  WHY 225px, MEASURED RATHER THAN GUESSED
  ---------------------------------------
  The five columns have to fit on ONE ROW. The board is a pipeline read left to right,
  and a fifth column wrapping underneath the first is not a narrower board, it is a
  misleading one - "Dropped" below "Backlog" reads as a second stage rather than the
  end of the first.

  Five tracks plus four 14px gaps need `5 * track + 56` to fit the grid's width, which
  measures 1194px inside the panel at a 1280px window. That caps the track at 227px.
  300px fitted only four columns, and 250px only four below a 1400px window.

  NOTE FOR ANYONE TEMPTED TO WRITE minmax(200px, 225px) HERE: the floor would be dead
  code. `auto-fit` computes how many tracks to create from the MAX sizing function
  when that is definite, and the tracks then render at exactly that max - measured, as
  `grid-template-columns: 250px 250px 250px 250px` on a grid wide enough for a fifth.
  A minmax floor therefore never binds and buys nothing but the impression that it
  does. Below roughly a 1220px window the columns wrap, which at that size is right.

  `align-items: start` so a column with two cards is two cards tall rather than
  stretching to match the longest one.
*/
const Board = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, 225px);
  justify-content: start;
  gap: 14px;
  align-items: start;
`;

const Groups = styled.div`
  display: flex;
  flex-direction: column;
  gap: 18px;
`;

/*
  The project banner: one band per section, carrying the name, the count and the
  assign-all control.

  A BAND, NOT A HEADING. The RFC list uses a bare `h2` in magenta and it is right
  there, where the sections are short lists of one-line rows. Here each section is a
  five-column board a screen tall, and a heading in that position stops separating
  anything - by the time you have scrolled past forty cards there is nothing to say
  the next row of columns belongs to a different project. The tinted band, the left
  rule and the full-width edge are what make the boundary survive scrolling.

  The treatment is lifted from the chart's phase rows on purpose: same blush ground,
  same pink left rule, same 2px. The roadmap is where these project names are learnt,
  and a second visual language for the same nine names would be one more thing to map.

  It is NOT sticky. A sticky banner would be genuinely useful here and it would also
  overlay the columns of the section above while its own is scrolling past, which on a
  board of nine sections means something is always half-covered.
*/
/*
  Section heading to roadmap lane.

  In the banner rather than on each card, because it is a fact about the project and
  repeating it forty times down a column would make it furniture rather than a link.
*/
const LaneLink = styled(Link)`
  font-size: 11px;
  font-weight: 600;
  color: ${palette.inkSoft};
  text-decoration: none;
  white-space: nowrap;

  &:hover {
    color: ${palette.deepMagenta};
    text-decoration: underline;
  }
`;

/** DOM id of a board section, so the roadmap can scroll to it. */
export function sectionAnchorId(key: string): string {
  return `board-${key}`;
}

const Banner = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 12px;
  padding: 8px 12px;
  border-left: 2px solid ${palette.borderStrong};
  border-radius: ${radius.sm};
  background: ${palette.banner};
`;

/*
  `h2`, so the section headings are a real document outline rather than nine bold
  divs - the column headings under them are `h2` too and had to come down to `h3` to
  keep the order honest.
*/
const BannerName = styled.h2`
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: ${palette.ink};
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Column = styled.section`
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
`;

const ColumnHead = styled.h3`
  font-size: 13px;
  color: ${palette.deepMagenta};
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
`;

const Cards = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

/*
  The whole card is the link. Same reasoning as the RFC list: a title that is
  clickable while the metadata beside it is not is a target people aim at and miss,
  and it costs two focus stops instead of one.
*/
const Card = styled(Link)`
  display: block;
  text-decoration: none;
  color: inherit;
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${palette.card};
  padding: 9px 11px;
  transition: border-color 120ms ease, background 120ms ease;

  &:hover {
    border-color: ${palette.borderStrong};
    background: ${palette.blush};
  }

  &:focus-visible {
    outline: 2px solid ${palette.hotPink};
    outline-offset: 2px;
  }
`;

const CardTitle = styled.span`
  font-weight: 700;
  font-size: 13px;
  color: ${palette.ink};
  display: block;
`;

/*
  The parent's title, above the subtask's own. This one line is what makes grouping
  by status affordable - without it a subtask card says "Write the migration" with no
  hint of which ticket that migration belongs to.
*/
const Parent = styled.span`
  display: block;
  font-size: 11px;
  color: ${palette.inkSoft};
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const CardMeta = styled.div`
  margin-top: 5px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  color: ${palette.inkSoft};
`;

/** An overdue date is the one thing on this page allowed to shout. */
const Due = styled.span<{ $overdue: boolean }>`
  color: ${(p) => (p.$overdue ? palette.deepMagenta : palette.inkSoft)};
  font-weight: ${(p) => (p.$overdue ? 700 : 400)};
`;

const EmptyColumn = styled.p`
  margin: 0;
  padding: 8px 0;
  font-size: 12px;
  color: ${palette.inkSoft};
`;

const Empty = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
`;

/**
 * The sentinel for "unattached only". A select's value is a string, so null needs one.
 *
 * Underscore-prefixed for the reason groupKey's is: project ids are hex, so nothing
 * stored can ever collide with it. It held a literal NUL byte until this was noticed -
 * which worked, and made the whole file read as binary to grep.
 */
const NO_PROJECT = '_none';

export default function TasksPage() {
  const navigate = useNavigate();
  const identity = useIdentity();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [statuses, setStatuses] = useState<StatusInfo[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [projectFilter, setProjectFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');

  /**
   * Which sections are open, keyed by groupKey - so `null` and a project id both fit.
   *
   * Empty until the seeding effect below runs, which means the very first paint after
   * the fetch lands has every section shut for a beat. That is the right way round:
   * the alternative default - everything open - would draw nine five-column boards and
   * then yank eight of them closed, which is a page jumping under the cursor.
   */
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  /** One-shot guard. Same reasoning as RoadmapPage's: the seed is an opening position. */
  const seeded = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rows, vocabulary, roadmap, roster] = await Promise.all([
        getTasks(),
        getTaskStatuses(),
        getRoadmap(true),
        getPeople(),
      ]);
      setTasks(rows);
      setStatuses(vocabulary);
      setProjects(roadmap.projects);
      setPeople(roster);
    } catch (err) {
      setError(describeError(err));
      // An empty list rather than null, so the page renders its empty state instead
      // of sitting on "Loading…" for ever next to an error nobody can act on.
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Open the sections this person is on the hook for, once both answers are in.
   *
   * Seeded from the UNFILTERED board on purpose. Which sections are yours is a fact
   * about the projects and about who owns what, not about the toolbar - seeding from
   * `sections` would make the opening position depend on whatever filter happened to be
   * set, and re-running it after a filter change would fight the viewer's own clicks.
   *
   * Gated on `identity !== null` - "/api/me has answered", not "somebody is signed in".
   * The rule itself, including why the unattached section always opens, is
   * defaultOpenGroups in utils/tasks.ts.
   */
  useEffect(() => {
    if (seeded.current || identity === null || tasks === null) {
      return;
    }
    seeded.current = true;
    setOpenGroups(defaultOpenGroups(groupTasks(tasks, projects), projects, identity.email));
  }, [identity, tasks, projects]);

  /**
   * `/tasks?project=<id>` — arriving from that project's lane on the roadmap.
   *
   * Opens the section and scrolls to it, IN ADDITION to whatever the seeding above
   * opened. Arriving by link is not a reason to shut the sections somebody is on the
   * hook for, and the alternative - landing on a board where the thing you clicked
   * towards is collapsed and below the fold - is the same as not having linked.
   *
   * Its own one-shot, so a later render cannot re-open a section the viewer has since
   * shut. The scroll waits a frame for the section to exist in the DOM, the same as
   * the roadmap's.
   */
  const [params] = useSearchParams();
  const linkedProject = params.get('project');
  const jumped = useRef(false);

  useEffect(() => {
    if (jumped.current || !linkedProject || tasks === null) {
      return;
    }
    jumped.current = true;
    const key = groupKey(linkedProject);
    setOpenGroups((current) => new Set(current).add(key));
    requestAnimationFrame(() => {
      document
        .getElementById(sectionAnchorId(key))
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [linkedProject, tasks]);

  const toggleGroup = useCallback((key: string) => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }, []);

  /*
    The owner list comes from the tasks themselves, not from the roster. Work is
    routinely owned by somebody who has not been onboarded here yet, and a filter
    built from the roster would offer a name that matches nothing while hiding the
    one address actually on the board.
  */
  const owners = useMemo(() => {
    const seen = new Set<string>();
    for (const task of tasks ?? []) {
      if (task.owner_email) {
        seen.add(task.owner_email);
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [tasks]);

  const visible = useMemo(
    () =>
      filterTasks(tasks ?? [], statuses, {
        showClosed,
        // '' is "no project filter" and must reach filterTasks as undefined; the
        // sentinel is "unattached only" and must reach it as null. Collapsing the
        // two would make the commonest interesting question - what is not attached
        // to anything - unaskable.
        projectId: projectFilter === '' ? undefined : projectFilter === NO_PROJECT ? null : projectFilter,
        ownerEmail: ownerFilter || undefined,
      }),
    [tasks, statuses, showClosed, projectFilter, ownerFilter]
  );

  /*
    Decorated from the WHOLE list, not from the filtered one. A subtask's parent may
    be filtered out - it is closed, or owned by somebody else - and looking the title
    up in the filtered list would blank the one line that says what the subtask
    belongs to, precisely when the parent is not on screen to make it obvious.
  */
  const rows = useMemo(
    () => decorate(tasks ?? [], projects, statuses),
    [tasks, projects, statuses]
  );

  /*
    One section per project, each carrying its own columns.

    The columns are built INSIDE the section rather than once for the page, because a
    status column is only meaningful within a project - see the header. The section
    keeps its unsplit task list too, which is what the assign-all control writes to:
    it has to be the rows on screen, and after toColumns they are scattered across
    five arrays.
  */
  const sections = useMemo(
    () =>
      groupTasks(visible, projects).map((group) => ({
        ...group,
        columns: visibleColumns(group.tasks, statuses, showClosed),
      })),
    [visible, projects, statuses, showClosed]
  );

  /**
   * Whether every section ON SCREEN is open - which is the question the toolbar asks.
   *
   * Measured against `sections` rather than against every project, because a filtered
   * board's button has to describe the board in front of you. The cost is that
   * "Collapse all" leaves a section open if a filter is currently hiding it; it reopens
   * where it was when the filter comes off, which is the lesser surprise of the two.
   */
  const allOpen = useMemo(
    () =>
      sections.length > 0 &&
      sections.every((section) => openGroups.has(groupKey(section.projectId))),
    [sections, openGroups]
  );

  const closedCount = useMemo(() => {
    const closed = new Set(statuses.filter((s) => s.closed).map((s) => s.status));
    return (tasks ?? []).filter((task) => closed.has(task.status)).length;
  }, [tasks, statuses]);

  const today = todayISO();

  return (
    <>
      <Panel>
        <Toolbar>
          <Status>
            {tasks === null
              ? 'Loading…'
              : `${visible.length} ${visible.length === 1 ? 'task' : 'tasks'}`}
          </Status>

          <Filter
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            aria-label="Filter by project"
          >
            <option value="">All projects</option>
            <option value={NO_PROJECT}>Not tied to a project</option>
            {projects.map((project) => (
              <option key={project.project_id} value={project.project_id}>
                {project.name}
              </option>
            ))}
          </Filter>

          {owners.length > 0 ? (
            <Filter
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              aria-label="Filter by owner"
            >
              <option value="">Anyone</option>
              {owners.map((owner) => (
                <option key={owner} value={owner}>
                  {owner}
                </option>
              ))}
            </Filter>
          ) : null}

          <Spacer />
          <SecondaryButton
            type="button"
            onClick={() =>
              setOpenGroups(
                allOpen ? new Set() : new Set(sections.map((s) => groupKey(s.projectId)))
              )
            }
            disabled={sections.length === 0}
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </SecondaryButton>
          {closedCount > 0 ? (
            <ToggleButton
              type="button"
              $on={showClosed}
              aria-pressed={showClosed}
              onClick={() => setShowClosed((on) => !on)}
            >
              {showClosed ? 'Hide' : 'Show'} {closedCount} closed
            </ToggleButton>
          ) : null}
          <PrimaryButton type="button" onClick={() => navigate('/tasks/new')}>
            Add a task
          </PrimaryButton>
        </Toolbar>
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}
      </Panel>

      {tasks !== null && tasks.length === 0 ? (
        <Panel>
          <Empty>
            <strong>Nothing on the board yet.</strong>
            <Hint>
              A task can belong to a project, to a ticket, to both, or to neither. Tickets and
              subtasks are the same thing here — a subtask is just a task that names its ticket.
            </Hint>
            <PrimaryButton type="button" onClick={() => navigate('/tasks/new')}>
              Add the first one
            </PrimaryButton>
          </Empty>
        </Panel>
      ) : null}

      {/*
        Nothing matched the filters, but the board is not empty. Said out loud rather
        than left as a page with a toolbar and nothing under it, which is
        indistinguishable from a failed load.
      */}
      {tasks !== null && tasks.length > 0 && sections.length === 0 ? (
        <Panel>
          <Hint>Nothing matches those filters.</Hint>
        </Panel>
      ) : null}

      <Groups>
        {sections.map((section) => {
          const key = groupKey(section.projectId);
          const open = openGroups.has(key);
          return (
            /* The anchor a roadmap lane's Board link scrolls to. On the Panel rather
               than on the Banner, so the heading is not flush against the top edge of
               the viewport when it arrives. */
            <Panel key={key} id={sectionAnchorId(key)}>
              <Banner>
                {/*
                  The chart's own disclosure, not a second one: the banner already
                  borrows the phase row's blush ground and pink rule, and the arrow that
                  opens a lane on the Roadmap should be the arrow that opens a section
                  here. parts.ts does the rotation.
                */}
                <Disclosure
                  type="button"
                  $open={open}
                  onClick={() => toggleGroup(key)}
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${section.title}`}
                >
                  &#9656;
                </Disclosure>
                <BannerName title={section.title}>{section.title}</BannerName>
                <Hint>
                  · {section.tasks.length} {section.tasks.length === 1 ? 'task' : 'tasks'}
                </Hint>
                {/* The other half of the round trip the roadmap's own "Board" link
                    opens. The board says what is being done this week and the lane
                    says when it was all supposed to happen, and until now the only
                    route between the two was the tab bar and a scroll. Absent for the
                    loose-tasks section, which belongs to no lane. */}
                {section.projectId ? (
                  <LaneLink
                    to={`/?project=${encodeURIComponent(section.projectId)}`}
                    title="Show this project on the roadmap"
                  >
                    On the roadmap ↗
                  </LaneLink>
                ) : null}
                <Spacer />
                {/*
                  Handed this section's own visible tasks, not its project id, so it can
                  only ever write to the rows drawn beneath it. See AssignAll.

                  Which is exactly why it goes away when the section is shut: there are no
                  rows beneath it then, and a bulk write whose scope you cannot see is the
                  one thing AssignAll's confirm step exists to prevent. The count in the
                  banner is not enough - it says how many, not which.
                */}
                {open ? (
                  <AssignAll
                    tasks={section.tasks}
                    people={people}
                    groupTitle={section.title}
                    onDone={() => void load()}
                  />
                ) : null}
              </Banner>
              {open ? (
                <Board>
                  {section.columns.map((column) => (
                    <Column key={column.status}>
                      <ColumnHead title={column.description}>
                        {column.label} <Hint>· {column.tasks.length}</Hint>
                      </ColumnHead>
                      {column.tasks.length === 0 ? (
                        // Kept rather than dropped: an empty column under a heading is a
                        // fact about the week, whereas a missing column reads as a board
                        // that failed to load.
                        <EmptyColumn>—</EmptyColumn>
                      ) : (
                        <Cards>
                          {column.tasks.map((task) => {
                            const row = rows.get(task.item_id);
                            return (
                              <li key={task.item_id}>
                                <Card to={`/tasks/${encodeURIComponent(task.item_id)}`}>
                                  {row?.parentTitle ? <Parent>↳ {row.parentTitle}</Parent> : null}
                                  <CardTitle>{task.title}</CardTitle>
                                  <CardMeta>
                                    {/*
                                      The project chip is gone from the card: the banner
                                      directly above it says the same thing, and printing
                                      it on all forty cards under that banner is forty
                                      copies of the heading.
                                    */}
                                    {task.owner_email ? <span>{task.owner_email}</span> : null}
                                    {task.due ? (
                                      <Due $overdue={isOverdue(task.due, today)}>Due {task.due}</Due>
                                    ) : null}
                                    {row && row.subtaskCount > 0 ? (
                                      <span>
                                        {row.subtasksClosed} of {row.subtaskCount} done
                                      </span>
                                    ) : null}
                                  </CardMeta>
                                </Card>
                              </li>
                            );
                          })}
                        </Cards>
                      )}
                    </Column>
                  ))}
                </Board>
              ) : null}
            </Panel>
          );
        })}
      </Groups>
    </>
  );
}
