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
import styled from 'styled-components';

import { useIdentity } from '../components/AppShell';
import TeamChart, { TeamChartKey, type TeamChartRow } from '../components/chart/TeamChart';
import PersonEditor from '../components/PersonEditor';
import { describeError, getRoadmap, getRoles, getSkills, getWorkload } from '../services/api';
import { palette, radius } from '../styles/theme';
import { assignmentsByPerson, noAssignments } from '../utils/assignments';
import { buildGrid, todayISO } from '../utils/dates';
import {
  Chip,
  ErrorText,
  Hint,
  Panel,
  PrimaryButton,
  SecondaryButton,
  ToggleButton,
} from '../styles/ui';
import type {
  Person,
  PersonWorkload,
  Project,
  RoleInfo,
  SkillInfo,
  SkillLevel,
  Unassigned,
} from '../types';

const Summary = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
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

const Roster = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

const Row = styled.li<{ $inactive: boolean }>`
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${(p) => (p.$inactive ? '#FBF6F9' : palette.card)};
  /* Deactivated people stay legible rather than being faded to grey. They are still
     the recorded owner of real work, and the roadmap will keep showing their name. */
  opacity: ${(p) => (p.$inactive ? 0.75 : 1)};
  overflow: hidden;
`;

/*
  A grid rather than a <table>. The cells wrap to one column on a narrow screen, and
  a table cannot reflow - it would either scroll sideways or squeeze the skill chips
  into a column two words wide.
*/
const Head = styled.div`
  display: grid;
  grid-template-columns: minmax(180px, 1.1fr) minmax(220px, 1.6fr) minmax(150px, 0.9fr) auto;
  gap: 10px 16px;
  align-items: center;
  padding: 12px 14px;

  @media (max-width: 900px) {
    grid-template-columns: minmax(0, 1fr);
  }
`;

const Who = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
`;

const Name = styled.span`
  font-size: 14px;
  font-weight: 700;
  color: ${palette.ink};
`;

const Email = styled.span`
  font-size: 12px;
  color: ${palette.inkSoft};
  overflow-wrap: anywhere;
`;

/*
  Roles sit under the name, inside the person's own cell, rather than in a fifth
  column beside the skill chips.

  Placement is the argument, not the layout. A role is part of WHO SOMEBODY IS, and
  putting it next to the skill chips would file it as another kind of capability -
  the exact conflation the two vocabularies exist to avoid. Under the email it reads
  as an attribute of the person, which is what it is.

  Plain text, not chips, for the same reason: chips would compete with the skill chips
  a few columns over and imply the two lists are the same kind of thing.
*/
const RoleLine = styled.span`
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: ${palette.deepMagenta};
  overflow-wrap: anywhere;
`;

/* Not an error - everybody seeded from the workbook is in this state. It is a prompt. */
const NoRoles = styled.span`
  font-size: 11px;
  font-style: italic;
  color: ${palette.inkSoft};
`;

const Cell = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
`;

/**
 * A skill, marked by how the person holds it.
 *
 * Level is carried by fill AND by a glyph AND by the words in the tooltip, so nothing
 * about "who to ask" depends on distinguishing pink from warm grey.
 *
 * Filled dot / hollow dot is a strength ramp. "Wants to learn" gets a diamond and a
 * dashed edge instead, because it is not a third rung of that ramp - it says the
 * person cannot do this today. It still appears in the list, and that is deliberate:
 * these chips are how you find who could take something, and a learner who is never
 * surfaced is never offered the work. The glyph is what stops that being misread as
 * capability at a glance.
 */
const SkillChip = styled.span<{ $level: SkillLevel }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  border-radius: ${radius.pill};
  padding: 2px 9px;
  white-space: nowrap;
  color: ${(p) => {
    if (p.$level === 'primary') {
      return '#ffffff';
    }
    return p.$level === 'learning' ? palette.deepMagenta : palette.ink;
  }};
  background: ${(p) => {
    if (p.$level === 'primary') {
      return palette.hotPink;
    }
    return p.$level === 'learning' ? palette.card : palette.blush;
  }};
  border: 1px ${(p) => (p.$level === 'learning' ? 'dashed' : 'solid')}
    ${(p) => (p.$level === 'primary' ? palette.hotPink : palette.borderStrong)};

  &::before {
    content: ${(p) => {
      if (p.$level === 'primary') {
        return "'●'";
      }
      return p.$level === 'learning' ? "'◇'" : "'○'";
    }};
    font-size: ${(p) => (p.$level === 'learning' ? '9px' : '8px')};
    line-height: 1;
  }
`;

/**
 * Display order within one person's chips, and the words for each level.
 *
 * Keyed off the level rather than a chain of ternaries so that adding a fourth level
 * is one entry in each map and a type error everywhere it was forgotten - which is
 * how this one arrived.
 */
const SKILL_ORDER: Record<SkillLevel, number> = { primary: 0, secondary: 1, learning: 2 };

const SKILL_TITLE: Record<SkillLevel, string> = {
  primary: 'The obvious person to ask',
  secondary: 'Can do this; it will take longer',
  learning: 'Cannot do this yet — wants to be given this work',
};

const Nothing = styled.span`
  font-size: 12px;
  color: ${palette.inkSoft};
