"""Reading the Slack workspace directory, and delivering an invitation through it.

WHY THIS APP TALKS TO SLACK AT ALL
----------------------------------
Inviting somebody used to mean typing their email address. The roadmap exists because
the workbook it replaced held first names and nothing else, so a plausible-looking
wrong address is precisely the failure this project was started to kill - and a typo
in an invite is not a harmless mistake. It creates a Cognito login on the pool SHARED
with the marketing compliance tool, and mails a stranger a temporary password.

Slack already knows who works here, and it knows their addresses. So the admin picks a
person and the address is READ rather than typed. That is the whole point of this
module: one identity, chosen from a list, with no opportunity to mistype it.

WHY NOT VIA AARDVARK
--------------------
Aardvark Aap holds the Slack bot token and has a `/roadmap-invite` command that does
the same job from the Slack side. Routing this through Aardvark would have meant
calling its load balancer, which today is plain HTTP with no certificate and no
service authentication - a directory of every employee's email address, in clear text,
across an unauthenticated endpoint. This Lambda is not in a VPC and can reach
api.slack.com over TLS directly, so it does.

The cost of that decision is a SHARED bot token: both apps authenticate as the same
Slack app, so a DM sent from here appears to come from Aardvark. That is consistent
with `/roadmap-invite`, which also DMs as Aardvark, and it is the reason this module
only ever READS the directory and posts a message - it deliberately does not touch
anything else the token can reach.

SCOPES
------
`users:read` to list, `users:read.email` to see addresses, `chat:write` to DM. The
email one is separate and easily forgotten: without it Slack returns profiles with no
`email` key and NO error, so the directory would simply come back empty of anyone
invitable. `_explain` below turns that into a sentence that names the scope.
"""

import json
import logging
import time
from typing import Any, Optional

import boto3
import httpx
from botocore.exceptions import ClientError

from app import config

logger = logging.getLogger(__name__)

_SLACK_API = "https://slack.com/api"

# Module-level for the same reason as cognito.py's client: constructing it does no
# I/O, and in Lambda it is built once per container rather than once per request.
secrets = boto3.client("secretsmanager", region_name=config.AWS_REGION)


class SlackError(Exception):
    """Slack refused, with a reason worth showing the admin."""


# --------------------------------------------------------------------------------
# Credentials
# --------------------------------------------------------------------------------

# Cached for the life of the container. The token is fetched from Secrets Manager,
# which is a network call and a charge per request; doing it on every page load of the
# Team page would be both slow and pointless, because the value changes about never.
_token: Optional[str] = None


def _bot_token() -> str:
    """
    The bot token, from the environment in development or Secrets Manager in Lambda.

    The environment variable is checked first so `demo.py` and the tests can run with a
    fake, and so a developer with a token can exercise this without AWS credentials.
    It is deliberately NOT set by the CDK - see lambda_stack.py, which grants the role
    read access to the secret instead. A token in a Lambda environment variable is
    visible to anyone with lambda:GetFunctionConfiguration, which is a much wider group
    than the ones who can read the secret.
    """
    global _token
    if _token:
        return _token

    if config.SLACK_BOT_TOKEN:
        _token = config.SLACK_BOT_TOKEN
        return _token

    if not config.SLACK_SECRET_NAME:
        raise SlackError(
            "Slack is not configured for this deployment: no SLACK_SECRET_NAME. "
            "Invitations can still be created; they just cannot be delivered here."
        )

    try:
        raw = secrets.get_secret_value(SecretId=config.SLACK_SECRET_NAME)["SecretString"]
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code == "AccessDeniedException":
            raise SlackError(
                "This API may not read the Slack secret. The Lambda role needs "
                "secretsmanager:GetSecretValue on "
                f"'{config.SLACK_SECRET_NAME}'."
            ) from e
        if code == "ResourceNotFoundException":
            raise SlackError(
                f"The Slack secret '{config.SLACK_SECRET_NAME}' does not exist."
            ) from e
        logger.error("Could not read the Slack secret: %s", e)
        raise SlackError("Could not read the Slack credentials. See the logs.") from e

    try:
        token = json.loads(raw).get("SLACK_BOT_TOKEN")
    except (ValueError, AttributeError) as e:
        raise SlackError("The Slack secret is not the JSON object we expect.") from e

    if not token:
        raise SlackError(
            f"The Slack secret '{config.SLACK_SECRET_NAME}' has no SLACK_BOT_TOKEN key."
        )

    _token = token
    return _token


