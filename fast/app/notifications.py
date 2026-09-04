"""
Sending the Monday digest: the side of the feature that touches DynamoDB and Slack.

`digest.py` next door decides what the message says. This decides who gets one, works
out whether it has already been sent, and delivers it. The split is what lets the
interesting decisions be tested with three dicts instead of two mocked AWS services.

THE ORDER OF OPERATIONS IS THE WHOLE DESIGN

    claim the week  ->  send

and not the other way round. Claiming after a successful send reads better and is
wrong: two Lambdas racing a retried EventBridge event would both send before either
claimed. Claiming first means at most one of them can get past the conditional write,
so the worst case is a digest claimed and then not delivered - a missed week - rather
than a colleague getting the same DM twice.

That is the deliberate direction to fail. A missed week is recoverable by anyone who
opens the roadmap; a duplicate DM is not recoverable at all, and it is the failure that
teaches people to mute the bot. See `audit.claim_once`, which is the other half of this.

NOBODY IS MESSAGED UNLESS THEY ASKED TO BE

This DMs colleagues. Every recipient has switched it on themselves on the settings
page, the roster default is off, and a person whose digest would be empty is sent
nothing at all rather than a weekly note saying so.
"""

import logging
from datetime import date
from typing import Any, Optional

from app import config, digest, slack
from app.db.queries import audit, people as people_q, projects as projects_q

logger = logging.getLogger(__name__)


def _slack_ids() -> dict[str, str]:
    """
    Workspace address -> Slack user id.

    The roster is keyed on email and Slack is the only thing that knows the id, so this
    is the join. It is rebuilt per run rather than stored on the person: a stored id
    would be a second copy of an identity we do not own, silently wrong the day somebody
    is deactivated and re-added.
    """
    directory = slack.list_people(force=True)
    return {
        person["email"]: person["slack_user_id"]
        for person in directory["people"]
        if person.get("slack_user_id")
    }


def _window(items: list[dict[str, Any]], days: int) -> list[dict[str, Any]]:
    """
    Narrow an already-computed list to one person's lookahead.

    `due_within` is run once at the widest offered window and then filtered per person,
    which gives exactly what re-running it at each person's window would: the only
    day-dependent test in there is the horizon, and overdue items are kept regardless of
    age. Doing it this way means one pass over the projects rather than one per
    recipient.
    """
    return [i for i in items if i["days_away"] <= days]


def _deliver(
    email: str,
    slack_user_id: str,
    text: str,
    key: str,
    week: str,
    summary: dict[str, Any],
    dry_run: bool,
) -> None:
    """Claim the week for `key`, then send. See the module docstring for the order."""
    if dry_run:
        summary["messages"].append({"email": email, "key": key, "text": text})
        return

    if not audit.claim_once(key, week, detail=f"{len(text)} chars"):
        summary["already_sent"] += 1
        return

    try:
        slack.dm(slack_user_id, text)
    except slack.SlackError as e:
        # Not re-raised: one person's DM failing must not cost everybody else theirs,
        # and this runs unattended so there is nobody to show an exception to. The week
        # stays claimed, so the retry is a human one - which is right, because a
        # transient Slack failure retried automatically is how duplicates happen.
        summary["failed"].append({"email": email, "error": str(e)})
        logger.error("Digest to %s failed: %s", email, e)
        return

    summary["sent"] += 1
    logger.info("Sent %s to %s for week %s", key, email, week)


