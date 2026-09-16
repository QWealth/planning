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
from app.db.models import AuditLogModel
from app.db.queries import audit, projects as projects_q, work as work_q
from app.db.queries._updates import ValidationError
from app.schemas.people import InviteIn, InviteOut
from app.milestone_check import ANSWER_DONE
from app.schemas.projects import (
    ServiceMilestoneAnswerIn,
    ServiceMilestoneAnswerOut,
    ServiceProgressIn,
    ServiceProgressOut,
)

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


@router.post("/phases/progress", response_model=ServiceProgressOut)
async def service_set_progress(
    body: ServiceProgressIn,
    caller: str = Depends(require_service_caller),
) -> dict[str, Any]:
    """
    Record progress on phases, on behalf of the person who submitted the Slack modal.

    THE SECOND THING THIS DOOR CAN DO, and it is a different kind of thing from the
    first. /invite creates a Cognito account; this writes roadmap data. Both are gated
    by the same two locks - the execute-api grant in aardvarkaap/lib/aardvark-app-stack.ts
    and the role allowlist in cdk/cdk.json - and the grant is scoped per METHOD, so this
    route does not become reachable until that policy names it too. A deploy of one repo
    without the other fails closed with a 403.

    WHY THE AUDIT NAMES A PERSON AND NOT THE SERVICE

    The module docstring explains why an invite is attributed to `service:<RoleName>`:
    the API cannot know which Slack admin typed the command, and inventing an address
    would be worse than admitting it. That reasoning does not transfer here, and the
    difference is worth being explicit about rather than quietly copying the pattern.

    The nudge is a DM to ONE person, and the interaction payload Slack hands the bot
    names that person. So the caller genuinely knows who acted, and recording
    `service:` would be discarding a fact we hold - leaving a progress figure on the
    roadmap that nobody appears to have entered. Progress is data people plan against;
    an unattributed change to it is worse than an unattributed invite.

    The cost is that this endpoint trusts `actor_email`. A compromised bot could
    attribute an edit to a colleague who never made it. That is a real widening and is
    accepted deliberately: reaching this route needs AWS credentials for a role that
    only this account's ECS task can assume, and anybody holding those can already call
    every route behind this door.

    PARTIAL SUCCESS IS REPORTED, NOT ROLLED BACK

    Each phase is written on its own. A phase deleted between the DM being sent and the
    modal being submitted comes back in `missing` rather than failing the whole batch,
    because the other five answers the person just gave are worth keeping. DynamoDB has
    no transaction spanning these rows that would make all-or-nothing honest anyway.
    """
    updated = 0
    missing: list[str] = []

    for item in body.updates:
        before = projects_q.get_phase(item.project_id, item.phase_id)
        if before is None:
            missing.append(item.phase_id)
            continue

        try:
            after = projects_q.update_phase(
                item.project_id, item.phase_id, {"progress": item.progress}
            )
        except ValidationError as e:
            # The phase's own rules refused this - a structural phase cannot carry
            # progress, for one. Reported as missing rather than raised: it is one row
            # of a batch, and the person is owed the rest of their answers.
            logger.warning("Progress refused for %s: %s", item.phase_id, e)
            missing.append(item.phase_id)
            continue

        if after is None:
            missing.append(item.phase_id)
            continue

        updated += 1
        audit.record(
            action="update",
            entity=AuditLogModel.ENTITY_PHASE,
            entity_id=item.phase_id,
            before=before,
            after=after,
            # The person, not the service. See above.
            user_email=body.actor_email,
        )

    logger.info(
        "Progress set by %s (via %s): %s updated, %s missing",
        body.actor_email,
        caller,
        updated,
        len(missing),
    )
    return {"actor_email": body.actor_email, "updated": updated, "missing": missing}


@router.post("/milestones/answer", response_model=ServiceMilestoneAnswerOut)
async def service_milestone_answer(
    body: ServiceMilestoneAnswerIn,
    caller: str = Depends(require_service_caller),
) -> dict[str, Any]:
    """
    Record what the DRI said when asked whether a milestone landed.

    THE THIRD THING THIS DOOR CAN DO, and like the second it needs its own line in the
    execute-api policy in aardvarkaap/lib/aardvark-app-stack.ts - the grant is per
    METHOD, so deploying this repo alone leaves the route returning 403 until that one
    ships too. That is the intended failure: a handler that cannot reach the API sends
    nothing, rather than a message whose buttons do nothing.

    THE LOG IS WRITTEN FIRST AND ALWAYS
    ------------------------------------
    Before the milestone is touched, and whatever happens to it afterwards. Both halves
    matter and they are the same argument in two directions.

    Writing first means a tick that fails leaves a record that somebody said it was
    done - which is recoverable by a human reading the log, where the opposite order
    would leave a ticked milestone nobody appears to have ticked. Writing always means
    a `not_done` with no milestone change still lands, and so does an answer about a
    milestone that was deleted between the DM and the button press. That last case is
    the one worth protecting: "I was asked about this and it had already gone" is
    exactly the kind of thing a reader of the log needs to see, and the obvious
    implementation - look it up, bail if missing - discards it.

    So a deleted milestone comes back with `milestone_marked_done: false` and a log row
    intact, rather than a 404 that loses the answer.

    THE AUDIT NAMES THE PERSON, NOT THE SERVICE
    -------------------------------------------
    Same reasoning as the progress route above, and for a stronger reason: this one
    writes a sentence somebody typed about why their deadline moved. Attributing that
    to `service:<RoleName>` would put an unsigned statement in a log other people read.
    """
    logged = work_q.create_milestone_check(
        {
            "project_id": body.project_id,
            "project_name": body.project_name,
            "milestone_id": body.milestone_id,
            "milestone_name": body.milestone_name,
            "due": body.due,
            "asked_email": body.actor_email,
            "answer": body.answer,
            "reason": body.reason,
        }
    )

    marked = False
    if body.answer == ANSWER_DONE:
        before = projects_q.get_milestone(body.project_id, body.milestone_id)
        if before is None:
            # Deleted or rescheduled onto another project since the DM. The answer is
            # already recorded above, which is the part that cannot be reconstructed.
            logger.warning(
                "Milestone %s gone; answer from %s logged but nothing ticked",
                body.milestone_id,
                body.actor_email,
            )
        else:
            try:
                after = projects_q.update_milestone(
                    body.project_id, body.milestone_id, {"done": True}
                )
            except ValidationError as e:
                # The milestone's own rules refused it. Reported rather than raised:
                # the answer is kept and the person is told the tick did not take.
                logger.warning("Marking %s done refused: %s", body.milestone_id, e)
                after = None
            if after is not None:
                marked = True
                audit.record(
                    action="update",
                    entity=AuditLogModel.ENTITY_MILESTONE,
                    entity_id=body.milestone_id,
                    before=before,
                    after=after,
                    # The person, not the service. See above.
                    user_email=body.actor_email,
                )

    logger.info(
        "Milestone answer from %s (via %s): %s on %s, ticked=%s",
        body.actor_email,
        caller,
        body.answer,
        body.milestone_id,
        marked,
    )
    return {
        "actor_email": body.actor_email,
        "answer": body.answer,
        "milestone_marked_done": marked,
        "logged": bool(logged),
    }