def reset_cache() -> None:
    """Drop the cached token and directory. For tests, and for `demo.py`."""
    global _token, _directory
    _token = None
    _directory = None


# --------------------------------------------------------------------------------
# Calling Slack
# --------------------------------------------------------------------------------


def _call(method: str, *, params: Optional[dict] = None, body: Optional[dict] = None) -> dict:
    """
    One Slack Web API call, with Slack's peculiar error convention handled once.

    Slack answers 200 OK for almost everything, including failure, and puts the real
    outcome in `ok` and `error`. Checking only the HTTP status - the obvious thing -
    would treat a missing scope as a success and return an empty directory.
    """
    url = f"{_SLACK_API}/{method}"
    headers = {"Authorization": f"Bearer {_bot_token()}"}

    try:
        if body is None:
            response = httpx.get(url, headers=headers, params=params, timeout=10.0)
        else:
            response = httpx.post(url, headers=headers, json=body, timeout=10.0)
    except httpx.HTTPError as e:
        # A timeout here is not the same as Slack saying no, and the admin should not
        # be told their invite was refused when it was never asked.
        logger.error("Slack %s did not respond: %s", method, e)
        raise SlackError("Slack did not respond. The invite was not delivered.") from e

    if response.status_code >= 400:
        logger.error("Slack %s returned HTTP %s", method, response.status_code)
        raise SlackError(f"Slack returned HTTP {response.status_code}.")

    payload = response.json()
    if not payload.get("ok"):
        raise SlackError(_explain(payload.get("error", "unknown_error"), method))
    return payload


def _explain(code: str, method: str) -> str:
    """
    Turn a Slack error code into something an admin can act on.

    Most of these are configuration rather than user error, and the scope ones in
    particular are invisible from the outside: the app looks installed and works for
    everything else, because a scope is missing from one method.
    """
    known = {
        "missing_scope": (
            "The Slack app is missing a permission. Listing people needs `users:read`, "
            "reading their addresses needs `users:read.email`, and sending the "
            "invitation needs `chat:write`. Add the missing scope and REINSTALL the "
            "app to the workspace - adding it alone does not take effect."
        ),
        "invalid_auth": "The Slack bot token is not valid. It may have been revoked.",
        "not_authed": "No Slack bot token was sent.",
        "account_inactive": "The Slack bot token belongs to a deactivated app.",
        "token_revoked": "The Slack bot token has been revoked.",
        "ratelimited": "Slack is rate-limiting us. Try again shortly.",
        "channel_not_found": (
            "Slack would not open a DM with that person. They may have left the "
            "workspace."
        ),
        "cannot_dm_bot": "That Slack account is a bot and cannot be sent an invitation.",
    }
    if code not in known:
        logger.error("Unhandled Slack error from %s: %s", method, code)
    return known.get(code, f"Slack refused the request ({code}).")


# --------------------------------------------------------------------------------
# The directory
# --------------------------------------------------------------------------------

# How long a fetched directory is reused, in seconds. The workspace roster changes
# when somebody joins the company, so a few minutes of staleness is invisible - while
# re-listing every member on every render of the Team page is a Tier-2 rate limit
# waiting to be hit by two admins with the page open.
_DIRECTORY_TTL = 300.0

# (fetched_at, people). Best-effort only: Lambda containers are short-lived and
# concurrent, so this is a way to avoid obvious waste, not a real cache.
_directory: Optional[tuple] = None


