"""What an invite IS, separate from how Cognito is called and how it is exposed.

Three modules, three jobs, and the split is worth keeping:

    cognito.py   how the pool is written to        (one AWS service, nothing else)
    invites.py   what inviting somebody means      (this file)
    routes/      who is allowed to ask for it      (people.py, service.py)

This one exists because there are now TWO front doors onto the same act. An admin can
invite from the Team page, and an admin can invite from Slack via `/roadmap-invite`,
which reaches routes/service.py instead. Those must not be two implementations that
agree today and drift next quarter - particularly the message, for the reason below.

WHY THE MESSAGE IS COMPOSED HERE AND NOT IN THE BROWSER
------------------------------------------------------
It used to live in InvitePanel.tsx, which was fine while the browser was the only
sender. It is not fine now: a copy in the frontend and a copy in the Slack bot are
two copies of a paragraph whose entire job is to stop a colleague binning a
legitimate credentials email as phishing. If those drift, the version that loses the
warning still LOOKS correct - it reads as a perfectly good invite - and the failure
only shows up as an invited person who never signs in and never says why.

So the API composes it and both callers render what they are handed.

A second, quieter reason: the browser built the URL from `window.location.origin`,
which is right in production and wrong everywhere else. Anyone composing an invite
from a dev build was one paste away from sending a colleague a link to localhost.
`config.APP_URL` is the address the app actually answers on, whoever is asking.
"""

import logging
from typing import Any, Optional

from app import cognito, config, slack
from app.db.models import AuditLogModel
from app.db.queries import audit, people as q

logger = logging.getLogger(__name__)


def compose_message(account_created: bool, app_url: Optional[str] = None) -> str:
    """
    The text to send an invited colleague. Pure, so it can be tested without AWS.

    NAMES THE WRONG-LOOKING SUBJECT LINE ON PURPOSE. Cognito's own email is branded
    "QWealth Marketing Compliance Review", because the pool is shared with that tool
    and the invite template is per-POOL rather than per-app. An unexplained
    credentials email about a compliance tool, arriving because somebody added you to
    a roadmap, is precisely the shape of a phishing attempt - and the correct response
    to one of those is to ignore it. Which means an invitation that does not pre-empt
    it gets ignored by the most security-conscious people on the team.

    Rebranding the template is not available: it would change what the compliance
    tool's own invitees receive, and it may be managed by that repo's CDK, in which
    case an edit from here is silently reverted on their next deploy.

    `account_created` decides which half applies. Somebody who already had a pool
    account gets no password email at all, and telling them to wait for one is how an
    invite ends in a support conversation.
    """
    url = (app_url or config.APP_URL).rstrip("/")

    if account_created:
        credentials = (
            "You will get a separate email with a temporary password.\n"
            'Its subject line says "QWealth Marketing Compliance Review" -\n'
            "that is expected, it is the same sign-in for both tools."
        )
    else:
        credentials = (
            "Sign in with your existing QWealth account - the same one you\n"
            "use for the compliance tool. No new password."
        )

    return "\n".join(
        [
            "You've been added to the Planning Roadmap:",
            url,
            "",
            credentials,
            "",
            "First time in, it will ask you to fill in your name, what you do,",
            "and which skills you have. That takes a minute and is what puts",
            "you on the team list so work can be assigned to you.",
        ]
    )


def perform_invite(
    email: str, actor: str, slack_user_id: Optional[str] = None
) -> dict[str, Any]:
    """
    Ensure `email` can sign in, and say what happened - the whole use case.

    `actor` is whoever is answerable for this, and it goes in the audit row. For the
    Team page that is the admin's address; for Slack it is the calling service, which
    routes/service.py renders as something a human can recognise months later. It is
    NOT optional and has no default, because an invite with no author is the one audit
    row you would actually want.

    `slack_user_id` is a DELIVERY ROUTE, not an identity. When the address came from
    the Slack picker we already know which human it belongs to, so the instructions can
    be sent then and there instead of handed back for somebody to copy and paste. When
    it is absent - a typed address, or the `/roadmap-invite` command, which does its
    own DM as the Slack app rather than through us - the message comes back and the
    caller delivers it.

    Raises cognito.InviteError, which the routes turn into a 502. Deliberately not
    caught here: this module has no opinion about status codes.
    """
    result = cognito.invite_user(email)

    # Whether they already have a roster row, which decides whether the caller shows
    # the message at all - somebody fully set up needs no instructions. Read after the
    # invite rather than before, because the invite normalises the address to
    # lowercase and the roster is keyed on that.
    onboarded = q.get_person(result["email"]) is not None
    message = compose_message(result["account_created"])

    dm_sent = False
    dm_error: Optional[str] = None
    if slack_user_id and not onboarded:
        # Somebody already on the roster is not sent anything: they have been using the
        # app for months, and a fresh "you've been added" is a confusing message about
        # an account they already have. Same rule as the Slack command's.
        try:
            slack.dm(slack_user_id, message)
            dm_sent = True
        except slack.SlackError as e:
            # NOT re-raised. The Cognito account already exists by this point, so
            # failing the whole request would report "invite failed" for something that
            # half-succeeded, and the admin would retry into an account that is already
            # there. Instead the caller is told the delivery failed and handed the text,
            # which is exactly the copy-and-paste path that existed before Slack.
            dm_error = str(e)
            logger.warning("Invited %s but could not DM %s: %s", result["email"], slack_user_id, e)

    audit.record(
        action="invite",
        entity=AuditLogModel.ENTITY_PERSON,
        entity_id=result["email"],
        after={**result, "onboarded": onboarded, "dm_sent": dm_sent},
        user_email=actor,
    )
    logger.info(
        "%s invited %s (account_created=%s, group_added=%s, onboarded=%s, dm_sent=%s)",
        actor,
        result["email"],
        result["account_created"],
        result["group_added"],
        onboarded,
        dm_sent,
    )

    return {
        **result,
        "onboarded": onboarded,
        "message": message,
        "dm_sent": dm_sent,
        "dm_error": dm_error,
    }
