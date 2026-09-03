"""
DynamoDB queries for the work table: RFCs and tasks.

Its own table, partitioned on item_id, with a GSI on `kind`. See the long note in
cdk/lib/dynamodb_stack.py for why these are not extra sort keys on the projects
table; the short version is that list_projects scans that table whole, and that
`project_id` is its partition key so "attached to no project" would need a fake
partition to live in.

THE THREE RULES THIS MODULE ENFORCES
------------------------------------
There is no Ticket entity. A ticket is a task with children, a subtask is a task
with a parent, and `parent_id` is the whole difference. That collapse is only safe
because the shape is constrained here rather than hoped for:

1. ONE LEVEL OF NESTING, checked in both directions - a task that has a parent
   cannot become one, and a task that has children cannot be given one. Cycles are
   then impossible by construction rather than by a reachability check that has to
   stay correct, and nothing rendering a board can recurse without bound.

2. NO SELF-PARENTING. Cheap, and the one cycle a single-level rule would otherwise
   still admit.

3. DELETING A PARENT PROMOTES ITS CHILDREN rather than cascading. Silently deleting
   work nobody asked to delete is the worse failure, and `dropped` already exists for
   "we decided against this".

A parent's status is deliberately NOT derived from its children - see app/work.py.
"""

import logging
import uuid
from typing import Any, Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from app import config
from app.db.models import WORK_SK, RfcModel, TaskModel
from app.db.queries._updates import ValidationError, apply_update
from app.db.queries._updates import iso as _iso
from app.work import Kind

logger = logging.getLogger(__name__)

dynamodb = boto3.resource("dynamodb", region_name=config.AWS_REGION)

# Fields a caller may change, per kind. Allowlists rather than "whatever is in the
# dict", same reasoning as PROJECT_UPDATABLE: these arrive from Pydantic models
# today, but an unfiltered SET is one careless caller away from letting a raw request
# body overwrite item_id, kind or created_at.
#
# `kind` is absent from both on purpose. An RFC does not become a task; that is a
# different document with a different lifecycle, and allowing the flip would leave
# rows carrying fields their new kind has no meaning for.
RFC_UPDATABLE = {"title", "body", "status", "project_id", "owner_email", "decided_on"}
TASK_UPDATABLE = {
    "title",
    "body",
    "status",
    "project_id",
    "parent_id",
    "owner_email",
    "due",
    "task_order",
}


def get_work_table():
    """Get the work table."""
    return dynamodb.Table(config.WORK_TABLE_NAME)


def _new_id(prefix: str) -> str:
    """
    A short opaque id, prefixed with its kind.

    uuid4 rather than a slug of the title, for the reason projects._new_id gives: an
    RFC gets retitled and an id derived from a name either goes stale or forces a
    rewrite of every reference to it.

    The prefix is not parsed by anything and must not be - `kind` is the field that
    answers what a row is. It is there so that an id in a log line, a URL or an audit
    entry is self-describing, which matters more here than on the roadmap because two
    kinds share one table and one id space.
    """
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _key(item_id: str) -> dict[str, Any]:
    return {"item_id": item_id, "sk": WORK_SK}


# ------------------------------------------------------------------------ reads
def _get_raw(item_id: str) -> Optional[dict[str, Any]]:
    """The stored item, whatever kind it is, or None."""
    try:
        response = get_work_table().get_item(Key=_key(item_id))
    except ClientError as e:
        logger.error("Error getting work item %s: %s", item_id, e)
        raise
    return response.get("Item")


def _list_kind(kind: str) -> list[dict[str, Any]]:
    """
    Every row of one kind, newest-touched first.

    A Query on the kind GSI, not a Scan - which is the whole reason the index exists.
    The RFC list must not pay to read every task, and vice versa.

    ScanIndexForward=False gives "most recently updated first" out of the key schema
    rather than an in-memory sort, because updated_at is the index's sort key.
    Pagination is followed to the end for the reason get_project gives: a truncated
    read renders a board that is silently missing rows and looks entirely plausible.
    """
    table = get_work_table()
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {
        "IndexName": config.WORK_BY_KIND_INDEX,
        "KeyConditionExpression": Key("kind").eq(kind),
        "ScanIndexForward": False,
    }

    try:
        while True:
            response = table.query(**kwargs)
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                break
            kwargs["ExclusiveStartKey"] = last_key
    except ClientError as e:
        logger.error("Error listing %s: %s", kind, e)
        raise

    return items


