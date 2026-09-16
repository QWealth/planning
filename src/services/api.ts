/**
 * The API client. Every call to the backend goes through here.
 *
 * baseURL is the relative '/api', never an absolute execute-api URL, and that is
 * what makes the whole same-origin arrangement work: CloudFront serves the app and
 * proxies /api/* to API Gateway on the one hostname, so there is no preflight on any
 * request and no cross-origin token to attach. Hard-coding the execute-api host
 * would still function, and would quietly re-introduce CORS on every call.
 */

import axios, { AxiosError } from 'axios';

import type {
  DigestPreview,
  Features,
  Identity,
  InviteResult,
  Milestone,
  MilestoneCheck,
  MilestoneCreate,
  MilestonePatch,
  Person,
  PersonCreate,
  PersonDeleted,
  PersonPatch,
  PersonWorkload,
  Phase,
  PhaseCreate,
  PhasePatch,
  Project,
  ProjectCreate,
  ProjectPatch,
  ProjectSummary,
  Rfc,
  RfcComment,
  RfcCreate,
  RfcPatch,
  Roadmap,
  RoleInfo,
  SkillInfo,
  SlackDirectory,
  StatusInfo,
  Task,
  TaskCreate,
  TaskPatch,
} from '../types';
import { getIdToken } from './auth';

const apiClient = axios.create({
  baseURL: '/api',
  // Generous but finite. The Lambda's own timeout is 30s (cdk/lib/lambda_stack.py),
  // so anything past that is a cold start plus a slow scan, not a hung request.
  timeout: 45000,
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * Attach the Cognito ID token to every call.
 *
 * Requested per call rather than captured once at sign-in: `getIdToken` renews an
 * expired token off the refresh token, so a tab left open past the ID token's one
 * hour lifetime keeps working instead of starting to 401 silently in the middle of
 * an edit.
 *
 * A null token means NO header at all, deliberately. With the authorizer attached
 * that produces a clean 401 from API Gateway; without it (local dev) the request
 * succeeds and the backend records the change against "system". Sending an empty or
 * placeholder Authorization header instead would turn both cases into a confusing
 * 403 that looks like an authorisation problem.
 */
apiClient.interceptors.request.use(async (requestConfig) => {
  const token = await getIdToken();
  if (token) {
    requestConfig.headers.Authorization = `Bearer ${token}`;
  }
  return requestConfig;
});

/**
 * Turn an axios failure into something worth putting on screen.
 *
 * The three cases that actually happen here are worth distinguishing, because they
 * need three different reactions from the person reading the message:
 *
 *   401 - the session expired. Sign in again.
 *   403 - signed in, but not in the `planning` group. No amount of retrying helps;
 *         somebody has to be added to the group. This is the shared-pool case and it
 *         is common enough that a generic "request failed" would send people looking
 *         for an outage.
 *   422 - the edit was rejected by validation, and FastAPI's `detail` says exactly
 *         why ("end is before start"). Showing that verbatim is the whole point.
 */
export function describeError(error: unknown): string {
  const axiosError = error as AxiosError<{ detail?: unknown }>;

  if (!axiosError?.isAxiosError) {
    return error instanceof Error ? error.message : 'Something went wrong.';
  }

  const status = axiosError.response?.status;
  const detail = axiosError.response?.data?.detail;

  if (typeof detail === 'string' && detail) {
    return detail;
  }

  // FastAPI's 422 body is a list of per-field errors, not a string.
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0] as { loc?: unknown[]; msg?: string };
    const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : null;
    return field ? `${String(field)}: ${first.msg ?? 'invalid'}` : (first.msg ?? 'Invalid input.');
  }

  if (status === 401) {
    return 'Your session has expired. Sign in again.';
  }
  if (status === 403) {
    return 'Your account is not in the planning group, so it cannot see the roadmap.';
  }
  if (!axiosError.response) {
    return 'Could not reach the API.';
  }
  return `Request failed (${status}).`;
}

