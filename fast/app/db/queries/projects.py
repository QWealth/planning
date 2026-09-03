"""DynamoDB queries for projects and phases.

Both live in one table partitioned on project_id, so reading a project and all of
its phases is a single Query rather than a fan-out. See PROJECT_SK in db/models.py
for why the project row sorts first.
"""

import logging
import uuid
from typing import Any, Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from app import config
from app.db.models import (
    MILESTONE_SK_PREFIX,
    PHASE_SK_PREFIX,
    PROJECT_SK,
    MilestoneModel,
    PhaseModel,
    ProjectModel,
)

# ValidationError and _iso are re-exported rather than defined here: routes and tests
# reach for them as `q.ValidationError` and `q._iso`, so moving the definitions into
# the shared module had to leave both names resolvable on this one.
from app.db.queries._updates import ValidationError, apply_update
from app.db.queries._updates import iso as _iso

logger = logging.getLogger(__name__)

dynamodb = boto3.resource("dynamodb", region_name=config.AWS_REGION)

# Fields a caller may change, per entity. An allowlist rather than "whatever is in
# the dict": the update dicts arrive from Pydantic models today, but this function
# is one careless caller away from being handed a raw request body, and an
# unfiltered SET would let that body overwrite project_id, sk or created_at.
PROJECT_UPDATABLE = {"name", "lane_order", "dri_email", "support_email", "active"}
PHASE_UPDATABLE = {
    "name",
    "phase_order",
    "owner_email",
    "start",
    "end",
    "progress",
    "structural",
}
MILESTONE_UPDATABLE = {"name", "date", "note", "done", "phase_id"}


