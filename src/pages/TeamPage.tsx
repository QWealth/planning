/**
 * The team: who is on the roster, what they specialise in, and what they carry.
 *
 * This page exists because of the hole the workbook left. Eighteen owner slots came
 * across the migration null and the roadmap can only report that fact - it cannot
 * tell you who could plausibly fill one, because a Gantt chart has no idea that Ha
 * does front-end and Meherzad does infrastructure. That is the question this page
 * answers, so the two views are complementary rather than duplicates.
 *
 * It reads /api/people/workload rather than /api/people. The distinguishing question
 * is "who is loaded and who is free", and that is only visible once ownership is
 * aggregated per person instead of per project.
 *
 * The roadmap is fetched too, with archived lanes included. It started as a lookup
 * from project id to name - a person can perfectly well be the DRI of an archived
 * project, and an id that fails to resolve renders as a bare uuid next to nine real
 * names - and it now also feeds the chart at the top of the page, which is the same
 * phases read down the owner column instead of across the lane.
 *
 * That chart is why the whole roadmap is kept in state rather than just the names.
 * The counts in the roster answer "how much is this person carrying"; only the dates
 * answer "and when", which is the half needed to plan ahead. See utils/assignments.ts
 * for the transpose, and components/chart/TeamChart.tsx for what it draws.
 *
 * WHO MAY EDIT WHAT
 *
 * Everybody signed in may add and edit THEMSELVES; only an admin may touch anyone
 * else, or deactivate or delete at all. This page hides the controls that would be
 * refused - see fast/app/routes/people.py, which enforces every one of them again, so
 * nothing here is load-bearing for security. It is load-bearing for not offering
 * somebody a button whose only outcome is a 403.
 *
 * Note the asymmetry with the rest of the app: the roadmap - projects, phases,
 * milestones - stays editable by everyone. The team schedules its own work. Only the
 * roster, which is about people rather than plans, has an admin tier.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';

import { useIdentity } from '../components/AppShell';
import InvitePanel from '../components/InvitePanel';
import TeamChart, { TeamChartKey, type TeamChartRow } from '../components/chart/TeamChart';
import PersonEditor from '../components/PersonEditor';
import { describeError, getRoadmap, getRoles, getSkills, getWorkload } from '../services/api';
import { palette, radius } from '../styles/theme';
import { assignmentsByPerson, noAssignments } from '../utils/assignments';
import { buildGrid, todayISO } from '../utils/dates';
import { schedulable, splitObservers } from '../utils/observers';
import {
  ErrorText,
  Hint,
  Panel,
  PrimaryButton,
  SecondaryButton,
  ToggleButton,
} from '../styles/ui';
import { compareSpecialisations, starGlyphs, starLabel } from '../utils/skills';
import type {
  Person,
  PersonWorkload,
  Project,
  RoleInfo,
  SkillInfo,
  Unassigned,
} from '../types';

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
`;

/*
  The two views sit tight against each other so they read as one control, and on a row
  of their own rather than in the toolbar.

  They were in the toolbar beside Add and Invite, and that put two different kinds of
  thing in one line: Roster and Schedule choose WHAT THIS PAGE IS, the buttons act
  within whatever has been chosen. Sitting them together made the switch read as a
  third and fourth action, and the toolbar below now belongs unambiguously to the view
  above it.
*/
const ViewSwitch = styled.div`
  display: flex;
  gap: 4px;
  align-self: flex-start;
`;

/* The two ways in, inside the add panel. Same treatment as ViewSwitch, one level down. */
const ModeSwitch = styled(ViewSwitch)`
  margin-bottom: 12px;
`;

const Spacer = styled.div`
  flex: 1;
`;

const Status = styled.p`
  margin: 0;
  color: ${palette.inkSoft};
`;

const Roster = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

/**
 * The same list, with room for the line of explanation that sits above it. The rows
 * themselves are deliberately identical to the roster's - an observer is not a lesser
 * kind of person, just one who is not currently holding anything.
 */
const ObserverRoster = styled(Roster)`
  margin-top: 10px;
`;

const Row = styled.li<{ $inactive: boolean }>`
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${(p) => (p.$inactive ? palette.inactive : palette.card)};
  /* Deactivated people stay legible rather than being faded to grey. They are still
     the recorded owner of real work, and the roadmap will keep showing their name. */
  opacity: ${(p) => (p.$inactive ? 0.75 : 1)};
  overflow: hidden;
`;