/**
 * What this deployment will and will not send.
 *
 * Read by the settings page so its explanations can say whether each thing is actually
 * running. Separate from getIdentity because it describes the deployment rather than
 * the caller, and the two change for completely different reasons.
 */
export async function getFeatures(): Promise<Features> {
  const response = await apiClient.get<Features>('/features');
  return response.data;
}

/** Who the API thinks you are. Answers even when you are not authorised. */
export async function getIdentity(): Promise<Identity> {
  const response = await apiClient.get<Identity>('/me');
  return response.data;
}

/**
 * The whole roadmap in one request.
 *
 * One call rather than three because the chart cannot be drawn from any subset:
 * lanes need the projects, bars need the phases, and every owner cell needs the
 * roster to turn an email into a name. Fetching separately would render the screen
 * in three stages with the timeline reflowing as each part landed.
 */
export async function getRoadmap(includeInactive = false): Promise<Roadmap> {
  const response = await apiClient.get<Roadmap>('/roadmap', {
    params: includeInactive ? { include_inactive: true } : undefined,
  });
  const roadmap = response.data;

  return {
    ...roadmap,
    projects: (roadmap.projects ?? []).map(withChildren),
  };
}

/**
 * Guarantee `phases` and `milestones` are arrays, whatever the backend sent.
 *
 * Not theoretical: production is running a Lambda built before milestones existed, so
 * its /api/roadmap omits the key entirely. Typed as required and normalised once at
 * the boundary, every caller downstream can iterate it without a guard - the
 * alternative is `?? []` scattered through the chart and one place that forgets.
 *
 * Applied to the create response as well as the read, because a lane that arrives
 * from POST goes into exactly the same state as one that arrived from GET, and a
 * newly created project has no milestones at all - which an older backend renders as
 * an absent key rather than an empty list.
 */
function withChildren(project: Project): Project {
  return {
    ...project,
    phases: project.phases ?? [],
    milestones: project.milestones ?? [],
  };
}

/**
 * Create a lane, with its phases and milestones if it has any.
 *
 * Returns ProjectDetail - unlike PATCH, which returns the childless ProjectOut - so
 * the result can go straight into the roadmap state as a new lane.
 */
export async function createProject(body: ProjectCreate): Promise<Project> {
  const response = await apiClient.post<Project>('/projects', body);
  return withChildren(response.data);
}

/**
 * Edit a phase.
 *
 * `patch` must contain ONLY the fields that changed. The backend reads
 * `model_fields_set`, so a key present with value null means "clear this", and a key
 * that is absent means "leave it alone" - which is why the editors build their body
 * from React Hook Form's dirtyFields rather than from the form's values. Sending the
 * whole form would work today and would blank a field the moment one is added to the
 * schema but not to the form.
 */
export async function patchPhase(
  projectId: string,
  phaseId: string,
  patch: PhasePatch
): Promise<Phase> {
  const response = await apiClient.patch<Phase>(
    `/projects/${encodeURIComponent(projectId)}/phases/${encodeURIComponent(phaseId)}`,
    patch
  );
  return response.data;
}

/**
 * Remove a phase. A real delete, and the audit row keeps the full before-snapshot.
 *
 * Not soft-deleted, for the same reason milestones are not: an archived phase would
 * still carry dates and progress, so it would keep widening the chart's span and
 * feeding the lane's rolled-up state while being invisible on it — a lane reading
 * "Coding · 40%" with no Coding bar anywhere on it.
 *
 * A lane is seeded with six standard phases on create, and the whole point of them is
 * that they are a starting position rather than a commitment: not every project has a
 * Wireframes stage. Deleting the ones that do not apply is the normal use of this,
 * not the exceptional one.
 */
export async function deletePhase(projectId: string, phaseId: string): Promise<void> {
  await apiClient.delete(
    `/projects/${encodeURIComponent(projectId)}/phases/${encodeURIComponent(phaseId)}`
  );
}

