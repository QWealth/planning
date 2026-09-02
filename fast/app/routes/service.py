"""The machine-to-machine door. One route, and it is in its own file on purpose.

Everything else in this API is reached by a signed-in human whose Cognito token the
API Gateway authorizer verified. This is not: it is reached by the Aardvark Aap Slack
bot, an ECS task in the same AWS account, signing with SigV4 against a route whose
authorizer is IAM rather than Cognito.

WHY IT IS A SEPARATE PATH AND A SEPARATE FILE

A single route cannot carry two authorizers, so `/api/people/invite` could not simply
start accepting machines - the Cognito authorizer would reject an unsigned-in caller
long before Lambda ran. That forced a second path, and having been forced into one it
is worth making it obvious: anybody auditing "what can reach this API without a human
behind it" should find the whole answer in one short file rather than a decorator
buried among thirty roster endpoints.

WHAT THIS DELEGATES, AND TO WHOM

`/roadmap-invite` in Slack is gated by Aardvark's OWN admin list, in its MySQL
`admins` table - not by the Cognito `admin` group this API uses for everything else.
So this endpoint effectively grants Aardvark's Slack admins the power to create
accounts on the Cognito pool that is SHARED with the marketing compliance tool.

That is a real delegation of authority across two systems and it should be a
deliberate decision, not a side effect. It is recorded here, in CLAUDE.md, and in the
audit trail, where these invites are attributed to `service:<RoleName>` rather than to
any person - because the API genuinely does not know which Slack admin typed the
command, and inventing an address for the audit row would be worse than admitting it.

The invited person still fills in their own roster entry. Nothing here creates one.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from app import cognito, invites
from app.auth import require_service_caller
from app.schemas.people import InviteIn, InviteOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/service", tags=["service"])


@router.post("/invite", response_model=InviteOut, status_code=status.HTTP_201_CREATED)
async def service_invite(
    body: InviteIn,
    caller: str = Depends(require_service_caller),
) -> dict[str, Any]:
    """
    Invite somebody, on behalf of an allowlisted service. Not for browsers.

    Identical in effect to POST /api/people/invite - same idempotency, same audit
    action, same returned message - because it calls the same function. The ONLY
    difference is who is allowed to ask, and that difference lives entirely in the
    dependency above.

    That sameness is the point. Two invite implementations would eventually disagree
    about the group, or the lowercasing, or the wording, and the one that broke would
    be the one nobody clicks - see app/invites.py.
    """
    try:
        result = invites.perform_invite(body.email, actor=caller)
    except cognito.InviteError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e

    logger.info("Service invite by %s for %s", caller, result["email"])
    return result
