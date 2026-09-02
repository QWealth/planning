"""Roster CRUD and the workload view."""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app import cognito, invites
from app.auth import is_admin, require_admin, require_planning_group, same_person
from app.db.models import AuditLogModel
from app.db.queries import audit, people as q, projects as project_q
from app.roles import catalogue as role_catalogue
from app.schemas.people import (
    InviteIn,
    InviteOut,
    PersonCreate,
    PersonDeleted,
    PersonOut,
    PersonUpdate,
    PersonWorkload,
    RoleOut,
    SkillOut,
)
from app.skills import catalogue

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/people", tags=["people"])

# Separate routers: these are vocabularies, not people, and hanging them off
# /api/people would collide with the /{email} route below.
skills_router = APIRouter(prefix="/api/skills", tags=["skills"])
roles_router = APIRouter(prefix="/api/roles", tags=["roles"])


@skills_router.get("", response_model=list[SkillOut])
async def list_skills(
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, str]]:
    """
    The specialisation vocabulary.

    Served rather than duplicated in the frontend so the two cannot drift. A skill
    added to app/skills.py appears in the picker on the next deploy with no matching
    TypeScript change - and, more to the point, a skill *renamed* in one place cannot
    silently stop matching the values already stored against people.
    """
    return catalogue()


@roles_router.get("", response_model=list[RoleOut])
async def list_roles(
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, str]]:
    """
    The role vocabulary: BA, UX, Software Engineer, QA, Data, Leadership.

    Served for the same reason as the skills above - one list, in one place, so the
    picker and the stored values cannot drift apart.

    Not to be confused with the DRI/Support role somebody holds on a project, which
    lives on the project and not on the person, nor with the Cognito `admin` group,
    which is the only thing here that grants anything. See app/roles.py.
    """
    return role_catalogue()


