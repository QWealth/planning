"""Shapes for the Slack directory, which is a picker source and not a roster."""

from typing import Optional

from pydantic import BaseModel


class SlackPersonOut(BaseModel):
    """
    One person in the Slack workspace, as offered to an admin choosing who to invite.

    Deliberately NOT a PersonOut. Nobody here is on the team list - this is the list of
    people who could be, and conflating the two is exactly the mistake that would make
    the Team page fill up with names who have never signed in. The only field that
    crosses over is `on_roster`, which is a fact ABOUT the roster rather than a piece of
    it, and exists so the picker can show who is already set up instead of offering to
    invite them again.

    `email` is the identity; `slack_user_id` is only how we reach them. Both come from
    the same chosen person, which is the whole reason the picker exists - see
    app/slack.py.
    """

    slack_user_id: str
    name: str
    email: str
    avatar: str = ""
    title: str = ""
    is_guest: bool = False

    # Already has a roster row, so inviting them again would be a no-op and the picker
    # should say so rather than letting an admin discover it from the result.
    on_roster: bool = False


class SlackDirectoryOut(BaseModel):
    """
    The directory, plus enough context to explain an empty one.

    `people` being empty has two very different causes that look identical from the
    outside: a workspace with nobody in it, and a Slack app missing the
    `users:read.email` scope - which strips the address off every profile and so
    filters everybody out. `filtered` counts what was dropped, so the UI can say "42
    people were returned but none had an address readable by this app" instead of
    "no people found", which would send somebody looking in the wrong place entirely.
    """

    people: list[SlackPersonOut]
    filtered: int = 0

    # Set when Slack could not be reached or is not configured. The picker falls back
    # to a typed address rather than blocking the invite - Slack being down is not a
    # reason to be unable to give a colleague access.
    unavailable: Optional[str] = None