/*
  One person, one line.

  The roster used to give each person a four-column grid two or three lines tall: name,
  email, roles, every skill chip they hold, every workload chip, and an Edit button. At
  eighteen people that is a page and a half of scrolling to answer "who is on this
  team", which is the one question the screen is named after.

  So the line carries only what distinguishes people from each other at a glance - who
  they are, what they do, and roughly how much they are holding - and everything else
  moves behind a disclosure. The detail is not lost, it is one click away and it is
  where it can be read properly rather than squeezed into a column two words wide.

  The email is gone from the line entirely. It was the widest thing on it and it
  identifies nobody a name does not already; it is still in the detail below, because
  it is what you copy when you actually need to write to somebody.
*/
const Line = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  min-height: 34px;
`;

/*
  The name and roles are the disclosure control, not a separate chevron beside them.

  A 20px triangle is a small target and it makes the row's most obvious text inert -
  people click names. This makes the whole left half the button, which is both the
  larger target and the one somebody would try first.
*/
const Disclose = styled.button`
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 2px 0;
  margin: 0;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: ${radius.sm};

  &:hover span:first-child {
    color: ${palette.deepMagenta};
  }

  &:focus-visible {
    outline: 2px solid ${palette.turquoise};
    outline-offset: 2px;
  }
`;

const Caret = styled.span<{ $open: boolean }>`
  flex-shrink: 0;
  font-size: 9px;
  line-height: 1;
  color: ${palette.inkSoft};
  transform: rotate(${(p) => (p.$open ? '90deg' : '0deg')});
  transition: transform 0.12s ease;
`;

const Name = styled.span`
  font-size: 13px;
  font-weight: 700;
  color: ${palette.ink};
  white-space: nowrap;
`;

/*
  Roles on the same line as the name, in the muted ink.

  Plain text rather than chips, which is the rule RoleLine already established and the
  reason survives compression: chips here would compete with the workload chips a few
  inches to the right and imply the two are the same kind of fact.
*/
const Roles = styled.span`
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: ${palette.deepMagenta};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

/* Not an error - everybody seeded from the workbook is in this state. It is a prompt. */
const NoRoles = styled.span`
  font-size: 11px;
  font-style: italic;
  color: ${palette.inkSoft};
  white-space: nowrap;
`;

/*
  The load, as one short string rather than three chips.

  "DRI ×2 · 5 phases" fits where three bordered chips do not, and on a line this tight
  the chips were doing more to fill space than to separate facts. The detail below
  still names every one of them.
*/
const Load = styled.span`
  flex-shrink: 0;
  font-size: 11px;
  color: ${palette.inkSoft};
  white-space: nowrap;
`;

const Cell = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
`;

/*
  What the disclosure reveals: skills, and the work itself by name.

  Named rather than counted, throughout. "DRI ×2" on the line above says how much;
  this says which, and which is the half somebody actually needs before they can ask
  anybody for anything.
*/
const Detail = styled.div`
  border-top: 1px solid ${palette.hairline};
  background: ${palette.blush};
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const DetailRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
`;

const DetailLabel = styled.span`
  flex-shrink: 0;
  min-width: 66px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${palette.inkSoft};
`;

const DetailText = styled.span`
  font-size: 12px;
  line-height: 1.5;
  color: ${palette.ink};
  overflow-wrap: anywhere;
`;

/*
  A phase or a project, linked to where it lives.

  The roster is where somebody notices that one person holds four lanes; the roadmap is
  where they do something about it. Making them go and find it by name is how that stops
  happening - the same argument the milestone log's project link makes.
*/
/*
  The qualifier after a linked name - "DRI", or the lane a phase belongs to.

  Inside the link rather than beside it, so the whole "Tax DRI" reads and clicks as one
  thing. Dimmed rather than given its own colour, because it is the same sentence at a
  lower volume and a second colour here would imply a second kind of fact.
*/
const Faint = styled.span`
  font-weight: 600;
  opacity: 0.6;
`;

const DetailLink = styled(Link)`
  font-size: 12px;
  font-weight: 600;
  color: ${palette.deepMagenta};
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
`;

const SkillChip = styled.span<{ $stars: number; $learning: boolean }>`
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  border-radius: ${radius.pill};
  padding: 2px 9px;
  white-space: nowrap;
  color: ${(p) =>
    p.$stars >= 3 ? palette.onAccent : p.$stars === 0 ? palette.deepMagenta : palette.ink};
  background: ${(p) =>
    p.$stars >= 3 ? palette.hotPink : p.$stars === 0 ? palette.card : palette.blush};
  border: 1px ${(p) => (p.$stars === 0 ? 'dashed' : 'solid')}
    ${(p) => (p.$stars >= 3 ? palette.hotPink : palette.borderStrong)};

  /*
    Appetite marked on the right edge, so it is visible on a chip that ALSO has stars.
    Stars and wanting the work are independent now, and without this a three-star
    person who wants more of it would be indistinguishable from one who does not -
    which is the whole reason the two were split apart in the first place.
  */
  border-right-width: ${(p) => (p.$learning ? '3px' : undefined)};
  border-right-color: ${(p) => (p.$learning ? palette.deepMagenta : undefined)};
