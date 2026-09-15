"""
RFC and task CRUD.

TWO ROUTERS, ONE TABLE
----------------------
/api/rfcs and /api/tasks are separate prefixes over the same DynamoDB table, for the
same reason schemas/work.py has separate models: the two kinds share every access
pattern and no field list. A single /api/work with a `kind` query parameter would
have to accept `parent_id` on an RFC and `decided_on` on a task, and would push the
"which fields are legal here" question out of FastAPI and into a hand-written check
that the generated OpenAPI schema could not describe.

Same auth as projects: every route depends on require_planning_group, which both
authorises the caller and yields their email in one dependency. Tasks are shared -
everyone in the group sees and edits everything, and `owner_email` is a nullable
label rather than a permission. That was a deliberate choice; per-owner write
restrictions would need a rule for the unowned majority, and "whoever picks it up
fixes it" is how this team already works.

THE STATUS CATALOGUES ARE SERVED, NOT HARDCODED IN THE CLIENT
-------------------------------------------------------------
/api/rfcs/statuses and /api/tasks/statuses hand back the vocabulary from app/work.py
with its labels and descriptions. The frontend renders whatever it is given, so a
sixth status is a backend deploy rather than two deploys that have to land in order.
Both routes are declared BEFORE /{item_id}: FastAPI matches in declaration order, and
the other way round "statuses" is swallowed as an item id and 404s.
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app import work as vocab
from app.auth import is_admin, require_planning_group
from app.db.models import AuditLogModel
from app.db.queries import audit, people as people_q, work as q
from app.schemas.projects import AuditOut
from app.schemas.work import (
    CommentCreate,
    CommentOut,
    CommentUpdate,
    RfcCreate,
    RfcOut,
    RfcUpdate,
    StatusOut,
    TaskCreate,
    TaskOut,
    TaskUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/rfcs", tags=["rfcs"])
tasks_router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def _rfc_or_404(item_id: str) -> dict[str, Any]:
    rfc = q.get_rfc(item_id)
    if rfc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such RFC.")
    return rfc


def _task_or_404(item_id: str) -> dict[str, Any]:
    task = q.get_task(item_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such task.")
    return task


# -------------------------------------------------------------------------- rfcs
@router.get("/statuses", response_model=list[StatusOut])
async def rfc_statuses(
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """The RFC status vocabulary, in lifecycle order, with labels for the UI."""
    return vocab.rfc_catalogue()


@router.get("", response_model=list[RfcOut])
async def list_rfcs(
    project_id: Optional[str] = None,
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """
    Every RFC, most recently updated first.

    `project_id` filters to one project. There is deliberately no way to ask for
    "the unattached ones" through this parameter - an empty string would have to
    mean null, and a query parameter that means null when it is blank is exactly the
    absent/null confusion the rest of this codebase spends its docstrings avoiding.
    The list is small; the client filters on project_id itself.
    """
    return q.list_rfcs(project_id=project_id)


@router.get("/{item_id}", response_model=RfcOut)
async def get_rfc(
    item_id: str,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """One RFC, body included."""
    return _rfc_or_404(item_id)


@router.post("", response_model=RfcOut, status_code=status.HTTP_201_CREATED)
async def create_rfc(
    body: RfcCreate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Write a new RFC. `project_id` may be omitted, and usually is.

    `created_by` comes from the token, never from the request body. It is the one
    field on the row that answers "who wrote this", and a client-supplied value
    would let it say anything.
    """
    payload = body.model_dump()
    payload["created_by"] = user_email

    created = q.create_rfc(payload)
    audit.record(
        action="create",
        entity=AuditLogModel.ENTITY_RFC,
        entity_id=created["item_id"],
        after=created,
        user_email=user_email,
    )
    return created


