"""
Asking the DRI, on the day, whether a milestone actually landed.

Pure, like digest.py and progress.py next door, and for the same reason: who gets asked
about what is the part worth being sure of, and it should be testable with three dicts
rather than two mocked AWS services. Sending lives in notifications.py, drawing in
blocks.py, and the answers are written by routes/service.py.

WHY THIS EXISTS WHEN THE DIGEST ALREADY MENTIONS MILESTONES
-----------------------------------------------------------
The digest TELLS; this ASKS. That is the whole difference and it is not a small one.

The Monday digest lists what is coming and what has slipped, and its own docstring
argues against per-milestone messaging - correctly, for a reminder. A reminder that
arrives per item is one the reader learns to skim. But "did this land?" is a question,
not a reminder: it has exactly one addressee, one moment where the answer is known, and
an answer that is worth keeping. Folding it into a weekly roundup would mean asking on
Monday about a Thursday deadline, by which point "yes, on the Friday" and "no, and here
is why" have already blurred into the same shrug.

So the cadence is the opposite of the digest's on purpose. The digest is weekly because
nobody can act on a daily list. This is daily because a due date happens on one day.

AND WHY IT IS A DIFFERENT QUESTION FROM THE PROGRESS NUDGE
-----------------------------------------------------------
The nudge asks for a number on a phase: "how far through are you". This asks for a fact
about a dated commitment: "was it done". A phase at 60% is a status; a milestone that
slipped is an event, and the REASON it slipped is the thing nobody currently writes
down anywhere. That reason is the point of the feature - see the log in
db/queries/work.py - and it is why a missed answer opens a second question rather than
just leaving the milestone unticked.

THE DRI, AND NOBODY ELSE
------------------------
A milestone has no owner field; accountability for one sits with the project's DRI, and
that is the person asked. Deliberately NOT the owner-then-DRI fallback the progress
nudge uses - that fallback exists because `owner_email` is recorded on fewer than half
the phases and owner-only scoping would skip most of the board. There is no equivalent
gap here, because there is no equivalent field: a milestone's DRI is the only
accountable address the data holds.

A milestone whose project has no DRI is asked about by nobody. Counted rather than
papered over, exactly as progress.unasked does, because inventing a recipient for a
question about somebody else's commitment is worse than admitting there isn't one.

THE WEEKEND, WHICH IS WHY THIS TAKES A WINDOW AND NOT A DAY
------------------------------------------------------------
Milestones are dated by people planning, so they land on Saturdays. The job runs on
working days only - a Sunday DM asking about a Saturday deadline is a question nobody
is there to answer, and by Monday it has scrolled away.

So each run covers everything due since the last working day rather than only today:
Monday asks about Saturday, Sunday and Monday, and Tuesday asks about Tuesday. Every
dated milestone is therefore asked about exactly once, on the first working day it
could honestly be asked about. The alternative - asking only about `today` - silently
drops every weekend date, which is the kind of gap that looks like the feature working.
"""

from datetime import date, timedelta
from typing import Any, Iterable, Optional

# The two answers. Stored on the log row, so these strings are data rather than
# presentation and renaming one is a migration.
ANSWER_DONE = "done"
ANSWER_NOT_DONE = "not_done"
ANSWERS = (ANSWER_DONE, ANSWER_NOT_DONE)

# How far back a single run will reach, as a safety rail rather than as a schedule.
#
# Normally the window is one to three days (see last_working_day). This caps what a run
# would cover if the job had been off for a fortnight and were then switched on: without
# it, the first run after an outage would DM everybody about every milestone of the past
# month at once, which is precisely the wall of notifications that gets a bot muted.
# Anything older is the digest's job - it lists overdue items with no cutoff at all.
MAX_LOOKBACK_DAYS = 4


