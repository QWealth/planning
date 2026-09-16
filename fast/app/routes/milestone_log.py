"""
Reading the milestone-check log, which only business analysts may do.

WHAT THIS GATE IS, AND WHAT IT IS NOT
--------------------------------------
This is the FIRST role-based gate in the application, and roles.py warns against
exactly that in plain terms: "anyone reading this list as a permission check has
introduced a privilege-escalation-by-self-service bug, because people set their own
roles." That warning is correct and it applies here, so it is answered rather than
ignored.

People do set their own roles. Anybody on the roster can open the Team page, tick
"Business analyst" on their own entry, and read this log a second later. So this gate
keeps the log off the navigation of people it is not for; it does not keep a determined
colleague out, and nothing here should ever be read as though it did.

That was the requested behaviour and it is defensible for THIS content, which is a
record of which dated commitments landed and what the DRI said about the ones that did
not. It is internal planning history, written by the people it names, who are told at
the moment they answer that BAs read it - see blocks.compose_milestone_check. It is not
performance data, it is not confidential, and a self-service gate is a reasonable fit
for "this is not your screen" rather than "you may not see this".

If it ever needs to be a real boundary, the change is one predicate: `holds_ba` below
is the single place that decides, and swapping the roster role for the Cognito `admin`
group - which people cannot grant themselves - makes it one. Written as one function
for that reason.

NOTE THAT ADMINS ARE NOT AUTOMATICALLY INCLUDED
------------------------------------------------
An admin who is not also a BA is refused. That is deliberate rather than an oversight:
the request was for BAs, admin is an authorisation tier rather than a job, and quietly
widening a stated audience is not the kind of thing to do by default. An admin who
needs the log can give themselves the role, which is the same door everybody else has.
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from app.auth import require_planning_group
from app.db.queries import people as people_q, work as work_q
from app.roles import Role

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["milestone-log"])


def holds_ba(person: Optional[dict[str, Any]]) -> bool:
    """
    Whether a roster row carries the BA role.

    THE SINGLE PLACE THE DECISION IS MADE. The gate below and the `is_ba` flag on
    /api/me both come through here, so the navigation and the endpoint cannot disagree
    about who is allowed - a tab that appears and then 403s is worse than no tab.

    Takes the row rather than an address because /api/me already reads the person for
    `onboarded`, and a second lookup for the same fact would double the DynamoDB reads
    on the one endpoint every page load blocks on.
    """
    if not person:
        return False
    return Role.BA.value in (person.get("roles") or [])


def may_read_log(email: Optional[str]) -> bool:
    """
    The same question, for a caller who has not already read the row.

    Fails CLOSED, unlike the `onboarded` half of identity._roster_state next door, and
    the difference is the point: that flag is a routing hint protecting nothing, this
    one is the check. A
    DynamoDB error means the answer is unknown, and "unknown" must not read as "yes"
    for the predicate that decides who sees something.
    """
    if not email:
        return False
    try:
        return holds_ba(people_q.get_person(email))
    except Exception:
        logger.exception("Could not read the roster for %s; refusing the log", email)
        return False


def require_ba(request: Request) -> str:
    """FastAPI dependency: the caller is a BA, or the request is refused."""
    email = require_planning_group(request)
    if not may_read_log(email):
        logger.warning("Refused %s: not a business analyst", email)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            # Names the role rather than saying "forbidden", because the fix is
            # self-service and a refusal that does not say what is missing sends people
            # to ask an admin for something no admin can grant.
            detail="The milestone log is for business analysts. Set the role on your Team entry.",
        )
    return email


class MilestoneCheckOut(BaseModel):
    """One answer, exactly as it was recorded. See db/models.py MilestoneCheckModel."""

    item_id: str
    project_id: Optional[str] = None
    project_name: str
    milestone_id: Optional[str] = None
    # The name and date AS ASKED, not as they now stand. A milestone rescheduled after
    # the fact does not rewrite the question somebody already answered.
    milestone_name: str
    due: Optional[str] = None
    asked_email: Optional[str] = None
    answer: str
    # Null against `not_done` means they were asked and did not say - a modal dismissed
    # rather than submitted. A real state, not a missing field.
    reason: Optional[str] = None
    created_at: Optional[str] = None


@router.get("/milestone-log", response_model=list[MilestoneCheckOut])
async def milestone_log(email: str = Depends(require_ba)) -> list[dict[str, Any]]:
    """
    The whole log, newest first.

    No filters and no pagination. The log grows by at most a handful of rows a day, and
    a filter nobody asked for is a control to maintain against a screen that currently
    fits. See work_q.list_milestone_checks for what changes when that stops being true.
    """
    rows = work_q.list_milestone_checks()
    logger.info("Milestone log read by %s: %s entries", email, len(rows))
    return rows