def list_people(force: bool = False) -> dict:
    """
    Everybody in the Slack workspace who could plausibly be invited.

    Filtered, because `users.list` returns a great deal that is not a colleague:
    deactivated accounts, every app and integration, and Slackbot. Left in the list,
    those would be offered as invitable people, and inviting one would create a Cognito
    login for an integration.

    Anyone without an email address is dropped too - not to be tidy, but because the
    address IS the identity here: it is the roster's key and the Cognito username. A
    person with no address cannot be invited by any path, so offering them would only
    produce a failure at the last step. NOTE this is also exactly what a missing
    `users:read.email` scope looks like - every profile arrives without an email and
    the whole list empties - which is why the route reports the count it filtered.

    Guests are KEPT, and flagged. They are usually contractors, who legitimately show
    up on a roadmap; hiding them would be a silent decision about who counts as
    staff, made in the wrong place.

    Returns {"people": [...], "seen": N} rather than a bare list. `seen` is how many
    members Slack actually returned, so the caller can tell an empty workspace apart
    from a workspace whose every profile was dropped - the second being what a missing
    `users:read.email` scope looks like, and the two are indistinguishable from the
    list alone.
    """
    global _directory

    if not force and _directory is not None:
        fetched_at, cached = _directory
        if time.monotonic() - fetched_at < _DIRECTORY_TTL:
            return cached

    people: list = []
    seen = 0
    cursor: Optional[str] = None
    # Bounded rather than `while True`: a cursor bug on either side would otherwise
    # spin until the Lambda's 30s timeout, and 20 pages is 4000 people.
    for _ in range(20):
        params: dict = {"limit": 200}
        if cursor:
            params["cursor"] = cursor
        payload = _call("users.list", params=params)

        for member in payload.get("members", []):
            seen += 1
            person = _as_person(member)
            if person is not None:
                people.append(person)

        cursor = (payload.get("response_metadata") or {}).get("next_cursor") or None
        if not cursor:
            break
    else:
        logger.warning("Stopped paginating Slack users.list after 20 pages.")

    people.sort(key=lambda p: p["name"].lower())
    result = {"people": people, "seen": seen}
    _directory = (time.monotonic(), result)
    return result


def _as_person(member: dict) -> Optional[dict]:
    """One `users.list` member, reduced to what the picker needs - or None to drop."""
    if member.get("deleted") or member.get("is_bot") or member.get("is_app_user"):
        return None
    if member.get("id") == "USLACKBOT":
        return None

    profile = member.get("profile") or {}
    email = (profile.get("email") or "").strip().lower()
    if not email:
        return None

    # Slack has three names and they are populated inconsistently. real_name is the
    # one people actually recognise; display_name is often blank, and `name` is the
    # legacy handle. Falling all the way back to the address is better than a blank
    # row in a picker.
    name = (
        profile.get("real_name_normalized")
        or profile.get("real_name")
        or member.get("real_name")
        or profile.get("display_name_normalized")
        or member.get("name")
        or email
    )

    return {
        "slack_user_id": member.get("id", ""),
        "name": name,
        "email": email,
        "avatar": profile.get("image_72") or profile.get("image_48") or "",
        "title": profile.get("title") or "",
        "is_guest": bool(member.get("is_restricted") or member.get("is_ultra_restricted")),
        "is_admin": bool(member.get("is_admin")),
    }


def dm(slack_user_id: str, text: str) -> None:
    """
    Send `text` to a person as a direct message.

    `chat.postMessage` accepts a user id as `channel` and opens the DM itself, so no
    `conversations.open` round trip is needed.

    Raises rather than returning a flag: the caller has just created a Cognito account,
    and "the login exists but nobody was told" is the one outcome that must never be
    reported as success. See invites.perform_invite.
    """
    _call("chat.postMessage", body={"channel": slack_user_id, "text": text})