/**
 * Edit a project. Same absent/null rule as patchPhase.
 *
 * Returns ProjectSummary, NOT Project: the backend's response model here is
 * `ProjectOut`, which has no `phases`. Merge it field by field into the lane in
 * state - spreading the whole response over the existing project would empty it.
 */
export async function patchProject(
  projectId: string,
  patch: ProjectPatch
): Promise<ProjectSummary> {
  const response = await apiClient.patch<ProjectSummary>(
    `/projects/${encodeURIComponent(projectId)}`,
    patch
  );
  return response.data;
}

/**
 * Write a new lane order: one PATCH per project whose position actually changed.
 *
 * There is no bulk endpoint and this deliberately does not add one. `lane_order` has
 * been in PROJECT_UPDATABLE since the table was designed, so reordering is already
 * expressible as the edits it literally is - and each one earns its own audit row
 * saying who moved that lane, which a single "reorder" call would flatten into one
 * entry that cannot answer "who put this at the top".
 *
 * Issued in parallel because they touch different partition keys and cannot contend,
 * and because a serial walk of ten lanes is ten round trips the user waits through.
 *
 * PARTIAL FAILURE IS REAL AND IS THE CALLER'S PROBLEM.
 *
 * Promise.all rejects on the first failure while the others carry on and land, so a
 * rejection here means the stored order is some mixture of old and new. There is no
 * honest way to roll that back - the successful PATCHes are committed, and "undo" is
 * more writes that can themselves fail. So this makes no attempt to, and the caller
 * must re-read the roadmap rather than keep showing its draft: the screen has to end
 * up displaying what is stored, not what was asked for. See RoadmapPage.saveOrder.
 */
export async function saveLaneOrder(
  changes: readonly { project_id: string; lane_order: number }[]
): Promise<void> {
  await Promise.all(
    changes.map((change) => patchProject(change.project_id, { lane_order: change.lane_order }))
  );
}

/**
 * Add a phase to an existing lane.
 *
 * Unlike patchPhase this sends the whole body, and that is not a lapse in the
 * absent/null discipline - it is the other half of it. There is no stored row to
 * leave alone yet, so an omitted field takes the server's default rather than keeping
 * a previous value, and every default is the honest one: null dates, null progress,
 * unassigned.
 */
export async function createPhase(projectId: string, body: PhaseCreate): Promise<Phase> {
  const response = await apiClient.post<Phase>(
    `/projects/${encodeURIComponent(projectId)}/phases`,
    body
  );
  return response.data;
}

/** Add a milestone to an existing lane. Same reasoning as createPhase. */
export async function createMilestone(
  projectId: string,
  body: MilestoneCreate
): Promise<Milestone> {
  const response = await apiClient.post<Milestone>(
    `/projects/${encodeURIComponent(projectId)}/milestones`,
    body
  );
  return response.data;
}

/**
 * Edit a milestone. Same absent/null rule as patchPhase.
 *
 * `date: null` un-commits it - still needed, no date agreed - and is a different
 * request from omitting `date`. `done` is independent of the date in both directions:
 * a milestone can be finished early, or be a month past due and still open.
 */
export async function patchMilestone(
  projectId: string,
  milestoneId: string,
  patch: MilestonePatch
): Promise<Milestone> {
  const response = await apiClient.patch<Milestone>(
    `/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestoneId)}`,
    patch
  );
  return response.data;
}

/**
 * Remove a milestone. A real delete, unlike people and projects.
 *
 * Soft-deleting it would be worse than useless here: an inactive milestone still has
 * a date, so it would keep counting towards the missed tally while being invisible
 * on the chart. A deadline that was set by mistake has no history
 * worth preserving on the roadmap - the audit row keeps the full before-snapshot.
 */
export async function deleteMilestone(projectId: string, milestoneId: string): Promise<void> {
  await apiClient.delete(
    `/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestoneId)}`
  );
}

