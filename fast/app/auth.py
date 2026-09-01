"""Who is making the request, and whether they may.

Copied from marketing_compliance_review/fast/app/auth.py and then extended. The
identity half is unchanged on purpose - it is the same pool, the same authorizer
and the same claim shapes, so a second implementation would only be a second thing
to get wrong. `_parse_groups` in particular should stay byte-identical to that file.

There is deliberately no JWT parsing here. When the API Gateway Cognito authorizer
is attached it has already validated the token's signature, expiry and audience
before Lambda was invoked, and it puts the resulting claims in the request context.
Re-parsing the token in application code would mean a second, weaker implementation
of the check that already passed - and the usual way that goes wrong is a decode
without signature verification, which accepts anything.

WHAT IS NEW HERE: enforcement.
------------------------------
The marketing tool resolves a role and acts on nothing - its auth.py says so
outright: "no route refuses a request over this yet". That is a defensible position
for a dedicated pool. It is not one here, because this app shares that pool, and an
API Gateway Cognito authorizer authenticates without authorizing: it accepts any
token the pool issued, no matter which app client minted it. So a compliance-tool
login is a structurally valid planning-app login. `require_planning_group` is the
thing that makes sharing the pool safe, and it is a FastAPI dependency rather than
a middleware so that a route which genuinely should be open (health) can simply not
depend on it, visibly, in its own signature.

TWO TIERS, NOT ONE
------------------
`require_planning_group` answers "may you use this app". `require_admin` answers "may
you act on somebody other than yourself", and the roster is the only place the two
differ: anyone may edit their own entry, only an admin may edit, deactivate or delete
anyone else's. Projects, phases and milestones are deliberately outside this - the
team schedules its own work, and making that admin-only would put one person in the
path of every date change.

The admin group is the pool's existing `admin`, which the compliance tool also uses,
so a compliance-tool admin is an admin here. That was chosen knowingly; see
config.ADMIN_GROUP.
"""

import logging
import os
from typing import Any, List, Optional

from fastapi import HTTPException, Request, status

from app import config

logger = logging.getLogger(__name__)

# Local development has no API Gateway in front of it, so there is no authorizer
# and no claims. Rather than have every route fall back to an anonymous identity in
# every environment - which would hide a misconfigured authorizer in production -
# the fallback identity is opt-in and names itself in the audit trail.
DEV_AUTH_BYPASS = os.environ.get("DEV_AUTH_BYPASS", "").strip().lower() in {"1", "true", "yes"}
DEV_USER_EMAIL = os.environ.get("DEV_USER_EMAIL", "local-dev@unauthenticated")

# Whether the bypass identity is also an admin. On by default, because the usual
# reason to run the bypass is to click through the whole app; off is available so the
# NON-admin paths can be exercised locally too, which is the half that is easy to
# ship broken - an admin never sees the button they are not allowed to press.
#
# Reads only when DEV_AUTH_BYPASS is on. It cannot grant anything in a deployed
# environment, because that path requires the absence of authorizer claims.
DEV_ADMIN = os.environ.get("DEV_ADMIN", "true").strip().lower() in {"1", "true", "yes"}


def _authorizer_claims(request: Request) -> dict[str, Any]:
    """Pull the authorizer's verified claims out of the Lambda proxy event."""
    # Mangum exposes the raw Lambda event here. Absent when running under plain
    # uvicorn, which is what the bypass below is for.
    event = request.scope.get("aws.event") or {}
    authorizer = event.get("requestContext", {}).get("authorizer") or {}

    # REST APIs nest the claims; HTTP APIs put them under "jwt". Both are handled so
    # that moving off API Gateway later does not silently start returning "system".
    claims = authorizer.get("claims")
    if claims is None:
        claims = (authorizer.get("jwt") or {}).get("claims")
    return claims or {}


def get_user_email(request: Request) -> Optional[str]:
    """
    The email of the authenticated caller, or None when unauthenticated.

    Returns None rather than raising: rejecting the request is the authorizer's and
    require_planning_group's job. A None result is recorded as "system" by the audit
    log, which is the honest answer when no identity was proven.
    """
    claims = _authorizer_claims(request)
    email = claims.get("email") or claims.get("cognito:username")

    if email:
        return str(email)

    if DEV_AUTH_BYPASS:
        return DEV_USER_EMAIL

    # Worth a warning: in a deployed environment this means the authorizer is not
    # attached, so schedule changes are being recorded against nobody.
    logger.warning(
        "No authorizer claims on the request; audit entries will be attributed to "
        "'system'. Expected only when running without API Gateway in front."
    )
    return None


