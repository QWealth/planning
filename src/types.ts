/**
 * The API's data shapes, mirrored from fast/app/schemas/.
 *
 * A file of their own rather than living in services/api.ts, so that the pure
 * modules under utils/ - and their tests - can name a Phase without importing the
 * axios client, which imports the Amplify auth module, which configures a Cognito
 * pool at import time. A unit test of the state ranking should not need a user pool.
 *
 * NULL IS A VALUE HERE, NOT AN ABSENCE. `progress: null` means nobody has recorded
 * how far along this phase is; `progress: 0` means it has been looked at and has not
 * started. Three phases in the live data are the first and five are the second, and
 * rendering them identically would be a lie the workbook also told. Same for dates:
 * null is "unscheduled", which is a state the UI is expected to draw, not a gap it
 * should paper over. See the docstring on fast/app/schemas/projects.py.
 */

export interface Phase {
  project_id: string;
  phase_id: string;
  name: string;
  phase_order: number;
  owner_email: string | null;
  /** `YYYY-MM-DD`, or null for unscheduled. */
  start: string | null;
  /** `YYYY-MM-DD`, or null for unscheduled. Inclusive of the day named. */
  end: string | null;
  /** 0..1, or null for "not recorded". */
  progress: number | null;
  /**
   * Ongoing support rather than scheduled work - the Maintenance band on every
   * lane. The API refuses to store dates or progress against one, so a structural
   * phase is not a gap and is not counted in the completeness figure.
   */
  structural: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * A dated point on a lane - "Beta launch", "Regulatory deadline".
 *
 * NOT a zero-length phase, and the distinction is worth keeping: a phase is owned
 * work with a duration and a progress figure, a milestone is a moment something is
 * due. Modelling one as the other gives you either phases with no owner or
 * milestones stuck at 0% forever, and both draw as a lie.
 *
 * `done` is INDEPENDENT of `date`, and the gap between the two is the interesting
 * part. Past its date and not done is a missed deadline, which the chart says out
 * loud; deriving doneness from the date would quietly mark every slipped commitment
 * as achieved. See the Milestones section of CLAUDE.md.
 */
export interface Milestone {
  project_id: string;
  milestone_id: string;
  name: string;
  /**
   * `YYYY-MM-DD`, or null. Null is real and common - "there has to be a beta launch
   * and nobody has committed to when". An undated milestone is reported as a gap and
   * is deliberately not drawn, because the only way to draw it is to invent a date.
   */
  date: string | null;
  note: string | null;
  done: boolean;
  /**
   * The phase this belongs to, or null for one that belongs to the project itself.
   *
   * NULL IS THE ORDINARY CASE, not an unfinished form. "Infra hardening signed off"
   * sits under Infra; "Regulatory deadline" is a date the whole lane answers to and
   * is not a step inside any one stage of it. Forcing a choice would file one of
   * those two shapes under the other, and the phase it landed under would look like
   * it owned a commitment nobody gave it.
   *
   * The API guarantees this names a phase of THIS project or is null: it refuses a
   * dangling id on write, and detaches rather than orphans when a phase is deleted.
   * So a lookup that misses means the payload in hand is stale, not that the row is
   * wrong - which is why the chart falls back to drawing the milestone on the lane
   * rather than dropping it.
   */
  phase_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * A project WITHOUT its phases - the shape `PATCH /api/projects/{id}` returns.
 *
 * Split out from `Project` because that asymmetry is real and has bitten people:
 * the PATCH response is `ProjectOut`, the roadmap response is `ProjectDetail`, and
 * merging the former straight into local state would drop every phase in the lane.
 * The type makes that a compile error instead of an empty lane.
 */
export interface ProjectSummary {
  project_id: string;
  name: string;
  lane_order: number;
  dri_email: string | null;
  support_email: string | null;
  active: boolean;
  /**
   * What kind of work this lane is — "App", "Data", "QC". The roadmap groups by it.
   *
   * Free text, authored by the team rather than enumerated, which is the opposite of
   * how roles and skills work. Those vocabularies were knowable in advance; this one
   * is not, and inventing it from a reading of nine project names would be a guess at
   * an org chart the app does not model. The editor offers every value already in
   * use, which is what keeps "Data" from becoming "data" and "DATA".
   *
   * Null is a real state and means nobody has filed it — every project predates the
   * field. Optional as well as nullable, because a backend deployed before it existed
   * omits it entirely.
   */
  category?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface Project extends ProjectSummary {
  phases: Phase[];
  /**
   * Never undefined. The API defaults it to `[]`, and services/api.ts normalises it
   * again on the way in so that a backend deployed before milestones existed - which
   * is the state of production right now - gives an empty lane rather than a crash on
   * `project.milestones.length`.
   */
  milestones: Milestone[];
}

/**
 * How somebody holds a skill - and, separately, whether they want to.
 *
 * TWO FIELDS, NOT ONE, AND THEY DO NOT IMPLY EACH OTHER.
 *
 *   stars           0-3, what they can do TODAY.
 *   wants_to_learn  whether they want to be given this work.
 *
 * A three-star engineer may still want more of it, and a zero-star one who ticks the
 * box is precisely who a staffing search should surface when nobody else is free. An
 * entry with neither - no stars and no appetite - says nothing and is refused by the
 * API rather than stored; the form clears the entry instead of sending one.
 *
 * This replaced a single four-valued `level` (`primary`/`secondary`/`learning`).
 * `learning` was welded onto a capability scale while explicitly not being part of
 * one, so every consumer needed a comment telling it not to sort `learning` as a
 * weaker `secondary`. Nothing was migrated: rows still holding a `level` are mapped
 * on read by the API. See fast/app/skills.py for the whole argument.
 */
export interface Specialisation {
  /** A value from the vocabulary, e.g. `qa-testing`. Not a display label. */
  skill: string;
  /** 0-3. Zero is only ever stored alongside `wants_to_learn`. */
  stars: number;
  wants_to_learn: boolean;
}

/**
 * One entry of the vocabulary, from `GET /api/skills`.
 *
 * Fetched rather than hardcoded here on purpose. The list is closed and lives in
 * fast/app/skills.py; duplicating it in TypeScript would let the two drift, and the
 * failure mode is silent - a renamed skill stops matching the values already stored
 * against people, and those people simply appear to have lost it.
 */
export interface SkillInfo {
  skill: string;
  label: string;
  description: string;
}

/**
 * What somebody IS on the team, as opposed to what they can do.
 *
 * Named `PersonRole` and not `Role` on purpose: `Role` is already taken by
 * `'dri' | 'support'` in utils/assignments.ts, which is a property of an assignment
 * rather than of a person - you are DRI *of a lane*, you are a BA full stop. Two
 * different things sharing one English word, and importing the wrong one would
 * typecheck for exactly as long as both remain string unions.
 *
 * Not the Cognito `admin` group either. People set their own roles, so anything that
 * read `leadership` as permission would make admin self-service. fast/app/roles.py
 * spells out all three.
 *
 * These are the stored identifiers, never the labels - display always comes from the
 * API, so a relabelling needs no change here.
 */
export type PersonRole =
  | 'ba'
  | 'ux'
  | 'software-engineer'
  | 'qa'
  | 'data'
  | 'leadership'
  /** The catch-all: works with the team from another part of the business. Last in
      the picker by design - see app/roles.py. */
  | 'outside-engineering';

/**
 * One entry of the role vocabulary, from `GET /api/roles`.
 *
 * Fetched rather than hardcoded, for the same reason as SkillInfo above.
 */
export interface RoleInfo {
  role: string;
  label: string;
  description: string;
}

export interface Person {
  email: string;
  name: string;
  /**
   * Required to add yourself, but `[]` is a real state that has to render: everybody
   * seeded from the workbook has no roles, because the workbook recorded names and
   * not disciplines and guessing them would be an invention.
   *
   * `string[]`, not `PersonRole[]`, matching what the API actually returns - a role
   * retired from the vocabulary must still show on the people who hold it rather
   * than silently vanishing from their row.
   */
  roles: string[];
  active: boolean;
  specialisations: Specialisation[];
  /**
   * The Monday digest, and whether this person asked for it.
   *
   * Not optional even though every roster row predates the fields: the API defaults
   * them on the way out (fast/app/db/models.py), so `| undefined` here would only
   * spread a check for a state the server does not return.
   *
   * `digest_admin_report` is the odd one out. It subscribes an address to the
   * milestones NOBODY owns, across every project, so only an admin may set it - which
   * is why it is read here rather than assumed: the settings page shows that switch to
   * the people who have it instead of to everybody who would be refused.
   */
  digest_enabled: boolean;
  digest_days: number;
  digest_admin_report: boolean;
  /**
   * When this person last opened each RFC: `{ item_id: ISO timestamp }`.
   *
   * Server-side and per person, rather than localStorage. "Never opened" is a fact
   * about someone, not about a browser - keeping it locally would mark everything
   * unread again on a new laptop, or after clearing site data, which is precisely
   * when somebody is least able to tell that the highlight is lying to them.
   *
   * Not writable through patchPerson: it is a map, so an allowlisted PATCH would
   * take a whole new one and a stray `{}` would silently mark everything unread.
   * markRfcRead is the only way in, and it only ever adds a key.
   */
  rfcs_read: Record<string, string>;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * The offered lookahead windows, from `fast/app/digest.py:DIGEST_WINDOWS`.
 *
 * One of the few vocabularies in this app that is NOT fetched. It is three integers
 * that the server validates anyway, and a request to learn them would be a round trip
 * before a settings page could draw its own radio buttons. If they diverge the server
 * refuses with 422 and names the real set, which is the failure this is allowed to
 * have - unlike the skills and roles lists, where a stale copy renders silently wrong
 * data against real people.
 */
export const DIGEST_WINDOWS = [7, 14, 30] as const;

/**
 * `GET /api/digest/preview` - the caller's own Monday message, composed but not sent.
 *
 * The caller's ONLY. A dry run of the whole job would put one colleague's reminders in
 * another's browser, so the endpoint composes per-caller; see fast/app/routes/digest.py.
 */
export interface DigestPreview {
  /** The Monday this would be sent for, as an ISO date. */
  week: string;
  enabled: boolean;
  days: number;
  /**
   * Empty when there is nothing to say, and that is a real answer rather than a
   * missing one: a digest with nothing in it is not sent at all. The page renders it
   * as "you would get nothing this week", never as an error.
   */
  digest: string;
  /** Empty unless this person is subscribed to the unowned-milestone report. */
  unowned_report: string;
  /**
   * Whether this deployment delivers at all - the CDK master switch, separate from
   * the personal one. Without it the page would confirm a subscription that the
   * environment is quietly discarding.
   */
  sending_enabled: boolean;
}

/**
 * A person plus what they own, from `GET /api/people/workload`.
 *
 * The Team page reads this rather than /api/people because the question the page
 * exists to answer is "who is overloaded and who is free", and that is only visible
 * when ownership is aggregated per person instead of per project.
 */
export interface PersonWorkload extends Person {
  dri_project_ids: string[];
  support_project_ids: string[];
  /** Includes structural (Maintenance) bands - carrying ongoing support is real load. */
  owned_phase_count: number;
}

export interface UnassignedProject {
  project_id: string;
  project_name: string;
}

export interface UnassignedPhase extends UnassignedProject {
  phase_id: string;
  phase_name: string;
}

/**
 * What deleting a person cleared, split by the role it was cleared from.
 *
 * Three lists rather than a count, because the three mean different things to
 * whoever now has to repair the schedule: a lane with no DRI is unowned, a lane with
 * no Support has a bus factor of one, and an unowned phase is work nobody is doing.
 */
export interface Unassigned {
  dri: UnassignedProject[];
  support: UnassignedProject[];
  phases: UnassignedPhase[];
}

/**
 * The receipt from `DELETE /api/people/{email}`.
 *
 * Carries the name as well as the email because it is shown to a person, and by the
 * time it arrives there is no row left to look the name up in.
 */
export interface PersonDeleted {
  email: string;
  name: string;
  unassigned: Unassigned;
}

export interface Roadmap {
  projects: Project[];
  people: Person[];
  /** Earliest date anywhere in the roadmap, or null when nothing is scheduled. */
  span_start: string | null;
  span_end: string | null;
}

/** GET /api/me. Not behind the group check, so it answers even for a refused user. */
export interface Identity {
  email: string | null;
  groups: string[];
  authorised: boolean;
  required_group: string;
  enforced: boolean;
  /**
   * Whether this caller may act on people other than themselves.
   *
   * Used to hide controls, never to permit anything: every one of them is enforced
   * again on the server. A hidden button is a courtesy to the person who would only
   * be refused, not a security boundary - see fast/app/routes/people.py.
   */
  is_admin: boolean;
  admin_group: string;
  /**
   * Whether this caller has a row on the roster yet.
   *
   * False only for somebody who has a working login and has never filled the form in
   * — the state an invited colleague is in on their very first sign-in. The app
   * blocks on it, because a person with no row cannot be assigned anything and would
   * otherwise spend their first session looking at a roadmap they are absent from.
   *
   * FAILS OPEN. The backend answers `true` when it cannot tell (see `_has_roster_row`
   * in fast/app/routes/identity.py), and an old backend that has never heard of the
   * field leaves it undefined, which the shell must read as "onboarded". This is a
   * routing hint, never a permission — being onboarded grants nothing, and every real
   * check still happens server-side.
   */
  onboarded?: boolean;
  /**
   * Whether to draw the Log tab.
   *
   * FAILS CLOSED, which is the opposite of `onboarded` above and the reason both are
   * documented rather than one. That flag is a routing hint and errs towards letting
   * people in; this one mirrors a gate, so an old backend that has never heard of it
   * leaves it undefined and the tab stays hidden. The endpoint refuses independently —
   * this only stops a tab appearing over a route that would 403.
   */
  is_ba?: boolean;
}

/**
 * One answer to one day-of milestone question.
 *
 * Every field is a snapshot of how things stood when the question was asked, not a
 * view of current state — a milestone renamed or rescheduled afterwards does not
 * rewrite the record of what somebody was asked. See MilestoneCheckModel in
 * fast/app/db/models.py.
 */
export interface MilestoneCheck {
  item_id: string;
  project_id: string | null;
  project_name: string;
  milestone_id: string | null;
  milestone_name: string;
  due: string | null;
  asked_email: string | null;
  /** 'done' or 'not_done'. */
  answer: string;
  /**
   * Why it did not land, when they said. Null against `not_done` means they were
   * asked and did not answer — a modal dismissed rather than submitted, which is a
   * real state and not a missing field.
   */
  reason: string | null;
  created_at: string | null;
}

/**
 * The receipt from `POST /api/people/invite`.
 *
 * Both flags can be false on a completely successful call, and that is the normal
 * case rather than an edge one: the Cognito pool is shared with the marketing
 * compliance tool, so most colleagues already have a login and are already in the
 * group. Inviting them is a no-op that should read as success, not as a 409.
 */
export interface InviteResult {
  email: string;
  /** False when the address already had an account in the shared pool. */
  account_created: boolean;
  /** False when they were already in the planning group. */
  group_added: boolean;
  /** Whether they already have a roster row, i.e. have been through onboarding. */
  onboarded: boolean;
  /**
   * The text to send them, composed by the API.
   *
   * Deliberately not built here. The Slack bot sends this same invitation, and two
   * copies of a paragraph whose job is to stop a colleague dismissing a legitimate
   * credentials email as phishing is two copies that can drift - with the broken one
   * still reading perfectly well. See fast/app/invites.py.
   */
  message: string;
  /**
   * Whether the API delivered `message` as a Slack DM.
   *
   * Only ever true when the address came from the Slack picker, because that is the
   * only path where we know which human it belongs to. False for a typed address, and
   * false for somebody already on the roster - who is sent nothing on purpose.
   */
  dm_sent: boolean;
  /**
   * Why the DM did not arrive, when one was attempted and failed.
   *
   * Set INDEPENDENTLY of the invite succeeding: the Cognito account exists by the time
   * the DM is tried, so a failure here is a delivery problem, not a failed invite. The
   * panel shows the copy block in this case, which is the pre-Slack path.
   */
  dm_error: string | null;
}

/**
 * Somebody in the Slack workspace who could be invited.
 *
 * NOT a Person. Nobody here is on the team list - this is the list of people who
 * could be, and the roster is still written by each of them at onboarding. The one
 * field that crosses over is `on_roster`. See fast/app/routes/slack.py.
 */
export interface SlackPerson {
  /** How we reach them. A delivery route, not an identity. */
  slack_user_id: string;
  name: string;
  /** The identity: the roster key and the Cognito username. */
  email: string;
  avatar: string;
  title: string;
  /** Usually a contractor. Shown and flagged rather than hidden. */
  is_guest: boolean;
  /** Already has a roster row, so inviting them again would do nothing. */
  on_roster: boolean;
}

/**
 * The directory, plus enough to explain an empty one.
 *
 * An empty `people` has two causes that look identical: a workspace with nobody in
 * it, and a Slack app missing `users:read.email`, which strips the address off every
 * profile and filters everybody out. `filtered` tells them apart.
 */
export interface SlackDirectory {
  people: SlackPerson[];
  /** How many members Slack returned that were dropped for having no address. */
  filtered: number;
  /** Set when Slack could not be reached. The picker falls back to a typed address. */
  unavailable: string | null;
}

/**
 * An RFC: a written proposal, in markdown, that may or may not belong to a project.
 *
 * `project_id` IS THE FEATURE. "How we do code review" is a decision about no project
 * in particular, and there is no honest lane to file it under. It could not live in
 * the projects table at all - project_id is that table's partition key, so
 * "attached to nothing" would have needed a fake partition to sit in - which is why
 * there is a separate work table underneath this. See fast/app/db/queries/work.py.
 *
 * `status` is a plain string rather than a union of the five values, deliberately.
 * The vocabulary is served by /api/rfcs/statuses so that adding a sixth status is one
 * backend deploy; a union here would make the frontend a second place that has to
 * know the list, and the compiler would then reject a status the API had already
 * started sending. Labels come from the catalogue, not from a map in this repo.
 */
export interface Rfc {
  item_id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  project_id: string | null;
  owner_email: string | null;
  /**
   * Skill values from the vocabulary - who this proposal wants in the room.
   *
   * By capability rather than by name, because names go stale as people move around
   * and "this is a back-end decision" does not. The roster already records who holds
   * what, so the audience is derived rather than maintained.
   */
  skills: string[];
  /**
   * When it became open for comment, or null.
   *
   * READ-ONLY. Set by the API when the status moves into `review` and cleared when it
   * moves out, never accepted from a client - it is what the daily chase counts its
   * five working days from, so "how long has this been waiting" must not be a thing
   * anybody can answer differently.
   */
  review_since: string | null;
  /** The day it was accepted or rejected. Null while it is still open. */
  decided_on: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * One remark on an RFC.
 *
 * There is no `edited` flag, deliberately: `updated_at !== created_at` already says
 * it, and a second field meaning the same thing is one a future write path forgets to
 * set. The renderer derives the "edited" marker rather than trusting a boolean.
 *
 * `author_email` is written from the caller's token by the API and is not editable at
 * any permission level, so it can be treated as a fact about who said this rather than
 * a mutable attribute that happens to hold an address.
 */
/**
 * Which notification features this DEPLOYMENT has switched on.
 *
 * Deployment-level, not per-person: the digest's own opt-in lives on your roster row,
 * while these say whether the deployment would deliver anything even if you asked. The
 * settings page needs both, because explaining "you will get a DM on Monday" while the
 * master switch is off would have somebody waiting for a message that never comes and
 * concluding the app is broken.
 */
export interface Features {
  digest_enabled: boolean;
  progress_enabled: boolean;
  rfc_chase_enabled: boolean;
  /** Whether a Slack channel is configured for the RFC chase at all. */
  rfc_channel_configured: boolean;
}

export interface RfcComment {
  comment_id: string;
  item_id: string;
  author_email: string | null;
  body: string;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * A ticket or a subtask. ONE type, because they are one entity.
 *
 * `parent_id` is the only thing telling them apart: null means top-level (what
 * everyone calls a ticket), set means it is a subtask of that ticket. Nesting is
 * capped at one level by the backend and checked in BOTH directions - you cannot
 * parent onto a subtask, and you cannot give a parent to something that already has
 * children - so a cycle is impossible by construction.
 *
 * That cap is why this type never has to describe a tree, and why the board can
 * group rows by whatever it likes without recursing.
 *
 * `body` is free text and is deliberately NOT markdown-rendered. A task is a line
 * with a note attached; the thing you write paragraphs in is an RFC, and blurring
 * that gives you two half-documents instead of one of each.
 */
export interface Task {
  item_id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  project_id: string | null;
  /**
   * Which phase of that project this task belongs to, or null for the project as a
   * whole. The expanded lane lists tasks under the phase bar they name.
   *
   * Null is the common case and always will be — every task that came across the
   * migration has no phase, and nobody is going to file 287 of them by hand. The lane
   * lists unfiled tasks under the project instead of hiding them.
   *
   * Optional as well as nullable, because a backend deployed before the field existed
   * omits it entirely.
   */
  phase_id?: string | null;
  /** Null for a ticket. The owning ticket's id for a subtask. */
  parent_id: string | null;
  owner_email: string | null;
  /** `YYYY-MM-DD`, or null. Absent is normal - most work has no committed date. */
  due: string | null;
  task_order: number;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * One entry of a served vocabulary: the stored value, and how to say it on screen.
 *
 * `closed` means the item is no longer on anyone's plate - accepted, rejected and
 * withdrawn for an RFC. It comes from the API rather than from a list in this repo
 * precisely so there is no list in this repo: hardcoding the three values would make
 * the frontend a second place that has to be updated when the vocabulary changes,
 * and the symptom of forgetting is a retired proposal that keeps rendering as live.
 */
export interface StatusInfo {
  status: string;
  label: string;
  description: string;
  closed: boolean;
}

/**
 * PATCH bodies.
 *
 * Every field is optional, and `undefined` and `null` mean DIFFERENT THINGS: absent
 * means "leave it alone", `null` means "clear it". The backend reads exactly this
 * distinction via Pydantic's `model_fields_set`, so a body that helpfully includes
 * every field with its current value would work, and a body built by spreading a
 * form's default values would silently blank the fields the user never touched.
 * services/api.ts only ever sends dirty fields.
 */
export interface PhasePatch {
  name?: string;
  phase_order?: number;
  owner_email?: string | null;
  start?: string | null;
  end?: string | null;
  progress?: number | null;
  structural?: boolean;
}

export interface ProjectPatch {
  name?: string;
  lane_order?: number;
  dri_email?: string | null;
  support_email?: string | null;
  active?: boolean;
  /** Empty string clears it — the API turns that into a real null. */
  category?: string | null;
}

/**
 * `roles` and `specialisations` REPLACE rather than merge. Both are sets, and a
 * merging update could only ever add - "remove a skill", "clear them all" and "I no
 * longer do UX" would all be unexpressible. Sending either means sending the whole
 * list.
 *
 * They differ on one point: specialisations may be sent empty (having no skills
 * recorded is a true statement about availability), roles may not (an empty role list
 * only ever means the row was never filled in). `roles: []` is a 422.
 */
export interface PersonPatch {
  name?: string;
  roles?: PersonRole[];
  active?: boolean;
  specialisations?: Specialisation[];
  digest_enabled?: boolean;
  /** One of DIGEST_WINDOWS. Anything else is a 422 naming the real set. */
  digest_days?: number;
  /** Admin-only on the server. Sending it as a member is a 403, not a silent no-op. */
  digest_admin_report?: boolean;
}

/**
 * Editing a milestone. Absent means "leave alone"; null means "clear it".
 *
 * `phase_id: null` DETACHES the milestone from its phase and is a real edit - a
 * commitment that turns out to belong to the lane as a whole rather than to the
 * stage somebody first filed it under. Omitting `phase_id` leaves the attachment
 * alone, which is what renaming a milestone must do. Same trap as RfcPatch's
 * `project_id`, one level down.
 */
export interface MilestonePatch {
  name?: string;
  date?: string | null;
  note?: string | null;
  done?: boolean;
  phase_id?: string | null;
}

/**
 * Editing an RFC. The absent/null rule matters more here than anywhere else.
 *
 * `project_id: null` DETACHES the RFC from its project and is a real edit somebody
 * will make - a proposal that started life inside one project turning out to be a
 * general decision. Omitting project_id leaves the attachment alone. Get the two
 * confused and fixing a typo in a title silently unfiles the document.
 *
 * `decided_on: null` means "we have un-decided this", which goes with moving the
 * status back from accepted to review. It is not the same as never having set it,
 * but it stores the same way, and that is fine: the audit row carries the history.
 */
export interface RfcPatch {
  title?: string;
  body?: string;
  status?: string;
  project_id?: string | null;
  owner_email?: string | null;
  decided_on?: string | null;
  /**
   * Always sent whole when it changes, never as a delta.
   *
   * Unlike project_id and decided_on above, there is no absent-versus-null distinction
   * to preserve here: skills are a set, and `[]` is the real, storable answer for
   * "tagged with nothing" rather than a way of saying "leave it alone".
   */
  skills?: string[];
}

/**
 * Editing a task. Two fields here carry the absent/null distinction into places
 * where getting it wrong is destructive rather than merely wrong.
 *
 * `parent_id: null` PROMOTES a subtask to a top-level ticket. Omitting parent_id
 * leaves it where it is. This is the same keystroke apart as RfcPatch's detach, and
 * worse if confused: a board that promotes a subtask every time somebody fixes its
 * title would quietly flatten the structure of the whole backlog over a week, with
 * each individual edit looking correct.
 *
 * `owner_email: null` un-assigns. That is a real and common edit - work handed back
 * to the pile is not the same as work nobody has looked at yet, but they store the
 * same, and the audit row is what tells them apart afterwards.
 */
export interface TaskPatch {
  title?: string;
  body?: string;
  status?: string;
  project_id?: string | null;
  /** Must name a phase of `project_id`; the API refuses anything else. */
  phase_id?: string | null;
  parent_id?: string | null;
  owner_email?: string | null;
  due?: string | null;
  task_order?: number;
}

export interface PersonCreate {
  email: string;
  name: string;
  /**
   * Not optional, unlike everything else on this create body. There is no server
   * default to fall back to and none should be invented - a defaulted role would put
   * "Software engineer" against a designer and look authoritative. At least one.
   */
  roles: PersonRole[];
  active?: boolean;
  specialisations?: Specialisation[];
}

/**
 * POST bodies.
 *
 * These are a different shape of optional from the PATCH bodies above, and the
 * difference is worth naming. On a patch, absent means "leave alone" - there is a
 * stored value to leave alone. On a create there is nothing yet, so absent means
 * "take the server's default", which is null for every date and owner and `false`
 * for the two flags. No field here can be sent as `null` to mean something other
 * than what omitting it would mean, so the forms may send whatever they like.
 *
 * `phase_order` and `lane_order` are the exception that has to be sent. Both default
 * to 0 server-side (see create_phase in fast/app/db/queries/projects.py), so every
 * row created without one sorts to the top of its list, above work that was already
 * there. The forms pass the next order along instead.
 */
export interface PhaseCreate {
  name: string;
  phase_order?: number;
  owner_email?: string | null;
  start?: string | null;
  end?: string | null;
  progress?: number | null;
  structural?: boolean;
}

export interface MilestoneCreate {
  name: string;
  date?: string | null;
  note?: string | null;
  done?: boolean;
  /**
   * Optional, and absent is the common answer. Must name a phase of the project it
   * is being posted to - the API answers 400 rather than storing a reference that
   * resolves to nothing.
   */
  phase_id?: string | null;
}

/**
 * A new RFC.
 *
 * `created_by` is absent on purpose and cannot be sent: the API takes it from the
 * token, because it is the one field answering "who wrote this" and a client-supplied
 * value could say anything. The schema does not declare it, so a body that includes
 * it has that key dropped rather than honoured.
 */
export interface RfcCreate {
  title: string;
  body?: string;
  status?: string;
  project_id?: string | null;
  owner_email?: string | null;
  decided_on?: string | null;
  /** Skill values from the vocabulary. Omitted means none. */
  skills?: string[];
}

/**
 * A new ticket, or a new subtask of one.
 *
 * `parent_id` present makes it a subtask, and the backend refuses the request if
 * that parent is itself a subtask - the one-level cap is enforced there rather than
 * trusted here, so a board that gets its own bookkeeping wrong gets a 400 instead of
 * a malformed tree.
 *
 * Everything else omitted takes the server's default, and each default is the honest
 * one: backlog, no project, no owner, no date.
 */
export interface TaskCreate {
  title: string;
  body?: string;
  status?: string;
  project_id?: string | null;
  /** Must name a phase of `project_id`; the API refuses anything else. */
  phase_id?: string | null;
  parent_id?: string | null;
  owner_email?: string | null;
  due?: string | null;
  task_order?: number;
}

/**
 * A new lane, optionally with its phases and milestones in the same call.
 *
 * The children are accepted inline because the backend does the whole thing in one
 * DynamoDB batch write - a project created with three phases either all lands or none
 * of it does. Creating them with follow-up POSTs would leave a bare lane behind
 * whenever the second call failed, and nothing on the roadmap distinguishes that from
 * a lane somebody meant to leave empty.
 */
export interface ProjectCreate {
  name: string;
  lane_order?: number;
  dri_email?: string | null;
  support_email?: string | null;
  active?: boolean;
  category?: string | null;
  phases?: PhaseCreate[];
  milestones?: MilestoneCreate[];
}

/**
 * A file attached to a task.
 *
 * No storage key and no URL. The key is an internal address; the URL is a capability
 * that works for anybody holding it until it expires, so it is minted per click by
 * `getAttachmentDownload` rather than shipped in a list and cached in every browser
 * that ever drew the page.
 */
export interface Attachment {
  attachment_id: string;
  filename: string;
  content_type: string;
  /** Bytes, as the uploader's browser reported them. Display only. */
  size: number;
  uploaded_by: string | null;
  created_at: string | null;
}

/** What the API hands back to upload one file with: where to POST, and what to send. */
export interface AttachmentStarted {
  attachment: Attachment;
  upload_url: string;
  /** Signature, policy and the rest. Opaque — posted back to S3 verbatim. */
  fields: Record<string, string>;
}
