"""
What the Monday digest SAYS, separate from how it is sent.

Everything here is pure: dates in, text out, no boto3 and no Slack. That is the whole
point of the split. `notifications.py` next door is the part that cannot be run in a
test without mocking two AWS services and an HTTP client, so the decisions worth being
sure about - which milestones count, whose they are, what the message reads like -
live on this side of the line where a test is three dicts and an assertion.

WHY A DIGEST AND NOT A MESSAGE PER MILESTONE

A message per milestone is easier to write and worse to receive. The failure mode of
per-item alerting is that it arrives at the moment the sender finds convenient and the
reader does not, and the second one is ignored slightly faster than the first. A weekly
digest is read at a moment somebody is already deciding what their week looks like,
which is the only moment the information is actionable.

It also fails quietly rather than loudly. A digest with nothing in it is not sent at
all, so the system is silent for people with nothing due - and silence is what stops a
notification becoming something people filter.

OVERDUE MILESTONES ARE INCLUDED, AND THEY LEAD

A milestone whose date has passed and which nobody has ticked off is the single most
useful thing this can tell anyone, and it is exactly what the workbook could never say.
It is listed first, before the upcoming ones, because a digest that opens with next
Friday and buries "this was due nine days ago" three lines down has optimised for
chronology over consequence.

There is no cutoff on how far back it looks. A deliberate choice: a milestone that has
been overdue for two months is not less overdue, and the honest fix is to tick it or
move it, both of which the app supports. If this ever gets noisy, the noise is real.
"""

from datetime import date, timedelta
from typing import Any, Iterable, Optional

# The windows a person may choose on the settings page.
#
# A fixed set rather than a free integer, because every value in between is a
# distinction nobody can act on - "the next 11 days" is not a way anyone plans - and an
# open field would have to be validated, clamped, and explained anyway.
DIGEST_WINDOWS: tuple[int, ...] = (7, 14, 30)

# What somebody gets before they have ever opened the settings page.
#
# Off, by decision: this sends a direct message to a colleague, and a system that
# starts doing that on deploy is one nobody agreed to. `DEFAULT_DIGEST_DAYS` only
# applies once they have switched it on.
DEFAULT_DIGEST_ENABLED = False
DEFAULT_DIGEST_DAYS = 14


def digest_prefs(person: dict[str, Any]) -> tuple[bool, int]:
    """
    One person's settings, defaulted and clamped.

    Every roster row predates these fields, so absent has to mean the default rather
    than an error - the same rule `PersonModel.from_item` already applies to roles and
    specialisations. A stored window outside the offered set (a hand-edited item, or a
    value retired from DIGEST_WINDOWS later) falls back rather than being honoured,
    because the alternative is a scheduled job whose behaviour nobody can predict from
    reading the settings page.
    """
    enabled = bool(person.get("digest_enabled", DEFAULT_DIGEST_ENABLED))
    try:
        days = int(person.get("digest_days", DEFAULT_DIGEST_DAYS))
    except (TypeError, ValueError):
        days = DEFAULT_DIGEST_DAYS
    if days not in DIGEST_WINDOWS:
        days = DEFAULT_DIGEST_DAYS
    return enabled, days


