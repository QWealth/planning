"""Who the caller is, as the API sees them.

Exists so the browser can ask rather than guess. The frontend holds a Cognito token
and could decode it, but decoding a token client-side answers "what does this token
claim" - the useful question is "what does the API think", and when the two disagree
(a stale token, a group added since sign-in, an authorizer misconfiguration) only
this endpoint gives the answer that actually governs requests.

Deliberately NOT behind require_planning_group. A user who is refused everything
else still needs to be told why, and a 403 from /api/me would leave the login screen
unable to distinguish "wrong group" from "server down".

IT ALSO ANSWERS "HAVE YOU FINISHED SIGNING UP"
----------------------------------------------
A login and a roster row are separate things (routes/people.py, create_person), and
an invite creates only the first (app/cognito.py). So an invited colleague's first
sign-in lands them somewhere the app has never had to handle before: authorised for
every endpoint, and unknown to every list of people. `onboarded` names that state so
the frontend can send them to the onboarding form instead of a roadmap where they
cannot be assigned anything and do not appear on the Team page.

It belongs here rather than in a second endpoint because the browser already blocks
on /api/me before rendering anything, and a separate call would mean a second round
trip that can only ever be made at the same moment as this one.
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app import config
from app.auth import get_user_email, get_user_groups, is_admin, require_planning_group
from app.db.queries import people as q

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["identity"])


class Identity(BaseModel):
    """The caller, and whether they may use this app."""

    email: Optional[str] = None
    groups: list[str] = []
    authorised: bool
    required_group: str
    enforced: bool
    # Whether this caller may act on people other than themselves. Sent so the UI can
    # hide controls it would only be refused for - but the API enforces it regardless,
    # because a hidden button is a courtesy and not a check.
    is_admin: bool = False
    admin_group: str
    # Whether this caller has a roster row yet. False sends them to onboarding instead
    # of the roadmap - see the module docstring and AppShell.tsx. Defaults True so that
    # anything which forgets to set it errs towards letting people in.
    onboarded: bool = True


def _has_roster_row(email: Optional[str]) -> bool:
    """
    Whether `email` is on the roster, failing OPEN.

    A lookup error returns True, which is the opposite of how the group check fails
    and is deliberate. `onboarded` is a routing hint, not a permission: getting it
    wrong in the False direction parks an authorised person on a form that cannot
    submit either, because the same table is down - a dead end that blames the user
    for an outage. Getting it wrong in the True direction sends them to the roadmap,
    which reports the actual failure. Nothing is protected by this flag, so there is
    nothing to fail closed for.
    """
    if not email:
        return True
    try:
        return q.get_person(email) is not None
    except Exception:
        logger.exception("Could not check the roster for %s; assuming onboarded", email)
        return True


@router.get("/me", response_model=Identity)
async def me(request: Request) -> dict[str, Any]:
    """
    The caller's identity and authorisation state.

    Returns the caller's own groups, which is not the reconnaissance risk that
    listing all groups would be: they can already read these from their own ID
    token, so this reveals nothing they do not hold.
    """
    email = get_user_email(request)
    groups = get_user_groups(request)
    authorised = bool(email) and (not config.ENFORCE_GROUP or config.REQUIRED_GROUP in groups)
    return {
        "email": email,
        "groups": groups,
        "authorised": authorised,
        "required_group": config.REQUIRED_GROUP,
        "enforced": config.ENFORCE_GROUP,
        "is_admin": is_admin(request),
        "admin_group": config.ADMIN_GROUP,
        # Only for callers who got past the group check. Someone refused at the door
        # is shown that refusal and never reaches onboarding, so the lookup would be a
        # DynamoDB read per rejected compliance-tool login and answer nothing.
        "onboarded": _has_roster_row(email) if authorised else True,
    }


class Features(BaseModel):
    """
    Which of the notification features this deployment actually has switched on.

    Served rather than assumed by the client, because the settings page explains what
    each one does and when it fires - and an explanation that says "you will get a DM on
    Monday" while the master switch is off is worse than no explanation. Somebody would
    wait for a message that was never coming and conclude the roadmap was broken.

    These are deployment-level switches, NOT per-person preferences. The digest's own
    opt-in lives on the roster row; this says whether the deployment would deliver it
    even if you asked for it.
    """

    digest_enabled: bool = False
    progress_enabled: bool = False
    rfc_chase_enabled: bool = False
    # Whether a channel is configured at all. The ID itself is not served: it is of no
    # use to a browser, and a channel id is a small piece of workspace structure that
    # does not need to be in a public bundle to answer "is this wired up".
    rfc_channel_configured: bool = False


@router.get("/features", response_model=Features)
async def features(user_email: str = Depends(require_planning_group)) -> dict[str, Any]:
    """
    What this deployment will and will not send.

    Behind the group check like everything else. It reveals nothing sensitive, but it
    describes internal scheduling, and there is no reason for it to be the one route
    that answers to anybody with the URL.
    """
    return {
        "digest_enabled": config.DIGEST_ENABLED,
        "progress_enabled": config.PROGRESS_ENABLED,
        "rfc_chase_enabled": config.RFC_CHASE_ENABLED,
        "rfc_channel_configured": bool(config.RFC_REVIEW_CHANNEL),
    }
