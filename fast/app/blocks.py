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
