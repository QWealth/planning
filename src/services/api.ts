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
  Identity,
  Milestone,
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
  Roadmap,
  RoleInfo,
  SkillInfo,
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
 * a date, so it would keep counting towards the gap report and the missed tally while
 * being invisible on the chart. A deadline that was set by mistake has no history
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

export default apiClient;