def parse_date(value: Any) -> Optional[date]:
    """
    An ISO date, or None for anything that is not one.

    Milestone dates are nullable by design - "not yet committed" is a real answer -
    and the table can also hold whatever a console edit put there. Neither may raise:
    this runs unattended on a schedule, and a single malformed date must cost one
    missing line in one digest, not the whole run for everybody.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


def week_start(today: date) -> str:
    """
    The Monday of `today`'s week, as an ISO date.

    This is the deduplication key. The schedule fires on Monday, but a retry, a manual
    re-run, or a redeploy that replays the event must not send a second copy - and
    keying on the exact timestamp would make every retry look new. Keyed on the week,
    a re-run on Wednesday after a failed Monday is correctly recognised as the same
    digest.
    """
    return (today - timedelta(days=today.weekday())).isoformat()


def due_within(
    projects: Iterable[dict[str, Any]],
    today: date,
    days: int,
) -> list[dict[str, Any]]:
    """
    Every open, dated milestone that is either overdue or lands within `days`.

    Takes the projects list whole - `q.list_projects()` already returns each project
    with its milestones nested, so this needs no further reads and no per-project
    fan-out.

    `done` is checked and `date` is required. An undated milestone is not late, it is
    unscheduled, and telling somebody it is "coming up" would be a sentence about
    nothing. A done one is finished whether or not its date has passed.
    """
    horizon = today + timedelta(days=days)
    out: list[dict[str, Any]] = []

    for project in projects:
        for milestone in project.get("milestones") or []:
            if milestone.get("done"):
                continue
            when = parse_date(milestone.get("date"))
            if when is None or when > horizon:
                continue
            out.append(
                {
                    "project_id": project.get("project_id"),
                    "project_name": project.get("name") or "Untitled project",
                    "dri_email": (project.get("dri_email") or "").strip().lower() or None,
                    "milestone_id": milestone.get("milestone_id"),
                    "name": milestone.get("name") or "Untitled milestone",
                    "date": when,
                    "overdue": when < today,
                    "days_away": (when - today).days,
                }
            )

    # Overdue first, then soonest. Within a day, project name keeps it stable so two
    # runs of the same data produce the same message.
    out.sort(key=lambda m: (m["date"], m["project_name"], m["name"]))
    return out


def group_by_dri(
    items: Iterable[dict[str, Any]],
) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    """
    Split the due milestones into "somebody's" and "nobody's".

    Two return values rather than a dict with a None key, because the two go to
    different people for different reasons. A DRI is being reminded of their own work;
    the unowned list is a report to an admin that some work has no one to remind, which
    is a different message with a different call to action.

    Four of the nine migrated projects have no DRI, so the second list is not an edge
    case - it is most of the reason this is worth building.
    """
    owned: dict[str, list[dict[str, Any]]] = {}
    unowned: list[dict[str, Any]] = []
    for item in items:
        dri = item.get("dri_email")
        if dri:
            owned.setdefault(dri, []).append(item)
        else:
            unowned.append(item)
    return owned, unowned


def _when(item: dict[str, Any]) -> str:
    """How a single date is phrased, relative to the day the digest is sent."""
    when: date = item["date"]
    pretty = when.strftime("%a %-d %b")
    days = item["days_away"]
    if days < 0:
        late = -days
        return f"{pretty} — {late} day{'s' if late != 1 else ''} ago"
    if days == 0:
        return f"{pretty} — today"
    if days == 1:
        return f"{pretty} — tomorrow"
    return f"{pretty} — in {days} days"


def _line(item: dict[str, Any]) -> str:
    return f"• *{item['name']}* — {item['project_name']} — {_when(item)}"


def compose_digest(name: Optional[str], items: list[dict[str, Any]], days: int) -> str:
    """
    One person's digest.

    Returns "" when there is nothing to say, and the caller is expected to send
    nothing rather than send an empty-handed message. "You have no milestones this
    week" every Monday for a month is how a useful notification becomes one people
    mute, and a muted channel is worse than no channel because it looks like it is
    working.

    Addressed by first name where there is one. The bot is Aardvark - the same app that
    sends the invitations - so the message has to say what it is about immediately;
    somebody receiving this has probably never had a DM from a roadmap before.
    """
    if not items:
        return ""

    overdue = [i for i in items if i["overdue"]]
    upcoming = [i for i in items if not i["overdue"]]

    greeting = f"Morning {name.split()[0]}" if name else "Morning"
    lines = [f"{greeting} — here's where your milestones stand."]

    if overdue:
        lines += ["", f"*Past their date ({len(overdue)})*"]
        lines += [_line(i) for i in overdue]

    if upcoming:
        lines += ["", f"*Next {days} days ({len(upcoming)})*"]
        lines += [_line(i) for i in upcoming]

    # Names where to act, because a reminder whose only possible response is "yes, I
    # know" is an interruption rather than a prompt.
    lines += [
        "",
        "You're the DRI on these. Tick one off or move its date on the roadmap.",
    ]
    return "\n".join(lines)


def compose_admin_report(items: list[dict[str, Any]], days: int) -> str:
    """
    The milestones nobody was reminded about, for whoever is watching the roster.

    This is the counterpart to the digest, and it exists because the alternative is
    worse than it sounds. A reminder system that silently skips projects with no DRI is
    least useful exactly where the risk is highest: an unowned deadline is the one with
    nobody watching it by definition.

    Empty means nothing is sent, same as the personal digest. If every project has a
    DRI, that is a state worth having and not worth a weekly note about.
    """
    if not items:
        return ""

    overdue = [i for i in items if i["overdue"]]
    lines = [
        f"*Milestones with no DRI* — {len(items)} in the next {days} days"
        + (f", {len(overdue)} already past their date" if overdue else ""),
        "",
    ]
    lines += [_line(i) for i in items]
    lines += [
        "",
        "Nobody was messaged about these, because their project has no DRI. "
        "Setting one on the roadmap is what starts the reminders.",
    ]
    return "\n".join(lines)
