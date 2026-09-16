"""Project and phase CRUD.

Every route depends on require_planning_group, which both authorises the caller and
yields their email. That is one dependency rather than two on purpose: a route that
took the identity separately could authenticate and forget to authorise, and the
signature would look complete either way.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from app.auth import require_planning_group
from app.db.models import AuditLogModel
from app.db.queries import audit, projects as q
from app.schemas.projects import (
    AuditOut,
    MilestoneCreate,
    MilestoneOut,
    MilestoneUpdate,
    PhaseCreate,
    PhaseOut,
    PhaseUpdate,
    ProjectCreate,
    ProjectDetail,
    ProjectOut,
    ProjectUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _load_project_or_404(project_id: str) -> dict[str, Any]:
    project = q.get_project(project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such project.")
    return project


def _project_fields(project: dict[str, Any]) -> dict[str, Any]:
    """
    The project's own fields, without its children.

    An audit row for "renamed the project" should not carry a copy of every phase
    and milestone: the children did not change, they bloat the entry, and a later
    diff of before/after would have to know to ignore them. Each child has its own
    audit trail keyed on its own id.
    """
    return {k: v for k, v in project.items() if k not in ("phases", "milestones")}


@router.get("", response_model=list[ProjectDetail])
async def list_projects(
    include_inactive: bool = False,
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """Every project with its phases, in lane order."""
    return q.list_projects(include_inactive=include_inactive)


@router.get("/{project_id}", response_model=ProjectDetail)
async def get_project(
    project_id: str,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """One project with its phases."""
    return _load_project_or_404(project_id)


@router.post("", response_model=ProjectDetail, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Create a project, optionally with its phases and milestones.

    The 400 here is for a milestone that names a phase: nothing in this request has
    a phase id yet, so there is no attachment that could be meant. See
    q.create_project.
    """
    try:
        created = q.create_project(
            name=body.name,
            lane_order=body.lane_order,
            dri_email=body.dri_email,
            support_email=body.support_email,
            active=body.active,
            category=body.category,
            phases=[p.model_dump() for p in body.phases],
            milestones=[m.model_dump() for m in body.milestones],
        )
    except q.ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    audit.record(
        action="create",
        entity=AuditLogModel.ENTITY_PROJECT,
        entity_id=created["project_id"],
        after=created,
        user_email=user_email,
    )
    return created


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: str,
    body: ProjectUpdate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Partially update a project.

    The before-snapshot is read first so the audit row records what actually
    changed. Reading it after the write would record the new value twice, which is
    an audit trail that answers "what is it now" - a question the record itself
    already answers - instead of "what did this person do".
    """
    before = _load_project_or_404(project_id)

    try:
        updated = q.update_project(project_id, body.changes())
    except q.ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such project.")

    audit.record(
        action="update",
        entity=AuditLogModel.ENTITY_PROJECT,
        entity_id=project_id,
        before=_project_fields(before),
        after=updated,
        user_email=user_email,
    )
    return updated


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    user_email: str = Depends(require_planning_group),
) -> None:
    """Soft-delete a project: it becomes inactive and drops out of the roadmap."""
    before = _load_project_or_404(project_id)

    if not q.delete_project(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such project.")

    audit.record(
        action="delete",
        entity=AuditLogModel.ENTITY_PROJECT,
        entity_id=project_id,
        before=_project_fields(before),
        user_email=user_email,
    )


# ----------------------------------------------------------------------- phases
@router.post(
    "/{project_id}/phases",
    response_model=PhaseOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_phase(
    project_id: str,
    body: PhaseCreate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Add a phase to a project.

    The project is loaded first purely to establish it exists. DynamoDB would
    happily accept a phase under an unknown project_id - there are no foreign keys -
    and the result would be a phase that no screen ever renders, because
    list_projects groups by the project rows it found.
    """
    _load_project_or_404(project_id)

    created = q.create_phase(project_id, body.model_dump())
    audit.record(
        action="create",
        entity=AuditLogModel.ENTITY_PHASE,
        entity_id=created["phase_id"],
        after=created,
        user_email=user_email,
    )
    return created