/**
 * The specialisation vocabulary.
 *
 * Fetched, never hardcoded. The closed list lives in fast/app/skills.py, and a
 * duplicate here would drift silently - a renamed skill stops matching the values
 * already stored against people, who then simply appear to have lost it.
 */
export async function getSkills(): Promise<SkillInfo[]> {
  const response = await apiClient.get<SkillInfo[]>('/skills');
  return response.data;
}

/**
 * The role vocabulary: BA, UX, Software engineer, QA, Data, Leadership.
 *
 * A different axis from the skills above, not a finer grain of them: a role is what
 * somebody IS, a skill is what they can be staffed onto. A back-end engineer who is
 * good at CSS holds the front-end skill and is not UX. See fast/app/roles.py.
 */
export async function getRoles(): Promise<RoleInfo[]> {
  const response = await apiClient.get<RoleInfo[]>('/roles');
  return response.data;
}

/**
 * The roster alone - no assignments, no phase counts.
 *
 * Separate from getWorkload because the board only needs a list of people to assign
 * work TO, and /people/workload carries every phase everybody owns to answer that.
 * Active only, by default: assigning a project's backlog to somebody who has left is
 * not a choice the picker should offer.
 */
export async function getPeople(includeInactive = false): Promise<Person[]> {
  const response = await apiClient.get<Person[]>('/people', {
    params: includeInactive ? { include_inactive: true } : undefined,
  });
  return response.data;
}

/**
 * One roster row.
 *
 * The settings page reads itself with this rather than filtering getPeople, because a
 * person editing their own preferences may be inactive on the roster and still able to
 * sign in - and getPeople's default hides exactly those rows.
 */
export async function getPerson(email: string): Promise<Person> {
  const response = await apiClient.get<Person>(
    `/people/${encodeURIComponent(email)}`
  );
  return response.data;
}

/** Everyone, with what they own. The Team page's primary read. */
export async function getWorkload(): Promise<PersonWorkload[]> {
  const response = await apiClient.get<PersonWorkload[]>('/people/workload');
  return response.data;
}

/**
 * Add somebody to the roster.
 *
 * This does not create a Cognito account and grants no access: the roster is who
 * work can be assigned to, the planning group is who may log in. 409 if the address
 * is already present - the backend refuses rather than overwriting, because
 * re-adding an existing person would otherwise silently reset their roles and skills
 * and reactivate a deactivated account.
 *
 * `roles` is required and must be non-empty, or this 422s.
 */
export async function createPerson(body: PersonCreate): Promise<Person> {
  const response = await apiClient.post<Person>('/people', body);
  return response.data;
}

/**
 * Give somebody a login: create the Cognito account and put them in the planning group.
 *
 * The mirror image of createPerson above, and the two are deliberately separate calls
 * rather than one. This grants ACCESS and creates no roster row; createPerson creates
 * a ROSTER ROW and grants no access. Fusing them would mean either inviting everybody
 * you want to schedule work for, or listing everybody who can log in as staff.
 *
 * Idempotent, and that matters more here than usual: the pool is shared with the
 * marketing compliance tool, so most colleagues already have an account. Inviting one
 * of them succeeds with `account_created: false` rather than failing with a 409.
 *
 * Admin only — a 403 otherwise. Cognito's own email carries the temporary password
 * but no link and the wrong product name, so the instructions are a separate message.
 * The API composes it (see fast/app/invites.py) and returns it as `message`.
 *
 * `slackUserId` is a DELIVERY ROUTE, not an identity — pass it only when the address
 * came from the Slack picker, where we know which human it belongs to. Given one, the
 * API DMs the message itself and answers `dm_sent: true`; without one it hands the
 * text back for the admin to send, which is what this did before Slack.
 */
