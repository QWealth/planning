"""
Drawing the progress nudge as Block Kit.

Separate from progress.py (which decides who is asked what) and from notifications.py
(which sends), so this module makes no decisions and performs no IO. It turns one
person's grouped rows into the JSON Slack renders, and can be asserted on directly in a
test without a Slack workspace.

WHY A BUTTON PER PROJECT
------------------------
Three shapes were mocked up and sent to a real Slack client before choosing. One button
for everything opens a modal that grows with the person - the largest holder on the
current board has 13 open phases - and offers no way to deal with one project and
ignore the rest, which is the normal case. A dropdown per phase directly in the message
needs no modal at all and is the fewest taps, but each selection writes immediately, so
there is no Cancel and a mis-tap on a phone goes straight into the roadmap.

Per project keeps each modal short, makes partial updates natural, and keeps every
write behind an explicit submit.

WHAT THE BUTTON CARRIES
-----------------------
Everything the modal needs, in the button's `value`. The alternative is for Aardvark to
read the phases back out of the roadmap, which would mean a second service route and a
second IAM grant to maintain - for data this message already has in its hand.

Slack caps `value` at 2000 characters, so the payload uses short keys and is checked
rather than hoped about. See MAX_VALUE below.
"""

import json
from typing import Any, Optional

# Slack's hard limit on a button's `value`. Exceeding it is a 400 from chat.postMessage
# that names the block but not the reason, so this is checked here where the payload is
# built and the phase names that caused it are still in scope.
MAX_VALUE = 2000

# Left for the truncation note and a little slack around JSON punctuation.
VALUE_BUDGET = 1800

ACTION_UPDATE = "roadmap_progress_update"


def percent(progress: Optional[float]) -> str:
    """
    A phase's progress, as a person would say it.

    None renders as "not recorded" and NOT as 0%. They are different facts - one is
    "nobody has said", the other is "started, nothing done" - and the whole point of
    this message is to turn the first into the second or better. Drawing them the same
    would hide exactly the phases most worth asking about.
    """
    if progress is None:
        return "not recorded"
    return f"{round(progress * 100)}%"


def button_value(project_id: str, rows: list[dict[str, Any]]) -> str:
    """
    The modal's input data, packed for the button.

    Short keys because the budget is small and the names inside it are not ours to
    shorten. If the payload still will not fit, phases are dropped from the END rather
    than the message failing to send: a nudge listing six of a person's seven phases is
    worth far more than no nudge, and the roadmap remains the place to edit the rest.
    """
    packed = [
        {"i": row["phase_id"], "n": row["phase_name"], "p": row["progress"]} for row in rows
    ]

    while packed:
        value = json.dumps({"pid": project_id, "ph": packed}, separators=(",", ":"))
        if len(value) <= VALUE_BUDGET:
            return value
        packed.pop()

    # Every phase name on its own blew the budget, which needs a 1700-character name.
    # Send the project with no phases rather than an oversized value; the handler shows
    # "open the roadmap" for an empty list.
    return json.dumps({"pid": project_id, "ph": []}, separators=(",", ":"))


def phase_lines(rows: list[dict[str, Any]]) -> str:
    """One bullet per phase. mrkdwn, so the percentage is the bold part people scan."""
    return "\n".join(f"• {row['phase_name']} — *{percent(row['progress'])}*" for row in rows)