@router.get("", response_model=list[PersonOut])
async def list_people(
    include_inactive: bool = False,
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """Everyone on the roster, by name."""
    return q.list_people(include_inactive=include_inactive)


@router.get("/workload", response_model=list[PersonWorkload])
async def workload(
    user_email: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """
    Everyone, with what they own.

    Declared before /{email} deliberately. FastAPI matches routes in declaration
    order, so with the parameterised route first this would resolve as a person
    whose email is the literal string "workload" and answer 404 forever.

    The counts include structural (Maintenance) phases, because carrying the
    ongoing-support band for a project is real load even though it is not scheduled
    work - it is arguably the load people most often forget to count.
    """
    people = q.list_people(include_inactive=True)
    all_projects = project_q.list_projects(include_inactive=True)

    by_email: dict[str, dict[str, Any]] = {
        p["email"]: {**p, "dri_project_ids": [], "support_project_ids": [], "owned_phase_count": 0}
        for p in people
    }

    # Ownership recorded against somebody not on the roster is counted nowhere and
    # logged. Silently creating a person from a stray email would rebuild exactly the
    # workbook's free-text ownership, where a typo became a new team member.
    unknown: set[str] = set()

    def bump(email: str, field: str, value: Any) -> None:
        row = by_email.get(email)
        if row is None:
            unknown.add(email)
            return
        if field == "owned_phase_count":
            row[field] += 1
        else:
            row[field].append(value)

    for project in all_projects:
        if project["dri_email"]:
            bump(project["dri_email"], "dri_project_ids", project["project_id"])
        if project["support_email"]:
            bump(project["support_email"], "support_project_ids", project["project_id"])
        for phase in project["phases"]:
            if phase["owner_email"]:
                bump(phase["owner_email"], "owned_phase_count", None)

    if unknown:
        logger.warning(
            "Ownership references %d address(es) not on the roster: %s",
            len(unknown),
            ", ".join(sorted(unknown)),
        )

    return sorted(by_email.values(), key=lambda p: (p["name"] or "").lower())


@router.get("/{email}", response_model=PersonOut)
async def get_person(
    email: str,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """One person by email."""
    person = q.get_person(email)
    if person is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person.")
    return person


@router.post("", response_model=PersonOut, status_code=status.HTTP_201_CREATED)
async def create_person(
    request: Request,
    body: PersonCreate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Add someone to the roster - yourself, or anyone if you are an admin.

    This does not create a Cognito account and does not grant access. The roster is
    who work can be assigned to; the planning group is who may log in. They overlap
    but are not the same set - a contractor can own a phase without an account, and
    an admin can hold an account without owning anything.

    Self-service is the point: a new starter signs in and adds their own row and their
    own specialisations, rather than waiting on somebody with admin to type their name
    in. That is also why this is not admin-only - making it so would mean the roster
    is only ever as current as one person's inbox.
    """
    if not is_admin(request) and not same_person(body.email, user_email):
        # Named in the message. A non-admin who mistypes their own address gets a
        # refusal they can act on rather than a bare 403, and the address they are
        # allowed to use is one they already know.
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"You can only add yourself ({user_email}). Ask an admin to add others.",
        )

    try:
        created = q.create_person(
            email=body.email,
            name=body.name,
            # Both of the next two are Enum members, and boto3 will not serialise an
            # Enum - same reason PersonUpdate.changes() dumps with mode="json".
            roles=[r.value for r in body.roles],
            active=body.active,
            specialisations=[s.model_dump(mode="json") for s in body.specialisations],
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e

    audit.record(
        action="create",
        entity=AuditLogModel.ENTITY_PERSON,
        entity_id=created["email"],
        after=created,
        user_email=user_email,
    )
    return created


@router.post("/invite", response_model=InviteOut, status_code=status.HTTP_201_CREATED)
async def invite_person(
    body: InviteIn,
    user_email: str = Depends(require_admin),
) -> dict[str, Any]:
    """
    Give somebody a login for this app. Admin-only.

    Stricter than create_person directly above, which any planning member may call for
    themselves. The difference is what is being handed out: a roster row says who work
    can be assigned to and grants nothing, whereas this creates an account on a pool
    SHARED with the marketing compliance tool. An account made here is an account
    there. That is not a decision to leave to self-service.

    Deliberately not admin-only-by-obscurity: the refusal is a 403 from require_admin
    with a reason, so a non-admin who finds the button knows to ask rather than
    assuming the feature is broken.

    Does not create the roster row. See app/cognito.py for why, and identity.py for
    what the invited person meets on their first sign-in.

    Declared before /{email} out of habit rather than necessity - there is no POST
    /{email} for it to shadow today, but /workload's docstring records what happens
    when a literal path loses that race, and adding one later should not be a trap.
    """
    try:
        return invites.perform_invite(
            body.email, actor=user_email, slack_user_id=body.slack_user_id
        )
    except cognito.InviteError as e:
        # 502, not 500: the failure is downstream of this API, in a service it
        # depends on. The message is already admin-readable - see cognito._explain.
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e


@router.patch("/{email}", response_model=PersonOut)
async def update_person(
    request: Request,
    email: str,
    body: PersonUpdate,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Partially update a person: yourself, or anyone if you are an admin.

    `active` is admin-only even on your own record, and that is not fussiness. It is
    the same switch deactivate_person owns, reachable by another route - without this
    a deactivated person could PATCH themselves back on, and the admin-only
    deactivation would mean nothing at all.
    """
    admin = is_admin(request)
    if not admin and not same_person(email, user_email):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You can only edit your own entry. Ask an admin to change someone else's.",
        )

    # Absent is not the same as sent-unchanged here: `changes()` reports only what the
    # caller actually included, so a self-edit that never mentions `active` passes even
    # though the stored value is false. Checking the parsed body instead of the stored
    # row is what makes that distinction, and it is the whole reason this is not a
    # comparison against `before`.
    if not admin and "active" in body.changes():
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only an admin can activate or deactivate someone.",
        )

    before = q.get_person(email)
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person.")

    try:
        updated = q.update_person(email, body.changes())
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person.")

    audit.record(
        action="update",
        entity=AuditLogModel.ENTITY_PERSON,
        entity_id=updated["email"],
        before=before,
        after=updated,
        user_email=user_email,
    )
    return updated


@router.post("/{email}/deactivate", response_model=PersonOut)
async def deactivate_person(
    email: str,
    user_email: str = Depends(require_admin),
) -> dict[str, Any]:
    """
    Deactivate someone: the reversible removal, for a person who has moved on.

    Admin-only, including on your own record. Deactivating yourself is not a thing
    anybody needs to do in a hurry, and allowing it would give a self-service route
    into the one field update_person deliberately withholds.

    A POST on an explicit path rather than the DELETE it used to be, because DELETE
    now means what it says - see delete_person below. Two removals that differ this
    much in consequence should not be told apart by a query parameter.

    Returns the updated person rather than 204, because "deleted" here means
    "inactive" and the caller should be able to see that rather than infer it.
    Assignments are left pointing at them on purpose: silently unassigning every
    project when somebody leaves would erase the record of who was responsible, and
    the roadmap would show four unowned lanes with no explanation.
    """
    before = q.get_person(email)
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person.")

    updated = q.deactivate_person(email)
    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person.")

    audit.record(
        action="deactivate",
        entity=AuditLogModel.ENTITY_PERSON,
        entity_id=updated["email"],
        before=before,
        after=updated,
        user_email=user_email,
    )
    return updated


@router.delete("/{email}", response_model=PersonDeleted)
async def delete_person(
    email: str,
    user_email: str = Depends(require_admin),
) -> dict[str, Any]:
    """
    Delete someone for good, blanking every assignment that named them.

    Admin-only. This is the one irreversible action in the app and it rewrites other
    people's lanes as a side effect, so it is not something a caller should be able to
    reach by guessing a URL.

    The order matters and is not interchangeable. Assignments are cleared *first*, so
    that a failure partway through leaves rows pointing at a person who still exists
    - untidy but coherent, and re-runnable. Deleting the roster row first and then
    failing would leave dangling references with no way left to find them, because
    the email that identifies them is exactly what was just removed.

    Returns what it unassigned rather than 204. The caller has just been told this is
    irreversible, so "which four lanes now have no DRI" is the one thing they need in
    order to put it right, and it cannot be recovered by asking afterwards.

    The audit row keeps the full before-snapshot of the person and the assignments,
    which is the only remaining trace once this returns.
    """
    before = q.get_person(email)
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person.")

    unassigned = project_q.unassign_person(email)

    if not q.delete_person(email):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person.")

    audit.record(
        action="delete",
        entity=AuditLogModel.ENTITY_PERSON,
        entity_id=before["email"],
        before={"person": before, "unassigned": unassigned},
        user_email=user_email,
    )
    return {"email": before["email"], "name": before["name"], "unassigned": unassigned}
