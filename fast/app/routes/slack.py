"""The Slack workspace directory, offered as a list of people to invite.

Read-only, admin-only, and it creates nothing. That last part is the important one:
this route is the answer to "who could I invite", NOT "who is on the team". The roster
is still written by each person at onboarding, because it carries roles and skills that
only they can supply - see app/cognito.py and routes/identity.py.

Keeping the two apart is what stops the Team page filling with names who have never
signed in. If this ever started creating roster rows, every Slack member would appear
`onboarded`, the onboarding gate would stop firing for anybody, and the roles and
skills the roadmap runs on would sit empty forever with nothing to prompt them.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends

from app import slack
from app.auth import require_admin
from app.db.queries import people as q
from app.schemas.slack import SlackDirectoryOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/slack", tags=["slack"])


@router.get("/people", response_model=SlackDirectoryOut)
async def slack_people(_admin: str = Depends(require_admin)) -> dict[str, Any]:
    """
    Everybody in Slack who could be invited, flagged with who already has a roster row.

    Admin-only, matching POST /api/people/invite. It is a directory of colleagues'
    email addresses, which is not secret inside the company but is also not something
    to hand to every signed-in account on a pool shared with another tool.

    NEVER FAILS THE REQUEST WHEN SLACK IS UNAVAILABLE. A 5xx here would take the invite
    UI down with it, and inviting somebody by typing their address still works perfectly
    well - it is what the app did until now. So a Slack outage, a missing scope or an
    unconfigured secret all come back as 200 with `unavailable` set, and the picker
    falls back to a text field. Losing the convenience is acceptable; losing the ability
    to grant a colleague access because a third party is down is not.
    """
    try:
        directory = slack.list_people()
    except slack.SlackError as e:
        logger.warning("Slack directory unavailable: %s", e)
        return {"people": [], "filtered": 0, "unavailable": str(e)}

    people = directory["people"]

    # include_inactive, because a deactivated person still HAS a roster row. Offering
    # to invite them as though they were new would be wrong twice: the invite would be
    # a no-op, and it would imply the roadmap had forgotten them.
    roster = {p.get("email", "").strip().lower() for p in q.list_people(include_inactive=True)}

    return {
        "people": [{**person, "on_roster": person["email"] in roster} for person in people],
        "filtered": max(directory["seen"] - len(people), 0),
    }