@router.patch("/{item_id}", response_model=RfcOut)
async def update_rfc(
    item_id: str,
    body: RfcUpdate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Partially update an RFC.

    Sending `"project_id": null` detaches the RFC from its project and is the whole
    point of the feature; omitting project_id leaves the attachment alone. Same for
    `decided_on`, where null is "we have un-decided this" rather than "no change".
    The before-snapshot is read first so the audit row records what changed rather
    than recording the new value twice.
    """
    before = _rfc_or_404(item_id)

    try:
        updated = q.update_rfc(item_id, body.changes())
    except q.ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such RFC.")

    audit.record(
        action="update",
        entity=AuditLogModel.ENTITY_RFC,
        entity_id=item_id,
        before=before,
        after=updated,
        user_email=user_email,
    )
    return updated


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rfc(
    item_id: str,
    user_email: str = Depends(require_planning_group),
) -> None:
    """
    Remove an RFC outright.

    Hard, unlike a project's soft delete, because `withdrawn` already exists for
    retiring a proposal while keeping its reasoning readable. Deleting means the row
    was a mistake. The audit row keeps the full before-snapshot, body included, so
    the text is recoverable.
    """
    before = _rfc_or_404(item_id)

    if not q.delete_rfc(item_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such RFC.")

    audit.record(
        action="delete",
        entity=AuditLogModel.ENTITY_RFC,
        entity_id=item_id,
        before=before,
        user_email=user_email,
    )


@router.get("/{item_id}/history", response_model=list[AuditOut])
async def rfc_history(
    item_id: str,
    limit: int = 100,
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """Every recorded change to this RFC, newest first."""
    return audit.history(item_id, limit=limit)


@router.post("/{item_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_rfc_read(
    item_id: str,
    user_email: str = Depends(require_planning_group),
) -> None:
    """
    Note that the caller has opened this RFC, so the list can stop highlighting it.

    NOT AUDITED, unlike every other write in this file. The audit trail answers "what
    did somebody change and why", and reading is neither - recording it would add a row
    per person per RFC per visit, burying the handful of entries that describe actual
    decisions under thousands that describe attention.

    A person with no roster row is a real state rather than an error: being in the
    planning group is what grants access, and the roster is a separate list somebody
    fills in later. They simply have nowhere to store the mark, so everything stays
    highlighted for them - which is honest, and fixes itself the moment they are added.
    """
    _rfc_or_404(item_id)
    people_q.mark_rfc_read(user_email, item_id)


# ---------------------------------------------------------------------- comments
#
# Comments live under /api/rfcs/{id}/comments rather than a top-level /api/comments.
# A comment is meaningless without the thing it is about, and the nested path makes
# the item id impossible to omit - a flat route would take it in the body, where a
# caller can forget it and orphan the row.
#
# WHO MAY DO WHAT
# ---------------
# Anyone in the planning group may read the thread and add to it. That is the whole
# point of a status called "Open for comment": restricting who may reply would leave
# the proposal being reviewed by whoever happens to hold a role, which is the opposite
# of what it is asking for.
#
# Editing is the author alone, admin included - see _own_comment_or_403. An admin
# rewriting somebody else's words is not moderation, it is forgery, and there is no
# version of this app that needs it. Deleting IS allowed for an admin, because taking
# something down is a different act from changing what it says: the text is gone and
# the audit row records who removed it, rather than a remark silently becoming one
# nobody made.


def _normalise(address: Optional[str]) -> str:
    """
    Lowercased, trimmed address for comparison only.

    require_planning_group hands back the raw Cognito claim, which preserves whatever
    case the account was created with. Comparing that to a stored address directly
    means an author can fail to match their own comment, so every comparison in this
    section goes through here.
    """
    return (address or "").strip().lower()


def _comment_or_404(item_id: str, comment_id: str) -> dict[str, Any]:
    comment = q.get_comment(item_id, comment_id)
    if comment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such comment.")
    return comment


def _own_comment_or_403(comment: dict[str, Any], user_email: str) -> None:
    """Refuse unless the caller wrote it. Deliberately has no admin override."""
    if _normalise(comment.get("author_email")) != _normalise(user_email):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the author can edit a comment."
        )


@router.get("/{item_id}/comments", response_model=list[CommentOut])
async def list_rfc_comments(
    item_id: str,
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """The thread on one RFC, oldest first. 404s if the RFC is not there."""
    _rfc_or_404(item_id)
    return q.list_comments(item_id)


@router.post(
    "/{item_id}/comments",
    response_model=CommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_rfc_comment(
    item_id: str,
    body: CommentCreate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Add a comment to an RFC.

    The author is taken from the token and is not in the request body. A client that
    could name the author is a client that can post as somebody else, and no amount of
    validation downstream recovers from that.
    """
    _rfc_or_404(item_id)

    comment = q.create_comment(
        item_id=item_id,
        author_email=_normalise(user_email),
        body=body.body,
    )

    audit.record(
        action="create",
        entity=AuditLogModel.ENTITY_COMMENT,
        entity_id=comment["comment_id"],
        after=comment,
        user_email=user_email,
    )
    return comment


@router.patch("/{item_id}/comments/{comment_id}", response_model=CommentOut)
async def update_rfc_comment(
    item_id: str,
    comment_id: str,
    body: CommentUpdate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """Change the text of your own comment. Nobody else's, at any permission level."""
    _rfc_or_404(item_id)
    before = _comment_or_404(item_id, comment_id)
    _own_comment_or_403(before, user_email)

    updated = q.update_comment(item_id, comment_id, body.body)
    if updated is None:
        # Deleted between the permission check and the write.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such comment.")

    audit.record(
        action="update",
        entity=AuditLogModel.ENTITY_COMMENT,
        entity_id=comment_id,
        before=before,
        after=updated,
        user_email=user_email,
    )
    return updated


@router.delete(
    "/{item_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_rfc_comment(
    item_id: str,
    comment_id: str,
    request: Request,
    user_email: str = Depends(require_planning_group),
) -> None:
    """
    Remove a comment. The author may remove their own; an admin may remove any.

    The before-snapshot in the audit row is the only surviving copy of the text, since
    the row itself is hard-deleted. See AuditLogModel.ENTITY_COMMENT.
    """
    _rfc_or_404(item_id)
    before = _comment_or_404(item_id, comment_id)

    if not is_admin(request) and _normalise(before.get("author_email")) != _normalise(
        user_email
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the author or an admin can delete a comment."
        )

    if not q.delete_comment(item_id, comment_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such comment.")

    audit.record(
        action="delete",
        entity=AuditLogModel.ENTITY_COMMENT,
        entity_id=comment_id,
        before=before,
        user_email=user_email,
    )


# ------------------------------------------------------------------------- tasks
@tasks_router.get("/statuses", response_model=list[StatusOut])
async def task_statuses(
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """The task status vocabulary, in board order, with labels for the UI."""
    return vocab.task_catalogue()


@tasks_router.get("", response_model=list[TaskOut])
async def list_tasks(
    project_id: Optional[str] = None,
    parent_id: Optional[str] = None,
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """
    Every task, flat, most recently updated first.

    FLAT is the contract - see TaskOut. The board asks for everything once and groups
    by parent_id on the client, which is only trivial because nesting is capped at
    one level. Returning children nested would ship each subtask twice and give the
    two copies a chance to disagree.

    `parent_id` filters to one ticket's subtasks. As with RFCs there is no way to
    spell "the ones with no parent" here; that is what the board's grouping is for.
    """
    return q.list_tasks(project_id=project_id, parent_id=parent_id)


@tasks_router.get("/{item_id}", response_model=TaskOut)
async def get_task(
    item_id: str,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """One task. Subtasks are fetched with ?parent_id=, not nested in here."""
    return _task_or_404(item_id)


@tasks_router.post("", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def create_task(
    body: TaskCreate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Create a task. Passing `parent_id` makes it a subtask of that ticket.

    A parent that is itself a subtask is refused with a 400, not silently flattened:
    the caller asked for a three-deep tree and needs to be told it does not exist
    here, rather than finding its task attached somewhere it did not choose.
    """
    payload = body.model_dump()
    payload["created_by"] = user_email

    try:
        created = q.create_task(payload)
    except q.ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    audit.record(
        action="create",
        entity=AuditLogModel.ENTITY_TASK,
        entity_id=created["item_id"],
        after=created,
        user_email=user_email,
    )
    return created


@tasks_router.patch("/{item_id}", response_model=TaskOut)
async def update_task(
    item_id: str,
    body: TaskUpdate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Partially update a task.

    `"parent_id": null` promotes a subtask to the top of the backlog; omitting
    parent_id leaves it where it is. That distinction is load-bearing here more than
    anywhere else in the API - get it wrong and renaming a subtask rips it out of its
    ticket. See the module docstring in schemas/work.py.

    Re-parenting can fail the one-level rule from either side, and both come back as
    400 with the reason spelled out.
    """
    before = _task_or_404(item_id)

    try:
        updated = q.update_task(item_id, body.changes())
    except q.ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such task.")

    audit.record(
        action="update",
        entity=AuditLogModel.ENTITY_TASK,
        entity_id=item_id,
        before=before,
        after=updated,
        user_email=user_email,
    )
    return updated


@tasks_router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(
    item_id: str,
    user_email: str = Depends(require_planning_group),
) -> None:
    """
    Remove a task. Its subtasks are PROMOTED to top-level, not deleted with it.

    Deleting a ticket usually means "this was raised in the wrong place", not
    "everything under it is void", so the children survive and land in the backlog
    where somebody will see them. `dropped` is the status for deciding against work.
    The audit row records the deleted parent; each promoted child gets its own.
    """
    before = _task_or_404(item_id)
    orphans = q.children_of(item_id)

    if not q.delete_task(item_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such task.")

    audit.record(
        action="delete",
        entity=AuditLogModel.ENTITY_TASK,
        entity_id=item_id,
        before=before,
        user_email=user_email,
    )

    # Promotion is a real edit to each child and is recorded as one. Without these
    # rows a subtask appears at the top of the backlog with nothing in its history
    # to explain how it got there, and the only trace is a delete entry on an id
    # that no longer resolves to anything.
    for child in orphans:
        audit.record(
            action="update",
            entity=AuditLogModel.ENTITY_TASK,
            entity_id=child["item_id"],
            before=child,
            after={**child, "parent_id": None},
            user_email=user_email,
        )


@tasks_router.get("/{item_id}/history", response_model=list[AuditOut])
async def task_history(
    item_id: str,
    limit: int = 100,
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """Every recorded change to this task, newest first."""
    return audit.history(item_id, limit=limit)