export async function invitePerson(
  email: string,
  slackUserId?: string
): Promise<InviteResult> {
  const response = await apiClient.post<InviteResult>('/people/invite', {
    email,
    // Absent, not null, when the address was typed. The API treats a blank as absent
    // too, but sending the key only when it means something keeps the audit row and
    // the request honest about which path the invite came in through.
    ...(slackUserId ? { slack_user_id: slackUserId } : {}),
  });
  return response.data;
}

/**
 * Everybody in the Slack workspace who could be invited, flagged with who already has
 * a roster row.
 *
 * A PICKER SOURCE, NOT A ROSTER. Nothing here is on the team list and calling this
 * creates nothing — see fast/app/routes/slack.py, which explains why keeping the two
 * apart is load-bearing rather than tidy.
 *
 * NEVER REJECTS FOR SLACK BEING DOWN. The API answers 200 with `unavailable` set when
 * it cannot reach Slack, is missing a scope, or has no secret configured, because the
 * typed-address invite worked before Slack existed and must keep working. So the
 * caller checks `unavailable` rather than catching — a rejection here means the
 * request itself failed, which for an admin-only route usually means a 403.
 */
export async function fetchSlackPeople(): Promise<SlackDirectory> {
  const response = await apiClient.get<SlackDirectory>('/slack/people');
  return response.data;
}

/**
 * Edit a person. Same absent/null rule as patchPhase, with one exception:
 * `specialisations` REPLACES the whole list rather than merging into it.
 */
export async function patchPerson(email: string, patch: PersonPatch): Promise<Person> {
  const response = await apiClient.patch<Person>(
    `/people/${encodeURIComponent(email)}`,
    patch
  );
  return response.data;
}

/**
 * Deactivate somebody: the reversible removal, for a person who has moved on.
 *
 * Their assignments deliberately keep pointing at them: unassigning every project
 * when somebody leaves would erase the record of who was responsible, and the
 * roadmap would show unowned lanes with no explanation of why.
 *
 * A POST on an explicit path, not the DELETE it used to be. DELETE now really
 * deletes - see deletePerson - and two operations whose consequences differ this
 * much should not be one typo apart.
 */
export async function deactivatePerson(email: string): Promise<Person> {
  const response = await apiClient.post<Person>(
    `/people/${encodeURIComponent(email)}/deactivate`
  );
  return response.data;
}

/**
 * Delete somebody for good, blanking every assignment that named them.
 *
 * Irreversible, and it changes rows the caller did not name: any lane where they
 * were DRI or Support, and any phase they owned, comes back unassigned. The server
 * clears those first so nothing is ever left pointing at a person who no longer
 * exists, then reports what it cleared.
 *
 * That report is why this returns a value rather than void. Once the call succeeds
 * there is no way left to ask "which lanes did this just leave unowned" - the email
 * that would have answered it is exactly what was removed - so the answer has to
 * travel back with the response and be put in front of whoever pressed the button.
 */
export async function deletePerson(email: string): Promise<PersonDeleted> {
  const response = await apiClient.delete<PersonDeleted>(
    `/people/${encodeURIComponent(email)}`
  );
  return response.data;
}

/**
 * The Monday digest this caller would receive, composed and not sent.
 *
 * `days` previews a window before it is saved, which is what lets the settings page
 * show the effect of a choice instead of asking somebody to save it and wait a week.
 * Omitted, the server uses the stored preference.
 *
 * Read-only in the strongest sense: it sends no Slack message and claims no week, so
 * looking at the digest cannot cancel it. See fast/app/routes/digest.py.
 */
export async function getDigestPreview(days?: number): Promise<DigestPreview> {
  const response = await apiClient.get<DigestPreview>('/digest/preview', {
    params: days === undefined ? undefined : { days },
  });
  return response.data;
}

/**
 * The RFC status vocabulary: draft, review, accepted, rejected, withdrawn.
 *
 * Fetched rather than hardcoded, for the same reason as getSkills above. The list
 * lives in fast/app/work.py, and a copy here would drift: a status renamed on the
 * server stops matching the values already stored against real documents, which then
 * render with a raw slug or vanish from a filter that no longer matches them.
 */