def _parse_groups(raw: Any) -> List[str]:
    """
    Normalise the several shapes `cognito:groups` arrives in.

    A decoded JWT gives a real list. An API Gateway REST authorizer flattens its
    context to strings, and renders the list the way Java prints one - "[a, b]",
    square brackets and a space after the comma. An HTTP API gives the list back
    intact. All three are handled because which one applies depends on the gateway
    type, and that is an infrastructure decision that should not silently empty
    everyone's roles - which here would mean locking the whole team out.
    """
    if raw is None:
        return []

    if isinstance(raw, (list, tuple)):
        items = [str(item) for item in raw]
    else:
        text = str(raw).strip()
        # Strip the brackets the REST authorizer adds. Only as a matched pair, so a
        # group legitimately named "[odd]" is not quietly mangled into "odd".
        if text.startswith("[") and text.endswith("]"):
            text = text[1:-1]
        items = text.split(",")

    # Deduplicate while keeping order.
    seen = set()
    groups: List[str] = []
    for item in items:
        name = item.strip()
        if name and name not in seen:
            seen.add(name)
            groups.append(name)
    return groups


def get_user_groups(request: Request) -> List[str]:
    """
    Every Cognito group the caller belongs to, verbatim, or [] when unauthenticated.

    Includes groups this application does not know about, so that a group added for
    some other purpose shows up in logs rather than vanishing.
    """
    claims = _authorizer_claims(request)

    # The bypass keys off the absence of *claims*, not the absence of groups. Keying
    # off groups would mean that a deployed environment with DEV_AUTH_BYPASS left set
    # hands the required group to every authenticated pool member who has not been
    # assigned one - which is most of them, and which is precisely the failure this
    # module exists to prevent.
    if not claims:
        if not DEV_AUTH_BYPASS:
            return []
        granted = [config.REQUIRED_GROUP]
        if DEV_ADMIN:
            granted.append(config.ADMIN_GROUP)
        return granted

    return _parse_groups(claims.get("cognito:groups"))


def require_planning_group(request: Request) -> str:
    """
    FastAPI dependency: allow the request, or refuse it with 403.

    Returns the caller's email so a route can depend on this once and get both the
    check and the identity, rather than calling get_user_email separately and
    risking a route that authenticates but forgets to authorize.

    Two distinct refusals, and the difference matters when debugging:
      401 - no claims at all. The authorizer is not attached, or is misconfigured.
      403 - a valid pool member who is not in the planning group. Very likely a
            compliance-tool account, which is exactly the case we are guarding.
    """
    if not config.ENFORCE_GROUP:
        # Only for a deliberate, temporary local run. Logged at warning so that an
        # environment left in this state is visible in CloudWatch rather than silent.
        logger.warning(
            "ENFORCE_GROUP is off; serving a request without the '%s' group check. "
            "The Cognito pool is shared, so this admits every compliance-tool account.",
            config.REQUIRED_GROUP,
        )
        return get_user_email(request) or "system"

    email = get_user_email(request)
    if email is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated.",
        )

    groups = get_user_groups(request)
    if config.REQUIRED_GROUP not in groups:
        # The groups the caller *does* hold go to the log, not the response body.
        # Telling an unauthorized caller which groups exist is free reconnaissance.
        logger.warning(
            "Refused %s: not in group '%s' (holds: %s)",
            email,
            config.REQUIRED_GROUP,
            ", ".join(groups) or "none",
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account is not authorised for the planning roadmap.",
        )

    return email


def is_admin(request: Request) -> bool:
    """
    Whether the caller may manage other people.

    Not a dependency: several routes need the ANSWER rather than the refusal, because
    what they do differs for an admin instead of simply being denied - creating a
    person is allowed for everyone, but only an admin may create somebody other than
    themselves. Those routes call this and decide; the ones that are flatly admin-only
    depend on require_admin below.
    """
    return config.ADMIN_GROUP in get_user_groups(request)


def require_admin(request: Request) -> str:
    """
    FastAPI dependency: the caller is an admin, or the request is refused.

    For the operations that have no self-service form at all - deactivating and
    deleting other people. Deliberately still 403 rather than 404: pretending the
    route does not exist would be a lie the frontend has to work around, and the
    roster is readable by every caller anyway, so hiding it protects nothing.
    """
    email = require_planning_group(request)
    if not is_admin(request):
        logger.warning(
            "Refused %s: not in admin group '%s'", email, config.ADMIN_GROUP
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Only the {config.ADMIN_GROUP} group can manage other people.",
        )
    return email


def same_person(a: Optional[str], b: Optional[str]) -> bool:
    """
    Whether two addresses are the same person.

    Case-insensitive and whitespace-trimmed, matching how the roster stores and looks
    up addresses everywhere else. A self-edit check that missed "Thomas@qwealth.com"
    against "thomas@qwealth.com" would refuse people access to their own record for a
    reason they could not see, so this must not be an == on raw strings.

    Two Nones are NOT the same person. An unauthenticated caller has no identity to
    match, and returning True there would make "edit yourself" mean "edit the person
    with no address recorded".
    """
    if not a or not b:
        return False
    return a.strip().lower() == b.strip().lower()
