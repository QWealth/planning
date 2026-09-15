"""
Who still needs to read which RFC, for the daily #request_for_comments post.

Pure, like digest.py and progress.py: deciding who is chased about what is the part
worth testing with dicts, and it is also the part that names real colleagues in a public
channel - which is a good reason for it to be readable on its own rather than tangled up
with Slack calls.

WHAT THIS CHASES, AND WHAT IT DELIBERATELY DOES NOT
---------------------------------------------------
Only RFCs in `review`. That status means "Open for comment. Waiting on the team", which
is the only state where chasing somebody is a fair thing to do. A draft is the author
still thinking; an accepted or rejected one is finished. Neither is anybody else's
problem yet or any more.

Only RFCs with skills tagged. An untagged RFC has no audience to derive, and chasing
everybody would be the fastest way to make the channel ignorable.

Only people who HOLD the skill - one star or more. `wants_to_learn` is appetite rather
than capability and is deliberately not matched: being publicly named as owing a review
because you once ticked a box saying you would like to learn something is not the deal
anybody thought they were making.

Only people who have not read it. That is the entire point, and it is why the read marks
are per person and stored server-side - a per-browser record would keep naming people who
had read the thing on a different machine.

FIVE WORKING DAYS, THEN IT STOPS
--------------------------------
A public daily mention is a strong instrument and an unbounded one is a worse one. After
a working week the RFC stays unread, the chase goes quiet, and the author chases in
person - which is what actually works by that point anyway.

Counted in WORKING days rather than calendar days, so an RFC opened on a Thursday is not
two-fifths spent before anybody is back at a keyboard.
"""

from datetime import date, timedelta
from typing import Any, Iterable, Optional

# How many working days an RFC is chased for after it opens for comment.
CHASE_WORKING_DAYS = 5

# The minimum stars that count as holding a skill. Zero means "wants to learn", which is
# recorded in a separate field and is not capability - see the module docstring.
MIN_STARS = 1


def parse_day(value: Any) -> Optional[date]:
    """
    The date part of a stored timestamp, or None.

    `review_since` is a full ISO timestamp; only the day matters for counting working
    days, and taking the first ten characters is both cheaper and more forgiving than
    parsing a datetime whose format has changed once already.
    """
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def working_days_since(start: date, today: date) -> int:
    """
    Working days from `start` to `today`, counting `today` and not `start`.

    So the day an RFC opens is 0, the next working day is 1, and a full working week
    later is 5. Negative when `today` is before `start`, which only happens if a clock
    is wrong somewhere - the caller treats that as "not yet" rather than "expired",
    because expiring something that has not started would silence it permanently.
    """
    if today < start:
        return -1
    days = 0
    cursor = start
    while cursor < today:
        cursor += timedelta(days=1)
        # Monday is 0, Sunday is 6.
        if cursor.weekday() < 5:
            days += 1
    return days


def holders(people: Iterable[dict[str, Any]], skills: Iterable[str]) -> list[str]:
    """
    Addresses of active people who hold at least one of `skills`.

    Matched on stars, not on the presence of an entry: somebody with a zero-star entry
    has recorded appetite, not capability, and the two live in one list precisely so
    they can be told apart here.
    """
    wanted = {s for s in skills if s}
    if not wanted:
        return []

    out: list[str] = []
    for person in people:
        if person.get("active") is False:
            continue
        email = (person.get("email") or "").strip().lower()
        if not email:
            continue
        for entry in person.get("specialisations") or []:
            if entry.get("skill") in wanted and (entry.get("stars") or 0) >= MIN_STARS:
                out.append(email)
                break
    return out


def unread_by(person: dict[str, Any], item_id: str) -> bool:
    """Whether this person has never opened this RFC."""
    return item_id not in (person.get("rfcs_read") or {})


def chase_targets(
    rfcs: Iterable[dict[str, Any]],
    people: Iterable[dict[str, Any]],
    today: date,
    review_status: str,
) -> list[dict[str, Any]]:
    """
    One entry per RFC that still needs chasing, with who to name.

    RFCs nobody is outstanding on are dropped rather than returned with an empty list,
    so the caller never has to decide whether an empty audience means "everybody has
    read it" (say nothing) or "nobody holds these skills" (also say nothing, but for a
    reason worth logging). Both are reported separately in the summary.

    `review_status` is passed in rather than imported so this module needs no knowledge
    of the status vocabulary beyond "the caller knows which one means open for comment".
    """
    roster = list(people)
    out: list[dict[str, Any]] = []

    for rfc in rfcs:
        if rfc.get("status") != review_status:
            continue

        skills = rfc.get("skills") or []
        if not skills:
            continue

        opened = parse_day(rfc.get("review_since"))
        if opened is None:
            # In review with no stamp: an RFC that predates the field, or one whose
            # transition was not recorded. Not chased, because there is no honest day
            # to count from and guessing one would either nag forever or never.
            continue

        elapsed = working_days_since(opened, today)
        if elapsed < 0 or elapsed > CHASE_WORKING_DAYS:
            continue

        audience = holders(roster, skills)
        by_email = {(p.get("email") or "").strip().lower(): p for p in roster}
        outstanding = [
            email
            for email in audience
            if email in by_email and unread_by(by_email[email], rfc["item_id"])
        ]
        if not outstanding:
            continue

        out.append(
            {
                "item_id": rfc["item_id"],
                "title": rfc.get("title") or "Untitled",
                "skills": list(skills),
                "outstanding": outstanding,
                "audience_size": len(audience),
                "working_days": elapsed,
                "days_left": CHASE_WORKING_DAYS - elapsed,
            }
        )

    return out