export async function getRfcStatuses(): Promise<StatusInfo[]> {
  const response = await apiClient.get<StatusInfo[]>('/rfcs/statuses');
  return response.data;
}

/**
 * Every RFC, most recently updated first.
 *
 * Bodies included — the API returns whole documents, and this deliberately does not
 * ask for a summary projection. There are tens of these, not thousands, and the one
 * screen that lists them wants to show a first line; a list endpoint that stripped
 * the body would mean a second request per row to get it back.
 */
export async function getRfcs(): Promise<Rfc[]> {
  const response = await apiClient.get<Rfc[]>('/rfcs');
  return response.data;
}

/** One RFC. Throws on 404, which the page turns into "this has been deleted". */
export async function getRfc(itemId: string): Promise<Rfc> {
  const response = await apiClient.get<Rfc>(`/rfcs/${encodeURIComponent(itemId)}`);
  return response.data;
}

/**
 * Write a new RFC.
 *
 * Sends the whole body, which is the create-path half of the absent/null discipline:
 * there is no stored row to leave alone, so an omitted field takes the server's
 * default, and every default here is the honest one — no project, no owner, draft,
 * undecided.
 */
export async function createRfc(body: RfcCreate): Promise<Rfc> {
  const response = await apiClient.post<Rfc>('/rfcs', body);
  return response.data;
}

/**
 * Edit an RFC. Same absent/null rule as patchPhase, and it bites hardest here.
 *
 * `project_id: null` detaches the document from its project — a real edit, and the
 * reason the feature was asked for. Omitting project_id leaves it attached. The
 * editor builds this from React Hook Form's dirtyFields so that fixing a typo in the
 * title cannot unfile the document as a side effect.
 */
export async function patchRfc(itemId: string, patch: RfcPatch): Promise<Rfc> {
  const response = await apiClient.patch<Rfc>(`/rfcs/${encodeURIComponent(itemId)}`, patch);
  return response.data;
}

/**
 * Delete an RFC outright. There is no soft delete and there should not be.
 *
 * `withdrawn` is the status for retiring a proposal while keeping its reasoning
 * readable, and it is what almost every retirement should use. Reaching for this
 * means the document was created by mistake. The audit row keeps the full
 * before-snapshot including the body, so the text is recoverable by someone with
 * access to the table.
 */
export async function deleteRfc(itemId: string): Promise<void> {
  await apiClient.delete(`/rfcs/${encodeURIComponent(itemId)}`);
}

/**
 * Note that the signed-in person has opened this RFC.
 *
 * Fire-and-forget at the call site: the reader is already on screen by the time this
 * runs, and a failed read-receipt must never turn a document somebody is reading into
 * an error. The worst case is the row stays highlighted and they open it again.
 */
export async function markRfcRead(itemId: string): Promise<void> {
  await apiClient.post(`/rfcs/${encodeURIComponent(itemId)}/read`);
}

/* --------------------------------------------------------------- comments -- */

/**
 * The thread on one RFC, oldest first.
 *
 * The order comes from the server's sort key rather than a sort here, so a caller
 * cannot forget to apply one and render a discussion out of sequence.
 */
export async function getRfcComments(itemId: string): Promise<RfcComment[]> {
  const response = await apiClient.get<RfcComment[]>(
    `/rfcs/${encodeURIComponent(itemId)}/comments`
  );
  return response.data;
}

/**
 * Post a comment.
 *
 * Note what is NOT a parameter: the author. The API takes it from the token, and a
 * signature that accepted one here would be a way to post as somebody else the first
 * time a caller passed the wrong variable.
 */
export async function createRfcComment(itemId: string, body: string): Promise<RfcComment> {
  const response = await apiClient.post<RfcComment>(
    `/rfcs/${encodeURIComponent(itemId)}/comments`,
    { body }
  );
  return response.data;
}