@router.patch("/{project_id}/phases/{phase_id}", response_model=PhaseOut)
async def update_phase(
    project_id: str,
    phase_id: str,
    body: PhaseUpdate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Partially update a phase.

    Sending `"start": null` clears the date and puts the phase back to unscheduled.
    Omitting `start` leaves it untouched. The two are different requests and mean
    different things - see the module docstring in schemas/projects.py.
    """
    before = q.get_phase(project_id, phase_id)
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such phase.")

    try:
        updated = q.update_phase(project_id, phase_id, body.changes())
    except q.ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such phase.")

    audit.record(
        action="update",
        entity=AuditLogModel.ENTITY_PHASE,
        entity_id=phase_id,
        before=before,
        after=updated,
        user_email=user_email,
    )
    return updated


@router.delete(
    "/{project_id}/phases/{phase_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_phase(
    project_id: str,
    phase_id: str,
    user_email: str = Depends(require_planning_group),
) -> None:
    """
    Remove a phase. The audit row keeps the full before-snapshot.

    Any milestones filed under it are detached, not deleted - see
    q.detach_phase_milestones for why - and each one gets its own audit row. They are
    real edits to real rows, and folding them into the phase's delete entry would
    make "why is this milestone no longer under Infra" answerable only by someone who
    already knew to look at a different entity's history.
    """
    before = q.get_phase(project_id, phase_id)
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such phase.")

    # Snapshotted BEFORE the delete, because afterwards the attachment is gone and
    # there is nothing left to say what these used to belong to.
    project = q.get_project(project_id) or {}
    attached = [
        milestone
        for milestone in project.get("milestones", [])
        if milestone.get("phase_id") == phase_id
    ]

    q.delete_phase(project_id, phase_id)
    audit.record(
        action="delete",
        entity=AuditLogModel.ENTITY_PHASE,
        entity_id=phase_id,
        before=before,
        user_email=user_email,
    )
    for milestone in attached:
        audit.record(
            action="update",
            entity=AuditLogModel.ENTITY_MILESTONE,
            entity_id=milestone["milestone_id"],
            before=milestone,
            after={**milestone, "phase_id": None},
            user_email=user_email,
        )


# ------------------------------------------------------------------- milestones
@router.post(
    "/{project_id}/milestones",
    response_model=MilestoneOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_milestone(
    project_id: str,
    body: MilestoneCreate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Add a milestone to a project.

    Same reason as create_phase for loading the project first: there are no foreign
    keys, so an unknown project_id would produce a milestone that is stored, costs
    money and is never rendered by anything. `phase_id` is the same argument one
    level down and gets the same treatment - checked against this project's phases,
    400 if it names none of them. Omit it, or send null, for a milestone that belongs
    to the lane as a whole; that is the ordinary case, not the fallback.
    """
    _load_project_or_404(project_id)

    try:
        created = q.create_milestone(project_id, body.model_dump())
    except q.ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    audit.record(
        action="create",
        entity=AuditLogModel.ENTITY_MILESTONE,
        entity_id=created["milestone_id"],
        after=created,
        user_email=user_email,
    )
    return created


@router.patch(
    "/{project_id}/milestones/{milestone_id}", response_model=MilestoneOut
)
async def update_milestone(
    project_id: str,
    milestone_id: str,
    body: MilestoneUpdate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Partially update a milestone.

    `"date": null` un-commits the milestone - it is still needed, the date is not
    agreed - and is a different request from omitting `date`, which leaves it alone.
    Marking `done` is likewise independent of the date: a milestone can be finished
    early, or be a month past due and still open, and both need saying.
    """
    before = q.get_milestone(project_id, milestone_id)
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such milestone.")

    try:
        updated = q.update_milestone(project_id, milestone_id, body.changes())
    except q.ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such milestone.")

    audit.record(
        action="update",
        entity=AuditLogModel.ENTITY_MILESTONE,
        entity_id=milestone_id,
        before=before,
        after=updated,
        user_email=user_email,
    )
    return updated


@router.delete(
    "/{project_id}/milestones/{milestone_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_milestone(
    project_id: str,
    milestone_id: str,
    user_email: str = Depends(require_planning_group),
) -> None:
    """Remove a milestone. The audit row keeps the full before-snapshot."""
    before = q.get_milestone(project_id, milestone_id)
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such milestone.")

    q.delete_milestone(project_id, milestone_id)
    audit.record(
        action="delete",
        entity=AuditLogModel.ENTITY_MILESTONE,
        entity_id=milestone_id,
        before=before,
        user_email=user_email,
    )


# ------------------------------------------------------------------------ audit
@router.get("/{project_id}/history", response_model=list[AuditOut])
async def project_history(
    project_id: str,
    limit: int = 100,
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """
    Every recorded change to this project, newest first.

    Phase edits are keyed on the phase id, not the project id, so this returns
    project-level changes only. That is the honest scope for a single-partition
    query; a combined view means one query per phase and belongs on a screen that
    has asked for it.
    """
    return audit.history(project_id, limit=limit)