def run_weekly_digest(
    today: Optional[date] = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """
    Work out who is owed a digest this week and send it. Returns what it did.

    `today` is injectable so a test - and a manual re-run of a week that failed - can
    say which week it means. `dry_run` composes everything and sends nothing, claims
    nothing, and returns the text; that is what the preview endpoint uses, and it is
    the only safe way to look at this in production.

    The returned summary is the only record of a run other than the logs, so it counts
    the reasons nobody was messaged as carefully as the sends. "0 sent" is ambiguous in
    a way that "0 sent, 6 with nothing due" is not.
    """
    today = today or date.today()
    week = digest.week_start(today)

    summary: dict[str, Any] = {
        "week": week,
        "today": today.isoformat(),
        "dry_run": dry_run,
        "opted_in": 0,
        "sent": 0,
        "nothing_due": 0,
        "already_sent": 0,
        "no_slack_account": [],
        "failed": [],
        "unowned_milestones": 0,
        "messages": [],
    }

    roster = [p for p in people_q.list_people() if digest.digest_prefs(p)[0]]
    summary["opted_in"] = len(roster)
    if not roster:
        # Nobody has opted in. Reading the directory would be a Slack call for nothing,
        # and this is the expected state for a while after the feature ships.
        return summary

    projects = projects_q.list_projects()
    widest = max(digest.DIGEST_WINDOWS)
    owned, unowned = digest.group_by_dri(digest.due_within(projects, today, widest))
    summary["unowned_milestones"] = len(unowned)

    try:
        ids = _slack_ids()
    except slack.SlackError as e:
        # Without the directory there is no way to address anybody, so nothing is
        # claimed and the whole run is retryable as-is.
        summary["failed"].append({"email": "*", "error": str(e)})
        logger.error("Digest run abandoned, no Slack directory: %s", e)
        return summary

    for person in roster:
        email = (person.get("email") or "").strip().lower()
        _, days = digest.digest_prefs(person)

        mine = _window(owned.get(email, []), days)
        theirs = _window(unowned, days) if person.get("digest_admin_report") else []

        text = digest.compose_digest(person.get("name"), mine, days)
        report = digest.compose_admin_report(theirs, days)
        if not text and not report:
            summary["nothing_due"] += 1
            continue

        slack_user_id = ids.get(email)
        if not slack_user_id:
            # On the roster but not findable in Slack - left the company, or a personal
            # address that never matched a workspace profile. Named in the summary
            # rather than logged and forgotten, because it is silent otherwise: they
            # have the setting switched on and simply never receive anything.
            summary["no_slack_account"].append(email)
            continue

        # Two messages and two claim keys, not one combined message. They answer
        # different questions - "what do I owe" and "what does nobody own" - and a week
        # where one sends and the other fails should leave the other still sendable.
        if text:
            _deliver(email, slack_user_id, text, f"digest#{email}", week, summary, dry_run)
        if report:
            _deliver(
                email, slack_user_id, report, f"digest-unowned#{email}", week, summary, dry_run
            )

    logger.info(
        "Digest week %s: %s opted in, %s sent, %s nothing due, %s already sent, %s failed",
        week,
        summary["opted_in"],
        summary["sent"],
        summary["nothing_due"],
        summary["already_sent"],
        len(summary["failed"]),
    )
    return summary


def lambda_handler(event: Optional[dict] = None, context: Any = None) -> dict[str, Any]:
    """
    What EventBridge invokes on Monday morning. See cdk/lib/lambda_stack.py.

    The same container image as the API, with a different CMD. One image means the
    scheduled job cannot drift from the app whose data it reads - a separate function
    with its own build is how a digest ends up describing last month's schema.

    `config.DIGEST_ENABLED` is checked HERE rather than inside `run_weekly_digest`, so
    that the switch guards delivery and only delivery. The preview route composes the
    identical text with the switch off, which is what makes it possible to look at this
    before turning it on.

    The event may carry `today` and `dry_run` for a manual invoke from the console -
    the way a week that failed gets re-run, and the way this gets tried in production
    without sending anything. A scheduled event carries neither and both default off.

    Returns the summary rather than raising, even on a bad `today`: a raise here is a
    Lambda error metric and a retry, and retrying a digest is the one thing worth
    avoiding. Logging config is set explicitly for the same reason main.py does it -
    the runtime's handler makes basicConfig a no-op and every logger.info vanishes.
    """
    logging.basicConfig(level=config.LOG_LEVEL)
    logging.getLogger().setLevel(config.LOG_LEVEL)

    event = event or {}
    dry_run = bool(event.get("dry_run"))

    today: Optional[date] = None
    if event.get("today"):
        today = digest.parse_date(event["today"])
        if today is None:
            logger.error("Ignoring unreadable 'today' in event: %r", event["today"])

    if not config.DIGEST_ENABLED and not dry_run:
        logger.info("DIGEST_ENABLED is off; composing and sending nothing.")
        return {"skipped": "DIGEST_ENABLED is off", "sent": 0}

    return run_weekly_digest(today=today, dry_run=dry_run)
