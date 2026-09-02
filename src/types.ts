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
 *   stars           0-3, what they can do TODAY. 3 is the obvious person to ask.
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
export type PersonRole = 'ba' | 'ux' | 'software-engineer' | 'qa' | 'data' | 'leadership';

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
  created_at: string | null;
  updated_at: string | null;
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
}

export interface MilestonePatch {
  name?: string;
  date?: string | null;
  note?: string | null;
  done?: boolean;
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
  phases?: PhaseCreate[];
  milestones?: MilestoneCreate[];
}