`;

/*
  The stars inside a chip.

  Dimmed with opacity rather than given their own colour, so one rule works on the
  hot-pink three-star fill and on the pale fills underneath it. A fixed colour would
  have to be picked twice and would be wrong on one of them.
*/
const ChipStars = styled.span`
  letter-spacing: 0.5px;
  font-size: 9px;
  opacity: 0.8;
`;

/** One chip's tooltip: the rating in words, and appetite when it is set. */
function skillTitle(stars: number, wantsToLearn: boolean): string {
  return wantsToLearn ? `${starLabel(stars)} — and wants this work` : starLabel(stars);
}

const EditorPanel = styled.div`
  border-top: 1px solid ${palette.border};
  background: ${palette.blush};
  padding: 14px 16px 16px;
`;

const NewPanel = styled(Panel)`
  border-color: ${palette.borderStrong};
  margin-bottom: 12px;
`;

const ChartPanel = styled(Panel)`
  margin-bottom: 12px;
  /* The chart has its own horizontal scroller below MIN_CHART_WIDTH, so the panel
     must not add a second one around it. */
  overflow: visible;
`;

const ChartNotes = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
`;

const PanelTitle = styled.h2`
  font-size: 15px;
  color: ${palette.deepMagenta};
  margin-bottom: 10px;
`;

/**
 * The aftermath of a delete: what is now unassigned, and a way to dismiss it.
 *
 * Not an ErrorText - nothing went wrong - and not a toast, because the content is a
 * list of lanes somebody may need to act on and a message that removes itself after
 * four seconds is no use for that.
 */
const Notice = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid ${palette.borderStrong};
  border-radius: ${radius.md};
  background: ${palette.blush};
  color: ${palette.ink};
  font-size: 13px;
  line-height: 1.45;