`;

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
  const [adding, setAdding] = useState(false);
  const [showChart, setShowChart] = useState(true);
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
   * The chart's rows: the same people the roster is showing, minus the ones holding
   * nothing.
   *
   * Driven off `visible` on purpose, so the two halves of the page cannot disagree
   * about who is on the roster. The empty rows are dropped because a Gantt row with no
   * marks on it carries no information and costs 52px; the roster below already lists
   * them and the count of them is stated under the chart.
   */
  const chartRows = useMemo<TeamChartRow[]>(
    () =>
      visible
        .map((person) => ({
          email: person.email,
          name: person.name,
          active: person.active,
          assignments:
            assignments.get(person.email.toLowerCase()) ?? noAssignments(person.email),
        }))
        .filter(
          (row) =>
            row.assignments.owned.length > 0 ||
            row.assignments.roles.length > 0 ||
            row.assignments.undatedRoles.length > 0
        ),
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

  const noSkillsCount = sorted.filter((p) => p.active && p.specialisations.length === 0).length;
  const activeCount = sorted.filter((p) => p.active).length;

  /** Project ids rendered as names, with the unresolvable id shown rather than hidden. */
  const projectList = (ids: string[]) =>
    ids.map((id) => projectNames.get(id) ?? id).sort((a, b) => a.localeCompare(b));

  return (
    <>
      <Summary>
        <Chip>{activeCount} on the roster</Chip>
        {noSkillsCount ? <Chip>{noSkillsCount} with no skills recorded</Chip> : null}
      </Summary>

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
            {adding ? 'Close' : isAdmin ? 'Add person' : 'Add myself'}
          </PrimaryButton>
        ) : null}
        <ToggleButton
          type="button"
          $on={showChart}
          aria-pressed={showChart}
          onClick={() => setShowChart((v) => !v)}
        >
          Schedule
        </ToggleButton>
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

      {showChart ? (
        <ChartPanel>
          <PanelTitle>Who is doing what, when</PanelTitle>
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
                    missing because they hold nothing and a person missing because of a
                    filter look identical once they are gone. */}
                {chartOmitted > 0 ? (
                  <Hint>
                    {chartOmitted} {chartOmitted === 1 ? 'person is' : 'people are'} not
                    shown here: they hold nothing. They are listed below.
                  </Hint>
                ) : null}
              </ChartNotes>
            </>
          )}
        </ChartPanel>
      ) : null}

      {adding && canAdd ? (
        <NewPanel>
          <PanelTitle>{isAdmin ? 'Add somebody to the roster' : 'Add yourself to the roster'}</PanelTitle>
          <PersonEditor
            person={null}
            skills={skills}
            roles={roles}
            admin={isAdmin}
            lockedEmail={isAdmin ? null : me}
            onSaved={onSaved}
            onCancel={() => setAdding(false)}
          />
        </NewPanel>
      ) : null}

      <Panel>
        {loading && !people ? (
          <Status>Loading the team…</Status>
        ) : visible.length === 0 ? (
          <Status>Nobody on the roster yet.</Status>
        ) : (
          <Roster>
            {visible.map((person) => {
              const dri = projectList(person.dri_project_ids);
              const support = projectList(person.support_project_ids);
              const open = editing === person.email;
              const mine = isMe(person);
              const canEdit = isAdmin || mine;
              return (
                <Row key={person.email} $inactive={!person.active}>
                  <Head>
                    <Who>
                      <Name>
                        {person.name}
                        {person.active ? '' : ' (deactivated)'}
                      </Name>
                      <Email>{person.email}</Email>
                      {person.roles.length > 0 ? (
                        <RoleLine>
                          {/* Falls back to the raw value, so a role dropped from the
                              vocabulary still shows rather than blanking the line. */}
                          {person.roles.map((r) => roleLabels.get(r) ?? r).join(' · ')}
                        </RoleLine>
                      ) : (
                        <NoRoles>{mine ? 'No role set — add yours' : 'No role set'}</NoRoles>
                      )}
                    </Who>

                    <Cell>
                      {person.specialisations.length === 0 ? (
                        <Nothing>No specialisations recorded</Nothing>
                      ) : (
                        [...person.specialisations]
                          // Strongest first: the reason to scan this column is to find
                          // who to ask, not to read an alphabetical list. Learners go
                          // last - they are in the list on purpose, but they are the
                          // answer to a different question than the top of it.
                          .sort(
                            (a, b) =>
                              SKILL_ORDER[a.level] - SKILL_ORDER[b.level] ||
                              a.skill.localeCompare(b.skill)
                          )
                          .map((s) => (
                            <SkillChip key={s.skill} $level={s.level} title={SKILL_TITLE[s.level]}>
                              {labels.get(s.skill) ?? s.skill}
                            </SkillChip>
                          ))
                      )}
                    </Cell>

                    {/* Somebody holding nothing gets an empty cell. There was a
                        "Carrying nothing" marker here and it was removed; the absence
                        of chips now says the same thing more quietly. */}
                    <Cell>
                      {dri.length ? (
                        <Chip title={`DRI: ${dri.join(', ')}`}>DRI ×{dri.length}</Chip>
                      ) : null}
                      {support.length ? (
                        <Chip title={`Support: ${support.join(', ')}`}>
                          Support ×{support.length}
                        </Chip>
                      ) : null}
                      {person.owned_phase_count ? (
                        <Chip title="Includes ongoing Maintenance bands">
                          {person.owned_phase_count}{' '}
                          {person.owned_phase_count === 1 ? 'phase' : 'phases'}
                        </Chip>
                      ) : null}
                    </Cell>

                    <Cell>
                      {canEdit ? (
                        <SecondaryButton
                          type="button"
                          onClick={() => {
                            setEditing(open ? null : person.email);
                            setAdding(false);
                          }}
                          aria-expanded={open}
                        >
                          {open ? 'Close' : mine && !isAdmin ? 'Edit yours' : 'Edit'}
                        </SecondaryButton>
                      ) : null}
                    </Cell>
                  </Head>

                  {open && canEdit ? (
                    <EditorPanel>
                      <PersonEditor
                        person={person}
                        skills={skills}
                        roles={roles}
                        assignments={{
                          dri,
                          support,
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
            })}
          </Roster>
        )}
      </Panel>
    </>
  );
}