/** Change the text of your own comment. The API refuses anybody else's, admin included. */
export async function updateRfcComment(
  itemId: string,
  commentId: string,
  body: string
): Promise<RfcComment> {
  const response = await apiClient.patch<RfcComment>(
    `/rfcs/${encodeURIComponent(itemId)}/comments/${encodeURIComponent(commentId)}`,
    { body }
  );
  return response.data;
}

/** Remove a comment. Yours, or anybody's if you are an admin. */
export async function deleteRfcComment(itemId: string, commentId: string): Promise<void> {
  await apiClient.delete(
    `/rfcs/${encodeURIComponent(itemId)}/comments/${encodeURIComponent(commentId)}`
  );
}

/* ------------------------------------------------------------------ tasks -- */

export async function getTaskStatuses(): Promise<StatusInfo[]> {
  const response = await apiClient.get<StatusInfo[]>('/tasks/statuses');
  return response.data;
}

/**
 * Every task — tickets and subtasks together, most recently updated first.
 *
 * ONE request for both levels, not one per ticket. The API does support
 * `?parent_id=`, and calling it per ticket would be N+1 round trips against a Lambda
 * that scales to zero: thirty tickets, thirty cold-start-eligible calls, to draw one
 * board. The whole set is tens of rows, so the board splits it by `parent_id` in
 * memory — which is only trivial because nesting is capped at one level.
 */
export async function getTasks(): Promise<Task[]> {
  const response = await apiClient.get<Task[]>('/tasks');
  return response.data;
}

/** One task. Throws on 404, which the page turns into "this has been deleted". */
export async function getTask(itemId: string): Promise<Task> {
  const response = await apiClient.get<Task>(`/tasks/${encodeURIComponent(itemId)}`);
  return response.data;
}

/**
 * Create a ticket, or a subtask of one when `parent_id` is set.
 *
 * The one-level cap is enforced by the backend, which refuses a parent that is
 * itself a subtask. The board also hides the affordance, but hiding a button is a
 * convenience and not a rule — the rule has to live where it cannot be skipped by a
 * second client or a curl.
 */
export async function createTask(body: TaskCreate): Promise<Task> {
  const response = await apiClient.post<Task>('/tasks', body);
  return response.data;
}

/**
 * Edit a task. Same absent/null rule as everywhere; `parent_id` is the sharp edge.
 *
 * `parent_id: null` PROMOTES a subtask to a top-level ticket, and omitting it leaves
 * the task where it is. TaskEditor builds this from dirtyFields for that reason: a
 * form that helpfully sent every field would re-assert the parent on every save,
 * which looks harmless until it re-asserts one somebody had just cleared.
 */
export async function patchTask(itemId: string, patch: TaskPatch): Promise<Task> {
  const response = await apiClient.patch<Task>(`/tasks/${encodeURIComponent(itemId)}`, patch);
  return response.data;
}

/**
 * Delete a task. Deleting a ticket PROMOTES its subtasks — it does not cascade.
 *
 * That matters at the call site, because it makes the caller's local state wrong in
 * an invisible way: the children are still in memory pointing at a parent that no
 * longer exists, so a view filtering "subtasks of X" stops showing them rather than
 * showing them at the top level where the server has just put them. Refetch after
 * this; do not splice the deleted row out of the array.
 */
export async function deleteTask(itemId: string): Promise<void> {
  await apiClient.delete(`/tasks/${encodeURIComponent(itemId)}`);
}

export default apiClient;

/**
 * The milestone-check log, newest first.
 *
 * 403s for anybody without the BA role on their roster entry. The caller should check
 * `identity.is_ba` before offering the link rather than relying on the refusal — both
 * come through the same predicate on the server, so they cannot disagree.
 */
export async function getMilestoneLog(): Promise<MilestoneCheck[]> {
  const response = await apiClient.get<MilestoneCheck[]>('/milestone-log');
  return response.data;
}