def _clean(value: Any) -> Optional[str]:
    """An address, lowercased and trimmed, or None. Emails compare case-insensitively."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip().lower()
    return cleaned or None


def last_working_day(today: date) -> date:
    """
    The previous Mon-Fri before `today`.

    Used to size the window, not to decide whether to run - the schedule already runs
    on working days only. Saturday and Sunday are the only non-working days modelled;
    statutory holidays are not, because the app has no holiday calendar and guessing at
    one would mean a milestone due on a Monday holiday never being asked about at all.
    Asking a day early on a holiday is a smaller failure than never asking.
    """
    previous = today - timedelta(days=1)
    while previous.weekday() >= 5:  # 5 = Saturday, 6 = Sunday
        previous -= timedelta(days=1)
    return previous


def window(today: date) -> tuple[date, date]:
    """
    The inclusive span of due dates this run covers: (since, today).

    `since` is the day after the last working day, so consecutive runs tile the calendar
    exactly - no date is covered twice (which would be a second DM about a milestone
    somebody already answered) and none is skipped (which would be a deadline nobody was
    ever asked about). Clamped by MAX_LOOKBACK_DAYS; see the note there.
    """
    since = last_working_day(today) + timedelta(days=1)
    floor = today - timedelta(days=MAX_LOOKBACK_DAYS)
    return max(since, floor), today


def parse_day(value: Any) -> Optional[date]:
    """
    An ISO date, or None for anything unreadable.

    Its own function rather than digest.parse_date so this module stays importable on
    its own; the two are three lines and duplicating them beats a cross-import between
    two modules that otherwise share nothing.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def due_in_window(
    projects: Iterable[dict[str, Any]],
    today: date,
) -> list[dict[str, Any]]:
    """
    Every open, dated milestone whose date falls in this run's window, DRI resolved.

    Takes the projects whole, exactly as digest.due_within and progress.open_phases do:
    list_projects already returns milestones nested, so this needs no second read.

    `done` is checked, because a milestone somebody has already ticked needs no
    question - and asking about one would read as the app not having noticed. An
    undated milestone is skipped for the reason digest gives: it is not late, it is
    unscheduled, and there is no day on which to ask about it.

    Inactive projects are skipped. A retired lane's dates are not commitments anybody
    should be asked to account for.
    """
    since, until = window(today)
    rows: list[dict[str, Any]] = []

    for project in projects:
        if project.get("active") is False:
            continue
        dri = _clean(project.get("dri_email"))
        for milestone in project.get("milestones") or []:
            if milestone.get("done"):
                continue
            when = parse_day(milestone.get("date"))
            if when is None or when < since or when > until:
                continue
            rows.append(
                {
                    "project_id": project.get("project_id"),
                    "project_name": project.get("name") or "Untitled project",
                    "milestone_id": milestone.get("milestone_id"),
                    "milestone_name": milestone.get("name") or "Untitled milestone",
                    "due": when.isoformat(),
                    # True only for a date before today - a milestone due today is not
                    # late yet, and calling it so in the message would be picking a
                    # fight with somebody who has the rest of the day.
                    "late": when < today,
                    "dri": dri,
                }
            )

    # Oldest first, so a Monday message opens with Saturday's deadline rather than
    # today's. Project name keeps two runs over the same data identical.
    rows.sort(key=lambda r: (r["due"], r["project_name"], r["milestone_name"]))
    return rows


def group_by_dri(rows: Iterable[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """
    Rows -> {address: [rows]}, preserving order.

    One level deep, unlike progress.group_by_asker's two. The nudge groups by project
    because somebody may hold thirteen phases across four lanes and the message needs
    structure; a person with more than two or three milestones landing on the same day
    is not a case worth designing a hierarchy for.
    """
    out: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        dri = row.get("dri")
        if dri:
            out.setdefault(dri, []).append(row)
    return out


def unasked(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Milestones due today that nobody will be asked about: the project has no DRI.

    Surfaced rather than dropped, for the reason progress.unasked gives: a run that
    counted only its sends would report a healthy "asked everybody" while the deadlines
    with nobody accountable - the ones most worth noticing - passed in silence.
    """
    return [row for row in rows if not row.get("dri")]
