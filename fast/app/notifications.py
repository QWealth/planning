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

from app import blocks, config, digest, progress, slack
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
    blocks: Optional[list[dict[str, Any]]] = None,
) -> None:
    """
    Claim the period for `key`, then send. See the module docstring for the order.

    `week` is the claim's period and is not always a week: the progress nudge runs twice
    a week and passes the DAY, so Monday's claim cannot silence Wednesday's. The name is
    kept because the digest - the original and still the main caller - really does claim
    by week, and renaming it to `period` at both call sites would obscure that.
    """
    if dry_run:
        summary["messages"].append({"email": email, "key": key, "text": text, "blocks": blocks})
        return

    if not audit.claim_once(key, week, detail=f"{len(text)} chars"):
        summary["already_sent"] += 1
        return

    try:
        slack.dm(slack_user_id, text, blocks=blocks)
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


def run_progress_nudge(
    today: Optional[date] = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """
    Ask each phase owner - or the lane's DRI where nobody owns it - where their work is.

    Same claim-then-send ordering as the digest, and the same reason: a retried schedule
    that DMs somebody twice is how a bot gets muted. The claim period here is the DAY
    rather than the week, because this runs on Monday AND Wednesday and a weekly claim
    would let Monday's send silence Wednesday's.

    THERE IS NO PER-PERSON OPT-IN, unlike the digest. That was a deliberate call: being
    asked where your work has got to is part of owning it. The consequence is that this
    is an unsolicited recurring DM, which is exactly what the digest's opt-in default
    exists to avoid - so the deployment-level switch matters more here, not less.

    `dry_run` composes everything, claims nothing and sends nothing, returning the
    blocks. That is how this gets looked at in production before it is switched on.
    """
    today = today or date.today()
    day = today.isoformat()

    summary: dict[str, Any] = {
        "job": "progress",
        "today": day,
        "dry_run": dry_run,
        "asked": 0,
        "sent": 0,
        "already_sent": 0,
        "open_phases": 0,
        "unasked_phases": 0,
        "no_slack_account": [],
        "failed": [],
        "messages": [],
    }

    rows = progress.open_phases(projects_q.list_projects())
    summary["open_phases"] = len(rows)
    # Counted whether or not anybody is messaged. These are the phases the nudge cannot
    # reach at all, and a run that reported only its successes would look healthy while
    # part of the board went unchased.
    summary["unasked_phases"] = len(progress.unasked(rows))

    grouped = progress.group_by_asker(rows)
    summary["asked"] = len(grouped)
    if not grouped:
        return summary

    # Project name -> id, for the button payload. Built from the same rows the message
    # is drawn from, so the two cannot disagree about which project is which.
    project_ids = {row["project_name"]: row["project_id"] for row in rows}

    names = {
        (person.get("email") or "").strip().lower(): person.get("name")
        for person in people_q.list_people()
    }

    try:
        ids = _slack_ids()
    except slack.SlackError as e:
        # No directory means no way to address anybody. Nothing is claimed, so the whole
        # run stays retryable exactly as it stands.
        summary["failed"].append({"email": "*", "error": str(e)})
        logger.error("Progress nudge abandoned, no Slack directory: %s", e)
        return summary

    for email, bundle in grouped.items():
        name = names.get(email)
        body = blocks.compose_nudge(name, bundle["projects"], project_ids)
        if body is None:
            continue

        slack_user_id = ids.get(email)
        if not slack_user_id:
            # Owns work on the roadmap but is not findable in Slack. Named rather than
            # logged and forgotten: they are being asked for nothing, silently.
            summary["no_slack_account"].append(email)
            continue

        _deliver(
            email,
            slack_user_id,
            blocks.fallback_text(name, bundle["count"]),
            f"progress#{email}",
            day,
            summary,
            dry_run,
            blocks=body,
        )

    logger.info(
        "Progress nudge %s: %s asked, %s sent, %s already sent, %s open phases, "
        "%s with nobody to ask, %s failed",
        day,
        summary["asked"],
        summary["sent"],
        summary["already_sent"],
        summary["open_phases"],
        summary["unasked_phases"],
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

    # Which job this invocation is. Several schedules point at this one function - the
    # Monday digest, the Monday/Wednesday progress nudge - because they share an image,
    # a role and a set of table permissions, and splitting them into separate functions
    # would mean keeping three of each in step for no gain.
    #
    # A scheduled event names its job explicitly; the default is the digest, so an
    # invocation from before this dispatch existed still does what it used to.
    job = (event.get("job") or "digest").strip().lower()

    if job == "progress":
        if not config.PROGRESS_ENABLED and not dry_run:
            logger.info("PROGRESS_ENABLED is off; composing and sending nothing.")
            return {"skipped": "PROGRESS_ENABLED is off", "sent": 0}
        return run_progress_nudge(today=today, dry_run=dry_run)

    if job != "digest":
        # Named rather than silently treated as the digest. A typo in a schedule's
        # payload would otherwise send the wrong message on the wrong day, which is
        # worse than sending nothing and saying so.
        logger.error("Unknown job %r; sending nothing.", job)
        return {"skipped": f"unknown job {job!r}", "sent": 0}

    if not config.DIGEST_ENABLED and not dry_run:
        logger.info("DIGEST_ENABLED is off; composing and sending nothing.")
        return {"skipped": "DIGEST_ENABLED is off", "sent": 0}

    return run_weekly_digest(today=today, dry_run=dry_run)