def _sort_milestones(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    By date, with undated ones last.

    Undated milestones sort to the end rather than the start: an empty date is not
    "the beginning of time", it is "not decided", and floating those to the top of
    every lane would put the least settled thing first on the chart.
    """
    rows.sort(key=lambda m: (m["date"] is None, m["date"] or "", m["name"] or ""))
    return rows


def get_projects_table():
    """Get the projects table."""
    return dynamodb.Table(config.PROJECTS_TABLE_NAME)


def _new_id() -> str:
    """
    A short opaque id.

    uuid4 rather than a slug of the name, because a project gets renamed - "QWAPP
    Expansion Packs" was three different things in the workbook's history - and an
    id derived from a name either goes stale or forces a rewrite of every reference.
    """
    return uuid.uuid4().hex[:12]


# ------------------------------------------------------------------------ reads
def get_project(project_id: str) -> Optional[dict[str, Any]]:
    """
    A project and all of its phases, or None if there is no such project.

    Pagination is followed to the end. One project's phases are far inside a 1MB
    page today (the largest lane has nine), but a truncated read here would render a
    lane that is silently missing its last phases - a wrong roadmap that looks
    entirely plausible, which is the failure mode this whole migration is about.
    """
    table = get_projects_table()
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {"KeyConditionExpression": Key("project_id").eq(project_id)}

    try:
        while True:
            response = table.query(**kwargs)
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                break
            kwargs["ExclusiveStartKey"] = last_key
    except ClientError as e:
        logger.error("Error getting project %s: %s", project_id, e)
        raise

    project_item = next((i for i in items if i.get("sk") == PROJECT_SK), None)
    if project_item is None:
        return None

    phases = [
        PhaseModel.from_item(i)
        for i in items
        if str(i.get("sk", "")).startswith(PHASE_SK_PREFIX)
    ]
    phases.sort(key=lambda p: (p["phase_order"], p["name"] or ""))

    milestones = [
        MilestoneModel.from_item(i)
        for i in items
        if str(i.get("sk", "")).startswith(MILESTONE_SK_PREFIX)
    ]

    project = ProjectModel.from_item(project_item)
    project["phases"] = phases
    project["milestones"] = _sort_milestones(milestones)
    return project


def list_projects(include_inactive: bool = False) -> list[dict[str, Any]]:
    """
    Every project with its phases, in lane order.

    One scan of the whole table, then grouped in memory. That is the right shape at
    this size - nine projects and ~54 phases is a few kilobytes - and it means the
    roadmap screen is one round trip. If the table ever grows past a page or two,
    this becomes a scan-with-filter on sk = "#PROJECT" plus a per-project query, at
    the cost of the fan-out.
    """
    table = get_projects_table()
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {}

    try:
        while True:
            response = table.scan(**kwargs)
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                break
            kwargs["ExclusiveStartKey"] = last_key
    except ClientError as e:
        logger.error("Error listing projects: %s", e)
        raise

    projects: dict[str, dict[str, Any]] = {}
    phases: dict[str, list[dict[str, Any]]] = {}
    milestones: dict[str, list[dict[str, Any]]] = {}

    for item in items:
        sk = str(item.get("sk", ""))
        pid = item.get("project_id")
        if sk == PROJECT_SK:
            projects[pid] = ProjectModel.from_item(item)
        elif sk.startswith(PHASE_SK_PREFIX):
            phases.setdefault(pid, []).append(PhaseModel.from_item(item))
        elif sk.startswith(MILESTONE_SK_PREFIX):
            milestones.setdefault(pid, []).append(MilestoneModel.from_item(item))

    result = []
    for pid, project in projects.items():
        if not include_inactive and not project["active"]:
            continue
        rows = phases.get(pid, [])
        rows.sort(key=lambda p: (p["phase_order"], p["name"] or ""))
        project["phases"] = rows
        project["milestones"] = _sort_milestones(milestones.get(pid, []))
        result.append(project)

    # Orphaned children - a phase or milestone whose project row is gone - are
    # dropped, not rendered under a fabricated lane. Logged because it means
    # something deleted a project without its children and that is a bug worth
    # chasing, not a data state to accommodate.
    orphans = (set(phases) | set(milestones)) - set(projects)
    if orphans:
        logger.warning("Dropping rows for %d unknown project(s): %s", len(orphans), orphans)

    result.sort(key=lambda p: (p["lane_order"], p["name"] or ""))
    return result


# ----------------------------------------------------------------------- writes
def create_project(
    name: str,
    lane_order: int = 0,
    dri_email: Optional[str] = None,
    support_email: Optional[str] = None,
    active: bool = True,
    phases: Optional[list[dict[str, Any]]] = None,
    milestones: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Create a project and, optionally, its phases and milestones in one batch."""
    table = get_projects_table()
    project_id = _new_id()
    item = ProjectModel.create_item(
        project_id=project_id,
        name=name,
        lane_order=lane_order,
        dri_email=dri_email,
        support_email=support_email,
        active=active,
    )

    phase_items = []
    for order, phase in enumerate(phases or []):
        phase_items.append(
            PhaseModel.create_item(
                project_id=project_id,
                phase_id=_new_id(),
                name=phase["name"],
                phase_order=phase.get("phase_order") or order,
                owner_email=phase.get("owner_email"),
                start=_iso(phase.get("start")),
                end=_iso(phase.get("end")),
                progress=phase.get("progress"),
                structural=phase.get("structural", False),
            )
        )

    milestone_items = []
    for milestone in milestones or []:
        # No phase_id on this path, and a sent one is refused rather than dropped.
        # The phases in this same call are getting their ids right here, a few lines
        # up, so there is no id a caller could possibly have meant - any string they
        # sent names a phase of some OTHER project. Silently storing it would file the
        # milestone under a heading this lane never draws; silently ignoring it would
        # accept the request and lose the attachment. Say so instead, and let the
        # caller attach it with a PATCH once the phase has an id.
        if milestone.get("phase_id"):
            raise ValidationError(
                "a milestone cannot name a phase while the project is being created - "
                "the phases in this request do not have ids yet. Create the project, "
                "then PATCH the milestone with its phase_id."
            )
        milestone_items.append(
            MilestoneModel.create_item(
                project_id=project_id,
                milestone_id=_new_id(),
                name=milestone["name"],
                date=_iso(milestone.get("date")),
                note=milestone.get("note"),
                done=milestone.get("done", False),
            )
        )

    try:
        with table.batch_writer() as batch:
            batch.put_item(Item=item)
            for phase_item in phase_items:
                batch.put_item(Item=phase_item)
            for milestone_item in milestone_items:
                batch.put_item(Item=milestone_item)
    except ClientError as e:
        logger.error("Error creating project %s: %s", name, e)
        raise

    logger.info(
        "Created project %s (%s) with %d phases and %d milestones",
        name, project_id, len(phase_items), len(milestone_items),
    )
    result = ProjectModel.from_item(item)
    result["phases"] = [PhaseModel.from_item(p) for p in phase_items]
    result["milestones"] = _sort_milestones(
        [MilestoneModel.from_item(m) for m in milestone_items]
    )
    return result


def _apply_update(
    key: dict[str, Any],
    changes: dict[str, Any],
    allowed: set[str],
) -> dict[str, Any]:
    """
    SET every field in `changes` on this table, including the None ones.

    The body of this lives in queries/_updates.py, because queries/work.py needs the
    identical behaviour against a different table. Read the docstring there for why a
    None reaching it means "store null" rather than "not supplied" - that distinction
    is the reason this app exists and it is defended in three places.

    The table is resolved here, at call time, rather than inside the helper. That is
    what keeps `projects.dynamodb = ddb` working as a monkeypatch point in demo.py
    and the tests.
    """
    return apply_update(get_projects_table(), key, changes, allowed, "project_id")


def update_project(project_id: str, changes: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Update a project. `changes` holds only fields the caller actually sent."""
    if not changes:
        existing = get_project(project_id)
        return existing

    try:
        item = _apply_update(
            {"project_id": project_id, "sk": PROJECT_SK}, changes, PROJECT_UPDATABLE
        )
    except ValidationError as e:
        if str(e) == "no such record":
            return None
        raise
    return ProjectModel.from_item(item)


def delete_project(project_id: str) -> bool:
    """
    Soft-delete: mark the project inactive and leave its phases alone.

    Soft because the audit log's before/after snapshots reference phases by id, and
    hard-deleting the rows would leave a history that points at nothing. Inactive
    projects are excluded from list_projects by default, so this looks like a delete
    to anyone using the app while remaining recoverable by anyone reading the table.
    """
    try:
        _apply_update({"project_id": project_id, "sk": PROJECT_SK}, {"active": False},
                      PROJECT_UPDATABLE)
        return True
    except ValidationError:
        return False


def get_phase(project_id: str, phase_id: str) -> Optional[dict[str, Any]]:
    """One phase, or None."""
    try:
        response = get_projects_table().get_item(
            Key={"project_id": project_id, "sk": PhaseModel.sk(phase_id)}
        )
    except ClientError as e:
        logger.error("Error getting phase %s/%s: %s", project_id, phase_id, e)
        raise
    item = response.get("Item")
    return PhaseModel.from_item(item) if item else None


def create_phase(project_id: str, phase: dict[str, Any]) -> dict[str, Any]:
    """Add a phase to an existing project."""
    item = PhaseModel.create_item(
        project_id=project_id,
        phase_id=_new_id(),
        name=phase["name"],
        phase_order=phase.get("phase_order", 0),
        owner_email=phase.get("owner_email"),
        start=_iso(phase.get("start")),
        end=_iso(phase.get("end")),
        progress=phase.get("progress"),
        structural=phase.get("structural", False),
    )
    try:
        get_projects_table().put_item(Item=item)
    except ClientError as e:
        logger.error("Error creating phase on %s: %s", project_id, e)
        raise
    return PhaseModel.from_item(item)


def update_phase(
    project_id: str, phase_id: str, changes: dict[str, Any]
) -> Optional[dict[str, Any]]:
    """
    Update a phase, after checking the result rather than the request.

    The ordering and structural rules are properties of the phase as it will end up,
    not of the patch, so they are checked against the stored row merged with the
    changes. Validating the request alone would let a PATCH that sets only `end`
    move it before an existing `start`, which is precisely the kind of quietly
    impossible schedule the workbook was full of.
    """
    if not changes:
        return get_phase(project_id, phase_id)

    current = get_phase(project_id, phase_id)
    if current is None:
        return None

    merged = {**current, **changes}

    start, end = _iso(merged.get("start")), _iso(merged.get("end"))
    if start and end and end < start:
        raise ValidationError(f"end ({end}) is before start ({start})")

    if merged.get("structural") and (start or end or merged.get("progress") is not None):
        raise ValidationError(
            "a structural phase marks ongoing support, not scheduled work, so it "
            "cannot carry dates or progress"
        )

    item = _apply_update(
        {"project_id": project_id, "sk": PhaseModel.sk(phase_id)}, changes, PHASE_UPDATABLE
    )
    return PhaseModel.from_item(item)


def get_milestone(project_id: str, milestone_id: str) -> Optional[dict[str, Any]]:
    """One milestone, or None."""
    try:
        response = get_projects_table().get_item(
            Key={"project_id": project_id, "sk": MilestoneModel.sk(milestone_id)}
        )
    except ClientError as e:
        logger.error("Error getting milestone %s/%s: %s", project_id, milestone_id, e)
        raise
    item = response.get("Item")
    return MilestoneModel.from_item(item) if item else None


def _check_phase_ref(project_id: str, phase_id: Optional[str]) -> None:
    """
    Refuse a phase_id that does not name a phase of THIS project.

    None is fine and is the common case - a milestone that belongs to the lane as a
    whole. What is not fine is a string that names nothing, or names a phase of some
    other project: DynamoDB has no foreign keys, so either would be stored happily
    and then group the milestone under a heading this project never draws. The row
    would exist, be returned by the API, and appear nowhere - the exact failure this
    codebase keeps refusing to allow.

    Scoped to the project rather than "does this phase exist anywhere", because the
    phase table is partitioned on project_id and a cross-project reference is the
    mistake a copied id actually produces.
    """
    if not phase_id:
        return
    if get_phase(project_id, phase_id) is None:
        raise ValidationError(
            f"phase_id {phase_id!r} is not a phase of this project"
        )


def create_milestone(project_id: str, milestone: dict[str, Any]) -> dict[str, Any]:
    """
    Add a milestone to an existing project.

    Checked before the write, not after: an unattached milestone is recoverable by
    editing it, but one stored against a phase that does not exist is invisible on
    the chart, which is a harder thing to notice than a 400.
    """
    phase_id = milestone.get("phase_id") or None
    _check_phase_ref(project_id, phase_id)

    item = MilestoneModel.create_item(
        project_id=project_id,
        milestone_id=_new_id(),
        name=milestone["name"],
        date=_iso(milestone.get("date")),
        note=milestone.get("note"),
        done=milestone.get("done", False),
        phase_id=phase_id,
    )
    try:
        get_projects_table().put_item(Item=item)
    except ClientError as e:
        logger.error("Error creating milestone on %s: %s", project_id, e)
        raise
    return MilestoneModel.from_item(item)


def update_milestone(
    project_id: str, milestone_id: str, changes: dict[str, Any]
) -> Optional[dict[str, Any]]:
    """
    Update a milestone, checking any phase it is being moved under.

    There is still no ordering rule to get wrong - a milestone is one date - so the
    check here is a reference check rather than update_phase's merged-result check.
    Clearing the date back to null is a legitimate edit meaning "this is still needed
    but the commitment has gone", and _apply_update stores that rather than skipping
    it; `"phase_id": null` is the same kind of edit, meaning "this belongs to the
    project, not to that stage".

    Only validated when `phase_id` was actually SENT. Testing the merged value
    instead would re-check the stored attachment on every unrelated PATCH, so a
    milestone left pointing at a phase somebody deleted by hand would refuse to have
    its name fixed - punishing the wrong edit for a mess it did not make.
    """
    if not changes:
        return get_milestone(project_id, milestone_id)

    if get_milestone(project_id, milestone_id) is None:
        return None

    if "phase_id" in changes:
        _check_phase_ref(project_id, changes["phase_id"])

    item = _apply_update(
        {"project_id": project_id, "sk": MilestoneModel.sk(milestone_id)},
        changes,
        MILESTONE_UPDATABLE,
    )
    return MilestoneModel.from_item(item)


def delete_milestone(project_id: str, milestone_id: str) -> bool:
    """Hard-delete a milestone. Same reasoning as delete_phase."""
    try:
        response = get_projects_table().delete_item(
            Key={"project_id": project_id, "sk": MilestoneModel.sk(milestone_id)},
            ReturnValues="ALL_OLD",
        )
    except ClientError as e:
        logger.error("Error deleting milestone %s/%s: %s", project_id, milestone_id, e)
        raise
    return bool(response.get("Attributes"))


def detach_phase_milestones(project_id: str, phase_id: str) -> list[str]:
    """
    Un-file every milestone that names this phase, and say which ones.

    DELETING A PHASE PROMOTES ITS MILESTONES, IT DOES NOT TAKE THEM WITH IT
    ----------------------------------------------------------------------
    The same rule the work entity follows when a ticket is deleted, and for the same
    reason: a milestone is a commitment somebody made, and "we restructured the
    phases" is not a decision to drop it. A regulatory date does not stop mattering
    because the stage it was filed under got merged into another one.

    Doing nothing is the option that looks cheapest and is worst. The id would
    survive as a reference to a phase that is gone, and the milestone would group
    under a heading nothing draws - stored, returned by the API, invisible. Setting
    it to null puts the milestone back where an unattached one lives, which is a
    place the chart already knows how to render.

    Returns the ids it changed, so a caller that cares can log or audit them. The
    route does audit them, one row per milestone: a bulk edit nobody recorded is how
    a chart quietly stops matching its own history.
    """
    project = get_project(project_id)
    if project is None:
        return []

    detached: list[str] = []
    for milestone in project.get("milestones", []):
        if milestone.get("phase_id") != phase_id:
            continue
        _apply_update(
            {"project_id": project_id, "sk": MilestoneModel.sk(milestone["milestone_id"])},
            {"phase_id": None},
            MILESTONE_UPDATABLE,
        )
        detached.append(milestone["milestone_id"])

    if detached:
        logger.info(
            "Detached %d milestone(s) from deleted phase %s/%s",
            len(detached), project_id, phase_id,
        )
    return detached


def delete_phase(project_id: str, phase_id: str) -> bool:
    """
    Hard-delete a phase, first detaching any milestones filed under it.

    "We are not doing that stage" is an ordinary edit rather than a decommissioning,
    so unlike a project this is a real delete. The audit entry carries the full
    before-snapshot, so the content is recoverable from the history even though the
    row is not.

    The detach runs BEFORE the delete, because it reads the phase's own row to find
    the project and would find nothing afterwards. It is deliberately not a
    transaction: worst case the milestones are unattached and the phase survives,
    which is a visible, correctable state - the reverse order risks the invisible one.
    """
    detach_phase_milestones(project_id, phase_id)

    try:
        response = get_projects_table().delete_item(
            Key={"project_id": project_id, "sk": PhaseModel.sk(phase_id)},
            ReturnValues="ALL_OLD",
        )
    except ClientError as e:
        logger.error("Error deleting phase %s/%s: %s", project_id, phase_id, e)
        raise
    return bool(response.get("Attributes"))


# ------------------------------------------------------- cross-entity operations
def find_assignments(email: str) -> dict[str, Any]:
    """
    Everywhere one person is currently named, across every project.

    Archived projects are included on purpose. An inactive lane still stores the
    email, so skipping them would leave a reference behind that the caller has just
    been told does not exist - and it would reappear the day the lane is restored.

    Read-only, so it can also answer "what would this delete cost?" before anything
    is written. The route uses it for exactly that.
    """
    wanted = (email or "").strip().lower()
    found: dict[str, Any] = {"dri": [], "support": [], "phases": []}
    if not wanted:
        return found

    for project in list_projects(include_inactive=True):
        summary = {"project_id": project["project_id"], "project_name": project["name"]}
        if (project.get("dri_email") or "").lower() == wanted:
            found["dri"].append(summary)
        if (project.get("support_email") or "").lower() == wanted:
            found["support"].append(summary)
        for phase in project.get("phases", []):
            if (phase.get("owner_email") or "").lower() == wanted:
                found["phases"].append(
                    {**summary, "phase_id": phase["phase_id"], "phase_name": phase["name"]}
                )
    return found


def unassign_person(email: str) -> dict[str, Any]:
    """
    Blank every reference to one person, and report what was cleared.

    This is what makes deleting a person safe. Projects and phases store an email,
    not a foreign key, so removing the roster row on its own would leave a
    person-shaped string with nothing behind it - which is how the workbook ended up
    with "Liam -> AI Hire" sitting in a DRI cell.

    Field by field rather than row by row: a project where the same person is both
    DRI and Support needs both cleared, and a lane must not lose its other owner
    because one of the two was deleted.

    Returns the same shape as find_assignments, so a caller can log precisely what it
    removed rather than a count that cannot be checked afterwards.
    """
    found = find_assignments(email)

    for project in found["dri"]:
        update_project(project["project_id"], {"dri_email": None})
    for project in found["support"]:
        update_project(project["project_id"], {"support_email": None})
    for phase in found["phases"]:
        update_phase(phase["project_id"], phase["phase_id"], {"owner_email": None})

    return found
