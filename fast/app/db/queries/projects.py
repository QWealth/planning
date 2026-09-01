"""DynamoDB queries for projects and phases.

Both live in one table partitioned on project_id, so reading a project and all of
its phases is a single Query rather than a fan-out. See PROJECT_SK in db/models.py
for why the project row sorts first.
"""

import logging
import uuid
from datetime import date, datetime
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
    to_decimal,
)

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
MILESTONE_UPDATABLE = {"name", "date", "note", "done"}


def _sort_milestones(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    By date, with undated ones last.

    Undated milestones sort to the end rather than the start: an empty date is not
    "the beginning of time", it is "not decided", and floating those to the top of
    every lane would put the least settled thing first on the chart.
    """
    rows.sort(key=lambda m: (m["date"] is None, m["date"] or "", m["name"] or ""))
    return rows


class ValidationError(Exception):
    """A write the data model refuses. Routes turn this into a 400."""


def get_projects_table():
    """Get the projects table."""
    return dynamodb.Table(config.PROJECTS_TABLE_NAME)


def _iso(value: Any) -> Any:
    """Dates go to DynamoDB as ISO strings; everything else passes through."""
    if isinstance(value, date) and not isinstance(value, datetime):
        return value.isoformat()
    return value


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
    SET every field in `changes`, including the ones whose value is None.

    This is the counterpart to UNSET in db/models.py, and the difference from the
    marketing tool's update_rule is the point of the function. That one skips a
    field whose value is None, treating None as "not supplied". Here the caller has
    already separated the two - `changes` holds only fields the request actually
    mentioned - so a None that reaches this point is an explicit instruction to
    store null. Clearing a phase's dates is how you say "this slipped and has not
    been re-planned", and it has to be expressible.

    Every attribute goes through a #name alias. "name" and "end" are both DynamoDB
    reserved words, and rather than special-case them, aliasing everything means a
    field added later cannot reintroduce the problem.
    """
    unknown = set(changes) - allowed
    if unknown:
        raise ValidationError(f"cannot update: {', '.join(sorted(unknown))}")

    parts = ["#updated_at = :updated_at"]
    names = {"#updated_at": "updated_at"}
    values: dict[str, Any] = {":updated_at": datetime.utcnow().isoformat()}

    for field, value in changes.items():
        parts.append(f"#{field} = :{field}")
        names[f"#{field}"] = field
        values[f":{field}"] = to_decimal(_iso(value))

    try:
        response = get_projects_table().update_item(
            Key=key,
            UpdateExpression="SET " + ", ".join(parts),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            # Refuse to resurrect a deleted row as a stub. Without this, updating a
            # phase that another user has just removed silently recreates it holding
            # only the fields in this request - a phase with no name and no dates,
            # which then renders as a blank band nobody can account for.
            ConditionExpression="attribute_exists(project_id)",
            ReturnValues="ALL_NEW",
        )
        return response.get("Attributes", {})
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ValidationError("no such record") from e
        logger.error("Error updating %s: %s", key, e)
        raise


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


def create_milestone(project_id: str, milestone: dict[str, Any]) -> dict[str, Any]:
    """Add a milestone to an existing project."""
    item = MilestoneModel.create_item(
        project_id=project_id,
        milestone_id=_new_id(),
        name=milestone["name"],
        date=_iso(milestone.get("date")),
        note=milestone.get("note"),
        done=milestone.get("done", False),
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
    Update a milestone.

    No cross-field rule to enforce here - a milestone is one date, so there is no
    ordering to get wrong. Clearing the date back to null is a legitimate edit
    meaning "this is still needed but the commitment has gone", and _apply_update
    stores that rather than skipping it.
    """
    if not changes:
        return get_milestone(project_id, milestone_id)

    if get_milestone(project_id, milestone_id) is None:
        return None

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


def delete_phase(project_id: str, phase_id: str) -> bool:
    """
    Hard-delete a phase.

    Unlike a project, a phase is a row on a chart with no children to orphan, and
    "we are not doing that stage" is an ordinary edit rather than a decommissioning.
    The audit entry carries the full before-snapshot, so the content is recoverable
    from the history even though the row is not.
    """
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