def get_rfc(item_id: str) -> Optional[dict[str, Any]]:
    """One RFC, or None if there is no such row or it is a task."""
    item = _get_raw(item_id)
    if item is None or item.get("kind") != Kind.RFC.value:
        return None
    return RfcModel.from_item(item)


def get_task(item_id: str) -> Optional[dict[str, Any]]:
    """One task, or None if there is no such row or it is an RFC."""
    item = _get_raw(item_id)
    if item is None or item.get("kind") != Kind.TASK.value:
        return None
    return TaskModel.from_item(item)


def list_rfcs(project_id: Optional[str] = None) -> list[dict[str, Any]]:
    """
    Every RFC, newest-touched first, optionally only those on one project.

    The project filter is applied in memory rather than by a second GSI. That is the
    same call list_projects already makes and it is right at the same scale; the
    index earns its keep when one kind stops fitting in a page or two, not before.
    """
    rows = [RfcModel.from_item(i) for i in _list_kind(Kind.RFC.value)]
    if project_id is not None:
        rows = [r for r in rows if r["project_id"] == project_id]
    return rows


def list_tasks(
    project_id: Optional[str] = None,
    parent_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Every task, newest-touched first, optionally filtered.

    `parent_id=None` does NOT mean "top-level only" - it means "do not filter", the
    same absent-versus-null distinction the rest of the backend runs on. Ask for the
    top level with top_level_tasks(); there is no way to spell it here without the
    argument meaning two different things.
    """
    rows = [TaskModel.from_item(i) for i in _list_kind(Kind.TASK.value)]
    if project_id is not None:
        rows = [r for r in rows if r["project_id"] == project_id]
    if parent_id is not None:
        rows = [r for r in rows if r["parent_id"] == parent_id]
    return rows


def top_level_tasks() -> list[dict[str, Any]]:
    """Tasks with no parent - what the backlog board shows as its rows."""
    return [r for r in list_tasks() if r["parent_id"] is None]


def children_of(item_id: str) -> list[dict[str, Any]]:
    """
    The subtasks of one task, in board order.

    Reads every task and filters, which is honest about what it costs: there is no
    index on parent_id. It is called on the write path only when parent_id is
    actually changing, and on delete - not on every page render - so at a few hundred
    rows this is cheaper than the GSI it would otherwise need.
    """
    rows = [r for r in list_tasks() if r["parent_id"] == item_id]
    rows.sort(key=lambda t: (t["task_order"], t["title"] or ""))
    return rows


# ----------------------------------------------------------------- nesting rules
def _check_parent(item_id: Optional[str], parent_id: Optional[str]) -> None:
    """
    Refuse any parent link that would break the one-level rule.

    `item_id` is None when the task does not exist yet, which is the create path: a
    brand-new task cannot have children, so only the parent-side half applies.

    Every branch raises rather than silently correcting. A write that quietly stores
    something other than what was asked for is how a board ends up disagreeing with
    the form that filled it in.
    """
    if parent_id is None:
        return

    if item_id is not None and parent_id == item_id:
        raise ValidationError("a task cannot be its own parent")

    parent = _get_raw(parent_id)
    if parent is None or parent.get("kind") != Kind.TASK.value:
        raise ValidationError("no such parent task")

    # Half one: the proposed parent must itself be top-level.
    if parent.get("parent_id"):
        raise ValidationError(
            "tasks nest one level deep, and that parent is already a subtask"
        )

    # Half two: this task must not already be a parent. Without this the rule holds
    # going down and not going up - A could adopt B while B still had children of its
    # own, giving exactly the three-deep tree the cap exists to prevent.
    if item_id is not None and children_of(item_id):
        raise ValidationError(
            "tasks nest one level deep, and this task has subtasks of its own"
        )


# ----------------------------------------------------------------------- writes
def create_rfc(rfc: dict[str, Any]) -> dict[str, Any]:
    """Write a new RFC. `project_id` may be None, and usually is."""
    item_id = _new_id("rfc")
    item = RfcModel.create_item(
        item_id=item_id,
        title=rfc["title"],
        body=rfc.get("body") or "",
        status=rfc["status"],
        project_id=rfc.get("project_id"),
        owner_email=rfc.get("owner_email"),
        decided_on=_iso(rfc.get("decided_on")),
        created_by=rfc.get("created_by"),
    )
    try:
        get_work_table().put_item(Item=item)
    except ClientError as e:
        logger.error("Error creating RFC: %s", e)
        raise
    return RfcModel.from_item(item)


def create_task(task: dict[str, Any]) -> dict[str, Any]:
    """Write a new task. Refuses a parent that is itself a subtask."""
    _check_parent(None, task.get("parent_id"))

    item_id = _new_id("tsk")
    item = TaskModel.create_item(
        item_id=item_id,
        title=task["title"],
        body=task.get("body") or "",
        status=task["status"],
        project_id=task.get("project_id"),
        parent_id=task.get("parent_id"),
        owner_email=task.get("owner_email"),
        due=_iso(task.get("due")),
        task_order=task.get("task_order", 0),
        created_by=task.get("created_by"),
    )
    try:
        get_work_table().put_item(Item=item)
    except ClientError as e:
        logger.error("Error creating task: %s", e)
        raise
    return TaskModel.from_item(item)


def update_rfc(item_id: str, changes: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Update an RFC. `changes` holds only fields the caller actually sent."""
    if not changes:
        return get_rfc(item_id)
    if get_rfc(item_id) is None:
        return None

    try:
        item = apply_update(
            get_work_table(), _key(item_id), changes, RFC_UPDATABLE, "item_id"
        )
    except ValidationError as e:
        if str(e) == "no such record":
            return None
        raise
    return RfcModel.from_item(item)


def update_task(item_id: str, changes: dict[str, Any]) -> Optional[dict[str, Any]]:
    """
    Update a task. `changes` holds only fields the caller actually sent.

    The parent check runs only when parent_id is among them, because `absent` and
    `null` differ here as they do everywhere: not mentioning parent_id leaves the
    existing link alone, while sending it as null promotes the task to top-level -
    which is always allowed and needs no check.
    """
    if not changes:
        return get_task(item_id)
    if get_task(item_id) is None:
        return None

    if "parent_id" in changes:
        _check_parent(item_id, changes["parent_id"])

    try:
        item = apply_update(
            get_work_table(), _key(item_id), changes, TASK_UPDATABLE, "item_id"
        )
    except ValidationError as e:
        if str(e) == "no such record":
            return None
        raise
    return TaskModel.from_item(item)


def delete_rfc(item_id: str) -> bool:
    """
    Hard-delete an RFC.

    Hard rather than the soft delete a project gets, because `withdrawn` already
    exists and is the honest way to retire a proposal while keeping its reasoning
    readable. Reaching for delete means the row was created by mistake, and a
    mistake should not linger as a tombstone. The audit trail keeps the record.
    """
    if get_rfc(item_id) is None:
        return False
    try:
        get_work_table().delete_item(Key=_key(item_id))
    except ClientError as e:
        logger.error("Error deleting RFC %s: %s", item_id, e)
        raise
    return True


def delete_task(item_id: str) -> bool:
    """
    Hard-delete a task, promoting any subtasks to top-level first.

    NOT a cascade. Deleting a ticket is usually "this was raised in the wrong place",
    not "everything under it is void", and silently destroying work nobody asked to
    destroy is the worse of the two failures. `dropped` is the status for deciding
    against something and it keeps the record.

    Promotion happens BEFORE the parent row goes, and the order is the point. The
    other way round, a failure between the two steps leaves children pointing at an
    id that no longer resolves - they would vanish from any board that groups by
    parent, with nothing on screen to say why. This way the same failure leaves the
    parent present and some children promoted: visibly odd, and recoverable.
    """
    if get_task(item_id) is None:
        return False

    table = get_work_table()
    for child in children_of(item_id):
        try:
            apply_update(
                table, _key(child["item_id"]), {"parent_id": None},
                TASK_UPDATABLE, "item_id",
            )
        except ValidationError:
            # The child went away underneath us. Nothing to promote, nothing to fix.
            logger.warning("Subtask %s vanished while promoting", child["item_id"])

    try:
        table.delete_item(Key=_key(item_id))
    except ClientError as e:
        logger.error("Error deleting task %s: %s", item_id, e)
        raise
    return True