`;

export default function TeamPage() {
  const identity = useIdentity();
  const [people, setPeople] = useState<PersonWorkload[] | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [editing, setEditing] = useState<string | null>(null);
  /*
    Which row is showing its detail, which is a SEPARATE thing from which row is being
    edited. Reading somebody's skills and changing them are different intentions, and
    collapsing them into one disclosure means every look at what Ha can do opens a form
    with a Save button on it - which is how somebody changes a colleague's record by
    accident. One at a time, like `editing`: two open panels in a list this dense is
    the bulk the compression was for.
  */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /*
    Which way in, once the add panel is open.

    There were two buttons here - "Add person" and "Invite somebody" - and the argument
    for keeping them apart was true and beside the point: one grants a login, the other
    creates a roster row. Nobody arriving at this page is thinking in those terms. They
    are thinking "get Priya onto this", and being asked to know which of two buttons
    implements that is the tool leaking its own storage layout.

    So one button, and the choice it used to encode becomes a choice INSIDE the panel,
    where it can be stated in a sentence rather than inferred from two labels. Invite is
    the default because it is the ordinary case: the person signs in and fills in their
    own entry, which is both less typing here and more accurate than an admin guessing
    at somebody else's skills.
  */
  const [addMode, setAddMode] = useState<'invite' | 'manual'>('invite');
  /*
    Which of the two this page is showing.

    The roster and the schedule answer different questions - "who is here and what can
    they do" versus "who is busy and when" - and showing them stacked meant the roster
    was always below a full-width chart, so the page never opened on the thing it is
    named after. One at a time, roster first.
  */
  const [view, setView] = useState<'roster' | 'schedule'>('roster');
  const [notice, setNotice] = useState<string | null>(null);

  const today = useMemo(() => todayISO(), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // In parallel: none of the four depends on another, and serially this is four
      // Lambda round trips before the first name appears.
      const [workload, vocabulary, roleVocabulary, roadmap] = await Promise.all([
        getWorkload(),
        getSkills(),
        getRoles(),
        getRoadmap(true),
      ]);
      setPeople(workload);
      setSkills(vocabulary);
      setRoles(roleVocabulary);
      setProjects(roadmap.projects);
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
   * Fold a saved person back into the list.
   *
   * The response is a Person and carries no workload counts, so the existing row's
   * counts are kept rather than defaulted to zero - editing somebody's name must not
   * make it look as though they just lost four projects. A new person genuinely owns
   * nothing, so zeroes are correct there.
   */
  const onSaved = useCallback((saved: Person) => {
    setPeople((current) => {
      const list = current ?? [];
      const existing = list.find((p) => p.email === saved.email);
      const merged: PersonWorkload = {
        ...saved,
        dri_project_ids: existing?.dri_project_ids ?? [],
        support_project_ids: existing?.support_project_ids ?? [],
        owned_phase_count: existing?.owned_phase_count ?? 0,
      };
      return existing
        ? list.map((p) => (p.email === saved.email ? merged : p))
        : [...list, merged];
    });
    setEditing(null);
    setAdding(false);
  }, []);

  /**
   * Drop a deleted person and say what their removal unassigned.
   *
   * The notice is not decoration. The delete blanked assignments on lanes that are
   * not on this screen, so without it the only visible effect is one row vanishing
   * from the roster, and the four lanes that just lost their DRI are a surprise
   * waiting on the Roadmap page. It stays up until dismissed for the same reason.
   *
   * No refetch: unassigning one person cannot change anyone else's counts, so the
   * local removal is already the correct state.
   */
  const onDeleted = useCallback((email: string, unassigned: Unassigned) => {
    setPeople((current) => (current ?? []).filter((p) => p.email !== email));
    setEditing(null);

    // Mirror the blanking the server just did, rather than refetching. The chart is
    // drawn from these projects, so leaving the email in place would keep drawing
    // spans for somebody who no longer exists - and the notice below would be
    // contradicted by the picture directly above it.
    const gone = email.toLowerCase();
    setProjects((current) =>
      current.map((project) => ({
        ...project,
        dri_email: (project.dri_email ?? '').toLowerCase() === gone ? null : project.dri_email,
        support_email:
          (project.support_email ?? '').toLowerCase() === gone ? null : project.support_email,
        phases: project.phases.map((phase) =>
          (phase.owner_email ?? '').toLowerCase() === gone
            ? { ...phase, owner_email: null }
            : phase
        ),
      }))
    );

    const parts: string[] = [];
    if (unassigned.dri.length > 0) {
      parts.push(`DRI on ${unassigned.dri.map((p) => p.project_name).join(', ')}`);
    }
    if (unassigned.support.length > 0) {
      parts.push(`Support on ${unassigned.support.map((p) => p.project_name).join(', ')}`);
    }
    if (unassigned.phases.length > 0) {
      parts.push(
        unassigned.phases.map((p) => `${p.phase_name} (${p.project_name})`).join(', ')
      );
    }

    setNotice(
      parts.length > 0
        ? `Deleted ${email}. Now unassigned: ${parts.join('; ')}.`
        : `Deleted ${email}. They held no assignments.`
    );
  }, []);

  const labels = useMemo(
    () => new Map(skills.map((s) => [s.skill, s.label])),
    [skills]
  );

  const roleLabels = useMemo(() => new Map(roles.map((r) => [r.role, r.label])), [roles]);

  const projectNames = useMemo(
    () => new Map(projects.map((p) => [p.project_id, p.name])),
    [projects]
  );

  /** The roadmap transposed: every email named in the work, and what it holds. */
  const assignments = useMemo(() => assignmentsByPerson(projects), [projects]);

  /**
   * The chart's own grid.
   *
   * Built from the same phase dates the Roadmap page uses, so the two charts share a
   * time axis and a today line and can be read against each other. Milestones are
   * deliberately absent: nothing on this chart is a milestone, so widening the span
   * for one would add empty weeks to the right of every row.
   */
  const grid = useMemo(() => {
    const dates = projects.flatMap((project) =>
      project.phases.flatMap((phase) =>
        [phase.start, phase.end].filter((d): d is string => d !== null)
      )
    );
    const start = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : today;
    const end = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : today;
    return buildGrid(start, end, today);
  }, [projects, today]);

  /**
   * The signed-in address, lowercased, and whether they are an admin.
   *
   * Identity is null until /api/me answers, and that transient state is deliberately
   * treated as "a plain member who is nobody": the buttons appear a beat late rather
   * than appearing and then being taken away. Defaulting the other way would flash a
   * Delete button at everyone on every load.
   */
  const me = identity?.email?.toLowerCase() ?? null;
  const isAdmin = identity?.is_admin ?? false;

  /** True for the row that is this caller's own. Case-folded: Cognito is not consistent. */
  const isMe = useCallback(
    (person: Person) => me !== null && person.email.toLowerCase() === me,
    [me]
  );

  const sorted = useMemo(() => {
    const list = people ?? [];
    // Active first, then by name. Deactivated people sinking to the bottom means the
    // list reads as the current team without having to filter them out entirely.
    return [...list].sort(
      (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)
    );
  }, [people]);

  /**
   * Everyone, deactivated included.
   *
   * There was a "Show deactivated" toggle here and it was removed as clutter. Hiding
   * them by default instead would have been the obvious reading of that, and it is a
   * trap: `active` is still an admin-editable checkbox on the person form, so the
   * first admin to untick it would make that person vanish from the only screen that
   * can tick it back on. Deactivated rows are marked "(deactivated)" and greyed, which
   * is enough to tell them apart without hiding them.
   */
  const visible = sorted;

  /**
   * The roster, minus the people who are only watching.
   *
   * See utils/observers.ts for the rule and for why it is two conditions. The short
   * version: sole-role "Outside engineering" AND holding nothing. Anyone carrying a
   * lane stays in the list above whatever their role says, so this can never hide
   * accountability - it only shortens the list of people you might staff something to.
   */
  const { roster: rosterPeople, observers } = useMemo(() => splitObservers(visible), [visible]);

  /**
   * The chart's rows: everybody the schedule should draw, empty weeks included.
   *
   * The empty rows used to be dropped, on the grounds that a Gantt row with no marks
   * carries no information. That was backwards. A row of free weeks is the answer to
   * "who could take this", which is the question that made this page exist - and
   * dropping those rows meant the chart could only ever show you the people who were
   * already busy. Emptiness is the signal, not the absence of one.
   *
   * Driven off `visible` on purpose, so the two halves of the page cannot disagree
   * about who is on the roster, and filtered by `schedulable` rather than by whether
   * the person holds anything. See utils/observers.ts for the two roles that are left
   * out and why leaving them in would read as capacity that does not exist.
   */
  const chartRows = useMemo<TeamChartRow[]>(
    () =>
      visible.filter(schedulable).map((person) => ({
        email: person.email,
        name: person.name,
        active: person.active,
        assignments:
          assignments.get(person.email.toLowerCase()) ?? noAssignments(person.email),
      })),
    [visible, assignments]
  );

  const chartOmitted = visible.length - chartRows.length;

  /**
   * Whether Add would do anything for this caller.
   *
   * An admin may add anybody. A plain member may add exactly themselves, so once they
   * are on the roster the button has nothing left to do - which is the state almost
   * everyone is in almost all of the time - and it goes away rather than sitting there
   * offering an action that can only be refused.
   */
  const onRoster = me !== null && sorted.some((p) => p.email.toLowerCase() === me);
  const canAdd = isAdmin || (me !== null && !onRoster);

  /** Project ids rendered as names, with the unresolvable id shown rather than hidden. */
  const projectList = (ids: string[]) =>
    ids.map((id) => projectNames.get(id) ?? id).sort((a, b) => a.localeCompare(b));

  /**
   * Everything one person holds, by name rather than by count.
   *
   * Built from the projects the page already has rather than from PersonWorkload's
   * three numbers, because the numbers cannot say WHICH - and which is the half
   * somebody needs before they can go and ask anybody for anything. The counts on the
   * line above and these lists come from two different places, which is a real risk of
   * disagreement; they are computed from the same roadmap fetch, so the only way they
   * diverge is a stale response, and both would be stale together.
   */
  const holdings = useCallback(
    (email: string) => {
      const mine = email.toLowerCase();
      const dri: Project[] = [];
      const support: Project[] = [];
      const phases: { id: string; name: string; project: Project }[] = [];

      for (const project of projects) {
        if ((project.dri_email ?? '').toLowerCase() === mine) {
          dri.push(project);
        }
        if ((project.support_email ?? '').toLowerCase() === mine) {
          support.push(project);
        }
        for (const phase of project.phases) {
          if ((phase.owner_email ?? '').toLowerCase() === mine) {
            phases.push({ id: phase.phase_id, name: phase.name, project });
          }
        }
      }

      return { dri, support, phases };
    },
    [projects]
  );

  /**
   * One roster row. Extracted so the roster and the observers list below are the
   * SAME row rather than two that look alike - an observer is an ordinary person
   * who happens to hold nothing, and their row must stay editable, deletable and
   * expandable exactly like everybody else's. Two copies of this JSX would drift.
   */
  const renderPerson = (person: PersonWorkload) => {
    const open = editing === person.email;
    const showing = expanded === person.email;
    const mine = isMe(person);
    const canEdit = isAdmin || mine;
    const held = showing ? holdings(person.email) : null;

    /*
      The load, as one string. Empty for somebody holding nothing, which draws as
      nothing at all - there was a "Carrying nothing" marker here once and it was
      removed for the same reason: the absence already says it, more quietly.
    */
    const load = [
      person.dri_project_ids.length ? `DRI ×${person.dri_project_ids.length}` : null,
      person.support_project_ids.length
        ? `Support ×${person.support_project_ids.length}`
        : null,
      person.owned_phase_count
        ? `${person.owned_phase_count} ${person.owned_phase_count === 1 ? 'phase' : 'phases'}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const held_ = [...person.specialisations].sort(compareSpecialisations);

    return (
      <Row key={person.email} $inactive={!person.active}>
        <Line>
          <Disclose
            type="button"
            aria-expanded={showing}
            onClick={() => setExpanded(showing ? null : person.email)}
          >
            {/* A triangle rather than a chevron glyph, because ▸ rotates to ▾ with
                one transform and needs no second character that might not be in the
                font. aria-hidden: the button's aria-expanded already says the state. */}
            <Caret $open={showing} aria-hidden="true">
              ▶
            </Caret>
            <Name>
              {person.name}
              {person.active ? '' : ' (deactivated)'}
            </Name>
            {person.roles.length > 0 ? (
              <Roles>
                {/* Falls back to the raw value, so a role dropped from the
                    vocabulary still shows rather than blanking the line. */}
                {person.roles.map((r) => roleLabels.get(r) ?? r).join(' · ')}
              </Roles>
            ) : (
              <NoRoles>{mine ? 'no role set — add yours' : 'no role set'}</NoRoles>
            )}
          </Disclose>

          {/* Stated on the line rather than hidden in the detail: "how many skills"
              is what tells you whether opening this row is worth it, and a roster of
              people with nothing recorded is the thing the page exists to fix. */}
          <Load>
            {held_.length
              ? `${held_.length} ${held_.length === 1 ? 'skill' : 'skills'}`
              : 'no skills'}
          </Load>
          {load ? <Load>{load}</Load> : null}

          {canEdit ? (
            <SecondaryButton
              type="button"
              onClick={() => {
                setEditing(open ? null : person.email);
                setExpanded(null);
              }}
              aria-expanded={open}
            >
              {open ? 'Close' : mine && !isAdmin ? 'Edit yours' : 'Edit'}
            </SecondaryButton>
          ) : null}
        </Line>

        {showing && held ? (
          <Detail>
            <DetailRow>
              <DetailLabel>Skills</DetailLabel>
              <Cell>
                {held_.length === 0 ? (
                  <DetailText>
                    Nothing recorded.{' '}
                    {mine ? 'Add yours with Edit.' : 'Ask them to fill theirs in.'}
                  </DetailText>
                ) : (
                  held_.map((s) => (
                    <SkillChip
                      key={s.skill}
                      $stars={s.stars}
                      $learning={s.wants_to_learn}
                      title={skillTitle(s.stars, s.wants_to_learn)}
                    >
                      <ChipStars aria-hidden="true">{starGlyphs(s.stars)}</ChipStars>
                      {labels.get(s.skill) ?? s.skill}
                    </SkillChip>
                  ))
                )}
              </Cell>
            </DetailRow>

            {held.dri.length > 0 || held.support.length > 0 ? (
              <DetailRow>
                <DetailLabel>Projects</DetailLabel>
                <Cell>
                  {held.dri.map((project) => (
                    <DetailLink
                      key={`dri-${project.project_id}`}
                      to={`/?project=${encodeURIComponent(project.project_id)}`}
                    >
                      {project.name} <Faint>DRI</Faint>
                    </DetailLink>
                  ))}
                  {held.support.map((project) => (
                    <DetailLink
                      key={`sup-${project.project_id}`}
                      to={`/?project=${encodeURIComponent(project.project_id)}`}
                    >
                      {project.name} <Faint>support</Faint>
                    </DetailLink>
                  ))}
                </Cell>
              </DetailRow>
            ) : null}

            {held.phases.length > 0 ? (
              <DetailRow>
                <DetailLabel>Phases</DetailLabel>
                <Cell>
                  {held.phases.map((phase) => (
                    <DetailLink
                      key={phase.id}
                      to={`/?project=${encodeURIComponent(phase.project.project_id)}`}
                    >
                      {phase.name} <Faint>{phase.project.name}</Faint>
                    </DetailLink>
                  ))}
                </Cell>
              </DetailRow>
            ) : null}

            {held.dri.length === 0 &&
            held.support.length === 0 &&
            held.phases.length === 0 ? (
              <DetailRow>
                <DetailLabel>Projects</DetailLabel>
                <DetailText>Holding nothing on the roadmap right now.</DetailText>
              </DetailRow>
            ) : null}

            {/* Last, and quiet. Off the line because it is the widest thing on it and
                identifies nobody the name does not; here because it is what you copy
                when you actually do need to write to somebody. */}
            <DetailRow>
              <DetailLabel>Email</DetailLabel>
              <DetailText>{person.email}</DetailText>
            </DetailRow>
          </Detail>
        ) : null}

        {open && canEdit ? (
          <EditorPanel>
            <PersonEditor
              person={person}
              skills={skills}
              roles={roles}
              assignments={{
                dri: projectList(person.dri_project_ids),
                support: projectList(person.support_project_ids),
                phaseCount: person.owned_phase_count,
              }}
              admin={isAdmin}
              onSaved={onSaved}
              /* Delete is admin-only, and it is admin-only even on your own
                 record: it blanks assignments across lanes nobody is looking
                 at. Withholding the callback is what removes the button. */
              onDeleted={isAdmin ? onDeleted : undefined}
              onCancel={() => setEditing(null)}
            />
          </EditorPanel>
        ) : null}
      </Row>
    );
  };

  return (
    <>
      {/* A pair rather than one toggle, so the page says what it is showing rather
          than what it would show if pressed. Both carry aria-pressed, which is what
          makes this readable as a choice between two rather than an on/off switch. */}
      <ViewSwitch role="group" aria-label="What to show">
        <ToggleButton
          type="button"
          $on={view === 'roster'}
          aria-pressed={view === 'roster'}
          onClick={() => setView('roster')}
        >
          Roster
        </ToggleButton>
        <ToggleButton
          type="button"
          $on={view === 'schedule'}
          aria-pressed={view === 'schedule'}
          onClick={() => setView('schedule')}
        >
          Schedule
        </ToggleButton>
      </ViewSwitch>

      {/*
        The toolbar belongs to the roster, so it is absent from the schedule.

        Adding somebody is an edit to the list of people, and the schedule is a reading
        of the work - offering the control there meant pressing it opened a form under a
        chart that has nothing to do with it. The hint about who may edit whom goes with
        it for the same reason.
      */}
      {view === 'roster' ? (
      <Toolbar>
        {canAdd ? (
          <PrimaryButton
            type="button"
            onClick={() => {
              setAdding((v) => !v);
              setEditing(null);
            }}
            disabled={skills.length === 0 || roles.length === 0}
          >
            {adding ? 'Close' : isAdmin ? 'Add somebody' : 'Add myself'}
          </PrimaryButton>
        ) : null}
        <Spacer />
        {/* Said out loud rather than left to be discovered by finding no Edit button
            on anybody else's row. An absent control explains nothing on its own.

            Admins are told nothing, because there is nothing they cannot do here and a
            hint that says so is noise on every visit.

            Nothing at all until /api/me answers either. A missing control appearing a
            beat late is unremarkable; a sentence telling an admin to go ask an admin,
            which is what the unknown state would default to, is a false statement about
            their own permissions that they then watch retract itself. Absence is the
            honest rendering of "not known yet". */}
        {identity && !isAdmin ? (
          <Hint>You can edit your own entry. Ask an admin to change anybody else.</Hint>
        ) : null}
      </Toolbar>
      ) : null}

      {error ? <ErrorText role="alert">{error}</ErrorText> : null}

      {notice ? (
        <Notice role="status">
          <span>{notice}</span>
          <Spacer />
          <SecondaryButton type="button" onClick={() => setNotice(null)}>
            Dismiss
          </SecondaryButton>
        </Notice>
      ) : null}

      {/*
        Directly beneath the button that opens it.

        This used to render after the schedule, so pressing the toolbar button opened a
        form most of a screen below it, under a full-width chart - the control and the
        thing it revealed were nowhere near each other, and on a tall chart the form
        appeared off-screen entirely.
      */}
      {view === 'roster' && adding && canAdd ? (
        <NewPanel>
          <PanelTitle>{isAdmin ? 'Add somebody to the roster' : 'Add yourself to the roster'}</PanelTitle>

          {/* Only an admin has both paths. Somebody adding themselves is already
              signed in, so there is nothing to invite them to and the choice would be
              a question with one answer. */}
          {isAdmin ? (
            <>
              <ModeSwitch role="group" aria-label="How to add them">
                <ToggleButton
                  type="button"
                  $on={addMode === 'invite'}
                  aria-pressed={addMode === 'invite'}
                  onClick={() => setAddMode('invite')}
                >
                  Invite them
                </ToggleButton>
                <ToggleButton
                  type="button"
                  $on={addMode === 'manual'}
                  aria-pressed={addMode === 'manual'}
                  onClick={() => setAddMode('manual')}
                >
                  Fill it in myself
                </ToggleButton>
              </ModeSwitch>
              <Hint>
                {addMode === 'invite'
                  ? 'They get a sign-in and fill in their own skills and roles the first time they use it. This is the usual way.'
                  : 'Creates the roster entry now, with no sign-in. For somebody who needs to be schedulable before they have an account — or who will never need one.'}
              </Hint>
            </>
          ) : null}

          {isAdmin && addMode === 'invite' ? (
            <InvitePanel />
          ) : (
            <PersonEditor
              person={null}
              skills={skills}
              roles={roles}
              admin={isAdmin}
              lockedEmail={isAdmin ? null : me}
              onSaved={onSaved}
              onCancel={() => setAdding(false)}
            />
          )}
        </NewPanel>
      ) : null}

      {view === 'schedule' ? (
        <ChartPanel>
          {/* No heading. The Schedule button directly above is lit, which already says
              what this panel is, and a title under it was the same answer twice. */}
          {/* An empty chart is an ANSWER - "nobody here holds anything dated" - so it
              must not be shown before the answer is known. In flight the grid is one
              week wide and every row is missing, which renders as that same confident
              statement and is simply false. Hence a status line rather than an early
              chart, matching the roster below. */}
          {loading && projects.length === 0 ? (
            <Status>Building the schedule…</Status>
          ) : (
            <>
              <TeamChart rows={chartRows} projectNames={projectNames} grid={grid} today={today} />
              <TeamChartKey />
              <ChartNotes>
                <Hint>
                  A solid bar is a phase somebody owns; a band is a project they are
                  accountable for, spanning that project&rsquo;s own dates.
                </Hint>
                {/* Stated rather than left to be inferred from an absence: a person
                    missing because of a filter and a person who is simply not on the
                    roster look identical once they are gone. The reason given is the
                    rule itself, because "they hold nothing" stopped being true - empty
                    rows are drawn now, and the only people left out are the two roles
                    that are never the answer to "who could take this". */}
                {chartOmitted > 0 ? (
                  <Hint>
                    {chartOmitted} {chartOmitted === 1 ? 'person is' : 'people are'} not
                    shown here: leadership, or watching from outside engineering, and
                    holding nothing. They are on the roster.
                  </Hint>
                ) : null}
              </ChartNotes>
            </>
          )}
        </ChartPanel>
      ) : null}

      {view === 'roster' ? (
        <>
        <Panel>
          {loading && !people ? (
            <Status>Loading the team…</Status>
          ) : visible.length === 0 ? (
            <Status>Nobody on the roster yet.</Status>
          ) : rosterPeople.length === 0 ? (
            /* Everybody matched the observer rule. Said out loud, because an empty panel
               above a full one reads as a bug rather than as an answer. */
            <Status>Nobody on the roster holds anything yet — everyone is listed below.</Status>
          ) : (
            <Roster>
              {rosterPeople.map(renderPerson)}
            </Roster>
          )}
        </Panel>

        {/* Observers: on the roster, but never the answer to "who could pick this up".
            Rendered with the SAME renderPerson as the list above, so these rows stay
            editable and expandable - this is a change of place, not of standing. The
            section is absent rather than empty when nobody qualifies, which is the
            everyday case and should cost nothing on the page. */}
        {observers.length > 0 ? (
          <Panel>
            <PanelTitle>Observers</PanelTitle>
            <Hint>
              Outside engineering, and not holding anything right now. They are on the
              roster and can be edited here; they are separated out so the list above
              stays a list of people you could staff work to. Anyone from outside
              engineering who does take on a lane moves back up on their own.
            </Hint>
            <ObserverRoster>{observers.map(renderPerson)}</ObserverRoster>
          </Panel>
        ) : null}
        </>
      ) : null}
    </>
  );
}
