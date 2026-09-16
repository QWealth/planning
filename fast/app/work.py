"""
The vocabulary for the two things that are not on the Gantt: RFCs and tasks.

Closed lists, for the same reason roles.py and skills.py are closed. Free-text status
gives you "done", "Done", "complete" and "finished" as four strings and one state, and
every board column built on it is quietly wrong.

Imports nothing from the app, so it cannot cycle - db/models.py and schemas/work.py
both import it, which is what stops the stored values and the validated values from
drifting apart.

WHY ONE KIND FOR TICKETS AND TASKS
----------------------------------
There is no Ticket. A ticket is a task that has children; a subtask is a task that has
a parent; a loose to-do is a task with neither. `parent_id` is the whole difference,
and it is nullable, so "a task not related to a ticket" is null rather than a second
entity with ninety percent of the same fields.

The nesting is capped at ONE level and queries/work.py enforces it in both directions:
a task with a parent may not become a parent, and a task with children may not be
given one. That is not a limitation anyone will hit - nobody asked for a tree - and it
buys something real: cycles become impossible by construction rather than by a check
that has to be right every time. Arbitrary depth would also mean unbounded recursion
in whatever renders the board.

A PARENT'S STATUS IS NOT DERIVED FROM ITS CHILDREN
--------------------------------------------------
Deliberately. It is the same argument as `Milestone.done` being independent of
`Milestone.date`: the interesting state is precisely the one where the two disagree.
"All five subtasks are done and the ticket is still open" is a real and common
situation - something was missed, or the parent needs sign-off - and deriving the
parent would erase exactly the signal worth having.

NOTE ON FIELD NAMING
--------------------
The date fields are `decided_on` and `due`, never `date`. Naming a pydantic field
after its own type cost this codebase a debugging round once already - see the
Milestone section of CLAUDE.md - because Python binds the assignment before the
annotation resolves, so `date: Optional[date] = None` builds a field of type
NoneType that 422s every real date. Avoided here by not using the word.
"""

from enum import Enum
from typing import Any


class Kind(str, Enum):
    """
    What a row in the work table is.

    Stored as the partition key of the kind-updated-index GSI, so these values are
    load-bearing and renaming one is a data migration, not a rename.
    """

    RFC = "rfc"
    TASK = "task"
    # One answer to one day-of milestone question. A third kind in this table rather
    # than a fourth table, because it is exactly what this table is for: a row with an
    # id, a kind and a timestamp, read back by kind off the existing GSI. A separate
    # table would be a second set of IAM grants, a second CDK construct and a second
    # thing to keep in step, for a shape this one already serves.
    MILESTONE_CHECK = "milestone-check"


class RfcStatus(str, Enum):
    """
    Where a proposal is in its life.

    `withdrawn` is separate from `rejected` on purpose: "the author stopped pursuing
    this" and "the team considered it and said no" are different pieces of history,
    and collapsing them loses the one that tells you whether the idea can be raised
    again.

    There is no `superseded`. It is a real RFC state, but it is only meaningful
    alongside a pointer to the successor - a status saying "replaced" without saying
    "by what" sends the reader searching. Adding it later is one enum value plus one
    nullable `superseded_by` field, which is why it is being left out rather than
    half-built.
    """

    DRAFT = "draft"
    REVIEW = "review"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    WITHDRAWN = "withdrawn"


class TaskStatus(str, Enum):
    """
    Where a piece of work is.

    `dropped` is separate from `done` for the same reason `missed` and `met` are
    separate on a milestone: closing something because it shipped and closing it
    because the team decided not to do it are opposite outcomes, and a board that
    shows both as "closed" reports a team hitting every target it abandoned.
    """

    BACKLOG = "backlog"
    NEXT = "next"
    IN_PROGRESS = "in-progress"
    DONE = "done"
    DROPPED = "dropped"


# Presentation only. Kept out of the enums so that renaming what the UI says never
# rewrites a stored value - the same split roles.py uses.
RFC_LABELS: dict[str, str] = {
    RfcStatus.DRAFT: "Draft",
    RfcStatus.REVIEW: "In review",
    RfcStatus.ACCEPTED: "Accepted",
    RfcStatus.REJECTED: "Rejected",
    RfcStatus.WITHDRAWN: "Withdrawn",
}

RFC_DESCRIPTIONS: dict[str, str] = {
    RfcStatus.DRAFT: "Being written. Not asking anyone for a decision yet.",
    RfcStatus.REVIEW: "Open for comment. Waiting on the team.",
    RfcStatus.ACCEPTED: "Decided yes. This is what we are doing.",
    RfcStatus.REJECTED: "Considered and declined. The reasoning is the point.",
    RfcStatus.WITHDRAWN: "The author pulled it. Not a decision against it.",
}

TASK_LABELS: dict[str, str] = {
    TaskStatus.BACKLOG: "Backlog",
    TaskStatus.NEXT: "Next",
    TaskStatus.IN_PROGRESS: "In progress",
    TaskStatus.DONE: "Done",
    TaskStatus.DROPPED: "Dropped",
}

TASK_DESCRIPTIONS: dict[str, str] = {
    TaskStatus.BACKLOG: "Captured so it is not lost. Not scheduled.",
    TaskStatus.NEXT: "Queued up. Starting soon.",
    TaskStatus.IN_PROGRESS: "Somebody is on it now.",
    TaskStatus.DONE: "Finished.",
    TaskStatus.DROPPED: "Decided against. Not the same as done.",
}

# The statuses that mean "no longer on anyone's plate". Named once here rather than
# spelled out at each call site, so a sixth status cannot be added and silently left
# out of one board's filter but not another's.
RFC_CLOSED = frozenset({RfcStatus.ACCEPTED, RfcStatus.REJECTED, RfcStatus.WITHDRAWN})
TASK_CLOSED = frozenset({TaskStatus.DONE, TaskStatus.DROPPED})


def rfc_catalogue() -> list[dict[str, Any]]:
    """
    The RFC status vocabulary as the API serves it, in lifecycle order.

    `closed` travels with each entry rather than being left for the client to work
    out. The frontend needs it - a live proposal and a retired one should not look
    alike on a list - and the only way to know without being told is to hardcode the
    three closed values, which would put a second copy of RFC_CLOSED in another
    language and another repo. A sixth status added here would then be open
    everywhere the backend says so, and silently open on screen too.
    """
    return [
        {
            "status": s.value,
            "label": RFC_LABELS[s],
            "description": RFC_DESCRIPTIONS[s],
            "closed": s in RFC_CLOSED,
        }
        for s in RfcStatus
    ]


def task_catalogue() -> list[dict[str, Any]]:
    """The task status vocabulary as the API serves it, in board order."""
    return [
        {
            "status": s.value,
            "label": TASK_LABELS[s],
            "description": TASK_DESCRIPTIONS[s],
            "closed": s in TASK_CLOSED,
        }
        for s in TaskStatus
    ]