def compose_nudge(
    name: Optional[str],
    grouped: dict[str, list[dict[str, Any]]],
    project_ids: dict[str, str],
) -> Optional[list[dict[str, Any]]]:
    """
    One person's nudge. Returns None when they have nothing open.

    None rather than an empty message, for the same reason compose_digest returns "":
    a weekly DM saying "you have nothing to update" is a notification that teaches
    people to ignore the channel, and the absence already says it.

    `project_ids` maps project name to id, because the grouping is by name (which is
    what the message shows) while the button needs the id (which is what the write
    needs). Passing both avoids re-deriving either from the other.
    """
    if not grouped:
        return None

    greeting = f"Morning {name}" if name else "Morning"
    blocks: list[dict[str, Any]] = [
        {
            "type": "header",
            # plain_text, and Slack caps a header at 150 characters. A first name plus
            # this sentence cannot approach that, but the cap is why the greeting is
            # here and the detail is in the context line below.
            "text": {"type": "plain_text", "text": f"{greeting} — where has your work got to?"},
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": "Updating these keeps the roadmap honest. Anything you skip stays as it is.",
                }
            ],
        },
        {"type": "divider"},
    ]

    for project_name, rows in grouped.items():
        project_id = project_ids.get(project_name, "")
        blocks.append(
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*{project_name}*\n{phase_lines(rows)}",
                },
            }
        )
        blocks.append(
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        # Slack caps button text at 75 characters, and project names are
                        # user-supplied. Truncated here rather than letting the API
                        # reject the whole message over a long lane name.
                        "text": {
                            "type": "plain_text",
                            "text": f"Update {project_name}"[:75],
                        },
                        "action_id": f"{ACTION_UPDATE}::{project_id}",
                        "value": button_value(project_id, rows),
                        "style": "primary",
                    }
                ],
            }
        )

    # Says why they were asked. Somebody chased about a phase they do not own should
    # be able to see it reached them as the lane's DRI rather than by mistake.
    if any(row.get("basis") == "dri" for rows in grouped.values() for row in rows):
        blocks.append(
            {
                "type": "context",
                "elements": [
                    {
                        "type": "mrkdwn",
                        "text": "Some of these have no owner recorded, so they come to you as the project's DRI.",
                    }
                ],
            }
        )

    return blocks


def fallback_text(name: Optional[str], count: int) -> str:
    """
    The notification line, which is what shows on a lock screen and in the sidebar.

    Required by chat.postMessage whenever blocks are sent - without it Slack pushes a
    notification reading "This content can't be displayed", which is how a useful
    message looks broken before anybody has opened it.
    """
    who = f"{name}, you" if name else "You"
    phases = "phase" if count == 1 else "phases"
    return f"{who} have {count} open {phases} to update on the roadmap."


# --------------------------------------------------------------- the review chase
#
# The daily post to #request_for_comments. A channel message rather than a DM, so it is
# drawn to be readable by people it does NOT name as well as by those it does - somebody
# scrolling past should be able to see which proposals are waiting and for how long,
# without having to work out whether they are being asked for something.


def chase_line(entry: dict[str, Any], mentions: list[str], app_url: str) -> str:
    """
    One RFC's line: what it is, who it is waiting on, and how long it has left.

    The remaining days are stated because the chase stops after a working week, and a
    reminder that will silently give up is worse than one that says so - "two days left"
    is actionable in a way that an indefinite nag stops being by about day three.
    """
    skills = ", ".join(entry["skills"])
    left = entry["days_left"]
    when = "last day" if left <= 0 else f"{left} working day{'' if left == 1 else 's'} left"
    link = f"{app_url}/rfcs/{entry['item_id']}"
    who = " ".join(mentions) if mentions else "_nobody findable in Slack_"
    return f"*<{link}|{entry['title']}>*\n{skills} · {when}\n{who}"


def compose_chase(
    entries: list[dict[str, Any]],
    mentions_for: dict[str, list[str]],
    app_url: str,
) -> Optional[list[dict[str, Any]]]:
    """
    The whole post, or None when nothing is outstanding.

    None rather than "all clear", deliberately. A daily message into a channel saying
    there is nothing to do is the fastest way to make the channel muted, and a quiet
    channel already says it.

    `mentions_for` maps item_id to the already-resolved `<@U…>` strings, so this stays
    free of the email-to-Slack-id join and can be asserted on directly.
    """
    if not entries:
        return None

    proposals = "proposal" if len(entries) == 1 else "proposals"
    blocks: list[dict[str, Any]] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"{len(entries)} {proposals} waiting on a read"},
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": (
                        "You are named because you hold one of the skills the proposal is "
                        "tagged with and have not opened it yet. Opening it is enough to "
                        "stop the reminder."
                    ),
                }
            ],
        },
        {"type": "divider"},
    ]

    for entry in entries:
        blocks.append(
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": chase_line(entry, mentions_for.get(entry["item_id"], []), app_url),
                },
            }
        )

    return blocks


def chase_fallback(entries: list[dict[str, Any]]) -> str:
    """The notification line. Names nothing - the channel list is enough on a badge."""
    proposals = "proposal" if len(entries) == 1 else "proposals"
    return f"{len(entries)} {proposals} on the roadmap still need a read."


