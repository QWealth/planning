"""Who the caller is, as the API sees them.

Exists so the browser can ask rather than guess. The frontend holds a Cognito token
and could decode it, but decoding a token client-side answers "what does this token
claim" - the useful question is "what does the API think", and when the two disagree
(a stale token, a group added since sign-in, an authorizer misconfiguration) only
this endpoint gives the answer that actually governs requests.

Deliberately NOT behind require_planning_group. A user who is refused everything
else still needs to be told why, and a 403 from /api/me would leave the login screen
unable to distinguish "wrong group" from "server down".
"""

from typing import Any, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app import config
from app.auth import get_user_email, get_user_groups, is_admin

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
    return {
        "email": email,
        "groups": groups,
        "authorised": bool(email) and (
            not config.ENFORCE_GROUP or config.REQUIRED_GROUP in groups
        ),
        "required_group": config.REQUIRED_GROUP,
        "enforced": config.ENFORCE_GROUP,
        "is_admin": is_admin(request),
        "admin_group": config.ADMIN_GROUP,
    }