# ----------------------------------------------------- the milestone day-of check
#
# A DM to one person on the day their milestone was due, asking whether it landed. Two
# buttons rather than a modal-first flow, because the common answer is "yes" and that
# should cost one tap; the "not yet" path opens a modal for the reason, which is the
# only part anybody has to type.
#
# WHY THE QUESTION IS ASKED PER MILESTONE AND NOT PER MESSAGE
#
# The progress nudge batches a project's phases behind one button because its answers
# are numbers on a form and thirteen of them in one modal is still one task. These
# answers are not: each is a yes/no with a different story behind it, and a single
# "update all of these" button would force somebody who knows about one deadline to
# take a position on the other two. Per milestone, each can be answered or left.

ACTION_MILESTONE_DONE = "roadmap_milestone_done"
ACTION_MILESTONE_MISSED = "roadmap_milestone_missed"


def milestone_value(row: dict[str, Any]) -> str:
    """
    What the button hands back: enough to write the answer without a second read.

    The name and due date ride along because the log row records them as they stood
    when the question was asked. A milestone renamed or rescheduled a week later must
    not silently rewrite the history of what somebody was asked - the log is a record of
    a conversation, not a view onto current state.

    Short keys for the same 2000-character budget button_value documents. There is no
    truncation loop here because one milestone cannot approach the cap: a name would
    have to be 1900 characters, and the name field is capped long before that.
    """
    return json.dumps(
        {
            "pid": row["project_id"],
            "mid": row["milestone_id"],
            "n": row["milestone_name"],
            "d": row["due"],
        },
        separators=(",", ":"),
    )[:MAX_VALUE]


def milestone_line(row: dict[str, Any]) -> str:
    """One milestone's text: what it was, on which lane, and when it was due."""
    when = "was due" if row.get("late") else "is due"
    return f"*{row['milestone_name']}*\n{row['project_name']} · {when} {row['due']}"


def compose_milestone_check(
    name: Optional[str],
    rows: list[dict[str, Any]],
) -> Optional[list[dict[str, Any]]]:
    """
    One person's day-of questions. None when they have none.

    None rather than an empty message, for the third time in this file and the same
    reason: a daily DM saying "nothing was due today" is how a bot becomes something
    people filter, and most days most people have nothing due.
    """
    if not rows:
        return None

    greeting = f"Hi {name}" if name else "Hi"
    count = len(rows)
    noun = "milestone" if count == 1 else "milestones"
    blocks: list[dict[str, Any]] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"{greeting} — did {'it' if count == 1 else 'these'} land?"},
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": (
                        f"You are the DRI on {count} {noun} dated for today or over the "
                        "weekend. *Yes* ticks it off on the roadmap; *not yet* asks what "
                        "held it up."
                    ),
                }
            ],
        },
        {"type": "divider"},
    ]

    for row in rows:
        value = milestone_value(row)
        blocks.append(
            {"type": "section", "text": {"type": "mrkdwn", "text": milestone_line(row)}}
        )
        blocks.append(
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "Yes, it's done"},
                        # The milestone id is in the action_id as well as in the value,
                        # so two questions in one message cannot be told apart only by a
                        # payload the handler has to parse before it knows which is which.
                        "action_id": f"{ACTION_MILESTONE_DONE}::{row['milestone_id']}",
                        "value": value,
                        "style": "primary",
                    },
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "Not yet"},
                        "action_id": f"{ACTION_MILESTONE_MISSED}::{row['milestone_id']}",
                        "value": value,
                    },
                ],
            }
        )

    blocks.append(
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    # Said out loud because the answer is kept, and somebody typing a
                    # reason deserves to know it is written down and who reads it. A log
                    # nobody was told about is the kind of thing people find out about
                    # later and resent.
                    "text": (
                        "Answers are recorded on the roadmap so the team can see what "
                        "moved and why. Business analysts can read the log."
                    ),
                }
            ],
        }
    )

    return blocks


def milestone_fallback(name: Optional[str], count: int) -> str:
    """The lock-screen line. Required whenever blocks are sent - see fallback_text."""
    lead = f"{name}, " if name else ""
    if count == 1:
        return f"{lead}a milestone was due — did it land?"
    return f"{lead}{count} milestones were due — did they land?"
