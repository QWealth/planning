"""The Slack directory: what gets dropped, what gets said, and what must not fail.

Three separate concerns, and they fail in different directions:

  - `_as_person` DROPS things. Every bot, app and deactivated account in the workspace
    arrives in the same list as the colleagues, and one left in is offered in the picker
    as an invitable human - which would create a Cognito login on the shared pool for an
    integration. The tests here are mostly about what is absent from the output.

  - `_explain` says a SENTENCE. A missing `users:read.email` scope produces no Slack
    error at all: every profile simply arrives without an email, the list empties, and
    the picker looks like a workspace with nobody in it. The count and the wording are
    the only things that tell an admin what actually happened.

  - The ROUTE must not fail. Inviting by typing an address worked before Slack existed
    and still does, so a Slack outage has to degrade to that rather than take the invite
    UI down. The test that matters most is the one asserting 200 on a refusal.
"""

from typing import Any

import pytest

from app import config, invites, slack

FAKE_TOKEN = "xoxb-not-a-real-token"


# --------------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------------


class _Response:
    """Just enough of httpx.Response for `_call`."""

    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def json(self) -> dict:
        return self._payload


@pytest.fixture(autouse=True)
def _token(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    A token from the environment, and a cold cache around every test.

    `reset_cache` runs on the way OUT as well as in: the directory cache is a module
    global with a five-minute TTL, so one test's fake workspace would otherwise be
    served to the next one - which passes, and passes for the wrong reason.
    """
    monkeypatch.setattr(config, "SLACK_BOT_TOKEN", FAKE_TOKEN)
    slack.reset_cache()
    yield
    slack.reset_cache()


def _member(**overrides: Any) -> dict:
    """A `users.list` member: a plain human unless something is overridden."""
    profile = {"real_name_normalized": "Piper Chen", "email": "piper@qwealth.com"}
    profile.update(overrides.pop("profile", {}))
    member = {"id": "U123", "name": "piper", "profile": profile}
    member.update(overrides)
    return member


def _pages(monkeypatch: pytest.MonkeyPatch, *payloads: dict) -> list:
    """
    Serve `payloads` to successive users.list calls, recording the params of each.

    Returns the recording list, so a test can assert on the cursor that was actually
    sent - the thing a pagination bug gets wrong, and the thing an assertion on the
    merged result cannot see.
    """
    calls: list = []
    remaining = list(payloads)

    def _get(url: str, **kwargs: Any) -> _Response:
        calls.append(kwargs.get("params") or {})
        return _Response(remaining.pop(0) if remaining else {"ok": True, "members": []})

    monkeypatch.setattr(slack.httpx, "get", _get)
    return calls


# --------------------------------------------------------------------------------
# _as_person: what never reaches the picker
# --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "member,why",
    [
        (_member(is_bot=True), "a bot"),
        (_member(is_app_user=True), "an app"),
        (_member(deleted=True), "a deactivated account"),
        (_member(id="USLACKBOT"), "Slackbot itself"),
        (_member(profile={"email": ""}), "somebody with no address"),
        (_member(profile={"email": "   "}), "an address that is only whitespace"),
    ],
)
def test_things_that_are_not_invitable_colleagues_are_dropped(
    member: dict, why: str
) -> None:
    """
    Each of these would otherwise be offered as a person to invite, and inviting one
    creates a real Cognito account on a pool shared with the compliance tool.
    """
    assert slack._as_person(member) is None, f"{why} was not dropped"


def test_a_guest_is_kept_and_flagged() -> None:
    """
    Contractors legitimately appear on a roadmap. Hiding them would be a decision
    about who counts as staff, made silently in a filter - so they are kept, marked,
    and the person doing the inviting decides.
    """
    guest = slack._as_person(_member(is_restricted=True))
    assert guest is not None
    assert guest["is_guest"] is True


def test_an_ultra_restricted_guest_counts_as_a_guest_too() -> None:
    """Slack has two flavours of guest and only ever sets one of them."""
    assert slack._as_person(_member(is_ultra_restricted=True))["is_guest"] is True


def test_the_address_is_lowercased() -> None:
    """
    It becomes the roster key and the Cognito username, both of which are lowercase
    everywhere else in this codebase. A capital letter here would create a second row
    for somebody who already has one.
    """
    person = _member(profile={"email": "Piper@QWealth.com"})
    assert slack._as_person(person)["email"] == "piper@qwealth.com"


@pytest.mark.parametrize(
    "profile,expected",
    [
        ({"real_name_normalized": "Piper Chen"}, "Piper Chen"),
        ({"real_name": "Piper Chen"}, "Piper Chen"),
        ({"display_name_normalized": "piper.c"}, "piper.c"),
        ({}, "piper"),
    ],
)
def test_the_name_falls_back_through_slacks_several_names(
    profile: dict, expected: str
) -> None:
    """
    Slack has three name fields and populates them inconsistently per workspace. A
    picker row with a blank label is unusable, so each is tried in turn.
    """
    profile = {"email": "piper@qwealth.com", **profile}
    member = {"id": "U1", "name": "piper", "profile": profile}
    assert slack._as_person(member)["name"] == expected


def test_the_address_is_the_last_resort_name() -> None:
    """Better a row labelled by address than a row labelled by nothing."""
    member = {"id": "U1", "profile": {"email": "piper@qwealth.com"}}
    assert slack._as_person(member)["name"] == "piper@qwealth.com"


# --------------------------------------------------------------------------------
# _call: Slack's 200-means-nothing convention
# --------------------------------------------------------------------------------


def test_a_refusal_arrives_as_http_200_and_must_still_raise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    THE trap in this API. Slack answers 200 OK for failure and puts the outcome in
    `ok`, so a client that checks the status code treats a missing scope as an empty
    workspace - no error, no log, just nobody to invite.
    """
    monkeypatch.setattr(
        slack.httpx,
        "get",
        lambda *a, **k: _Response({"ok": False, "error": "missing_scope"}),
    )
    with pytest.raises(slack.SlackError):
        slack._call("users.list")


def test_a_genuine_http_error_raises_too(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(slack.httpx, "get", lambda *a, **k: _Response({}, 503))
    with pytest.raises(slack.SlackError) as refused:
        slack._call("users.list")
    assert "503" in str(refused.value)


def test_a_timeout_says_the_invite_was_not_delivered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Not the same as Slack saying no. The admin must not be told their invite was
    refused when it was never actually asked for.
    """

    def _boom(*args: Any, **kwargs: Any) -> None:
        raise slack.httpx.ConnectTimeout("too slow")

    monkeypatch.setattr(slack.httpx, "get", _boom)
    with pytest.raises(slack.SlackError) as refused:
        slack._call("users.list")
    assert "not delivered" in str(refused.value)


def test_the_missing_scope_message_names_all_three_scopes_and_the_reinstall() -> None:
    """
    The single most useful sentence in this module. A scope added in the Slack admin
    UI does nothing until the app is REINSTALLED, which is not obvious and is the step
    everybody misses - so the error has to say it rather than just naming the scope.
    """
    said = slack._explain("missing_scope", "users.list")
    assert "users:read" in said
    assert "users:read.email" in said
    assert "chat:write" in said
    assert "REINSTALL" in said


def test_an_unknown_error_code_is_still_reported_verbatim() -> None:
    """
    Slack adds error codes without warning. An unrecognised one has to reach the admin
    intact - "Slack refused the request" with the code missing is unactionable.
    """
    assert "some_new_code" in slack._explain("some_new_code", "users.list")


# --------------------------------------------------------------------------------
# list_people
# --------------------------------------------------------------------------------


def test_seen_counts_what_slack_returned_not_what_survived(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    The reason `list_people` returns a dict rather than a list.

    A workspace with nobody in it and a workspace whose every profile was dropped for
    having no email - which is exactly what a missing `users:read.email` scope looks
    like - produce an identical empty list. `seen` is the only thing that tells them
    apart, and the route turns it into the `filtered` count.
    """
    _pages(
        monkeypatch,
        {
            "ok": True,
            "members": [
                _member(id="U1"),
                _member(id="U2", is_bot=True),
                _member(id="U3", profile={"email": ""}),
            ],
        },
    )
    directory = slack.list_people()
    assert directory["seen"] == 3
    assert len(directory["people"]) == 1


def test_every_page_is_followed(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    A workspace over 200 members arrives in pages. Stopping at the first one would
    work in a small workspace and quietly lose people in a growing one - the kind of
    bug that ships because the test workspace is small.
    """
    calls = _pages(
        monkeypatch,
        {
            "ok": True,
            "members": [_member(id="U1", profile={"email": "a@qwealth.com"})],
            "response_metadata": {"next_cursor": "page2"},
        },
        {"ok": True, "members": [_member(id="U2", profile={"email": "b@qwealth.com"})]},
    )
    directory = slack.list_people()

    assert directory["seen"] == 2
    assert {p["email"] for p in directory["people"]} == {"a@qwealth.com", "b@qwealth.com"}
    # The second request must actually carry the cursor; a page loop that refetches
    # page one forever also returns two people the first time it is run.
    assert calls[1]["cursor"] == "page2"


def test_an_empty_cursor_ends_the_walk(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Slack signals the end with an empty STRING, not by omitting the key. Treating that
    as a cursor requests page one again, forever, until the Lambda times out.
    """
    calls = _pages(
        monkeypatch,
        {"ok": True, "members": [_member()], "response_metadata": {"next_cursor": ""}},
    )
    slack.list_people()
    assert len(calls) == 1


def test_people_come_back_in_name_order(monkeypatch: pytest.MonkeyPatch) -> None:
    """A picker in Slack's arbitrary order is a picker nobody can find a name in."""
    _pages(
        monkeypatch,
        {
            "ok": True,
            "members": [
                _member(id="U1", profile={"real_name_normalized": "zoe"}),
                _member(id="U2", profile={"real_name_normalized": "Adam"}),
                _member(id="U3", profile={"real_name_normalized": "mary"}),
            ],
        },
    )
    names = [p["name"] for p in slack.list_people()["people"]]
    assert names == ["Adam", "mary", "zoe"]


def test_the_directory_is_cached_between_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Two admins with the Team page open must not re-list the workspace on every render;
    `users.list` is Tier-2 rate limited and the roster changes when somebody is hired.
    """
    calls = _pages(monkeypatch, {"ok": True, "members": [_member()]})
    slack.list_people()
    slack.list_people()
    assert len(calls) == 1


def test_force_bypasses_the_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _pages(
        monkeypatch,
        {"ok": True, "members": [_member()]},
        {"ok": True, "members": [_member()]},
    )
    slack.list_people()
    slack.list_people(force=True)
    assert len(calls) == 2


# --------------------------------------------------------------------------------
# The route
# --------------------------------------------------------------------------------


def test_the_directory_flags_who_is_already_on_the_roster(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    The picker's whole job beyond listing names. Without this an admin re-invites
    somebody who has been using the app for months, which does nothing and looks
    exactly like it worked.
    """
    client.post(
        "/api/people",
        json={"email": "piper@qwealth.com", "name": "Piper", "roles": ["software-engineer"]},
    )
    monkeypatch.setattr(
        slack,
        "list_people",
        lambda: {
            "people": [
                slack._as_person(_member(id="U1")),
                slack._as_person(
                    _member(id="U2", profile={"email": "newbie@qwealth.com"})
                ),
            ],
            "seen": 2,
        },
    )

    body = client.get("/api/slack/people").json()
    by_email = {p["email"]: p for p in body["people"]}
    assert by_email["piper@qwealth.com"]["on_roster"] is True
    assert by_email["newbie@qwealth.com"]["on_roster"] is False


def test_a_deactivated_person_still_counts_as_on_the_roster(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    They have a row; the roadmap has not forgotten them. Offering them as a fresh
    invite would be wrong twice - the invite is a no-op, and it implies otherwise.
    """
    client.post(
        "/api/people",
        json={"email": "piper@qwealth.com", "name": "Piper", "roles": ["software-engineer"]},
    )
    client.post("/api/people/piper@qwealth.com/deactivate")
    monkeypatch.setattr(
        slack,
        "list_people",
        lambda: {"people": [slack._as_person(_member())], "seen": 1},
    )

    assert client.get("/api/slack/people").json()["people"][0]["on_roster"] is True


def test_filtered_reports_how_many_were_dropped(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    A workspace of forty people showing an empty picker is a missing scope, not an
    empty workspace, and this number is what lets the UI say so.
    """
    monkeypatch.setattr(slack, "list_people", lambda: {"people": [], "seen": 40})
    assert client.get("/api/slack/people").json()["filtered"] == 40


def test_slack_being_down_does_not_take_the_invite_ui_with_it(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    THE most important test in this file.

    Inviting by typing an address is what the app did before Slack and still works. A
    5xx here would make the picker's failure the whole panel's failure, so losing a
    third party would cost the ability to grant a colleague access - which is a far
    worse outcome than losing a convenience.
    """

    def _down() -> None:
        raise slack.SlackError("Slack did not respond.")

    monkeypatch.setattr(slack, "list_people", _down)

    answered = client.get("/api/slack/people")
    assert answered.status_code == 200
    body = answered.json()
    assert body["people"] == []
    assert body["unavailable"] == "Slack did not respond."


def test_an_unconfigured_deployment_is_not_an_error_either(client) -> None:
    """
    No secret and no token: the directory is simply unavailable, reported the same way
    as an outage. `_token` is cold because of the autouse fixture, so this exercises
    the real `_bot_token` path rather than a stub.
    """
    import app.config as cfg

    original_secret, original_token = cfg.SLACK_SECRET_NAME, cfg.SLACK_BOT_TOKEN
    cfg.SLACK_SECRET_NAME, cfg.SLACK_BOT_TOKEN = "", ""
    slack.reset_cache()
    try:
        body = client.get("/api/slack/people").json()
    finally:
        cfg.SLACK_SECRET_NAME, cfg.SLACK_BOT_TOKEN = original_secret, original_token
        slack.reset_cache()

    assert body["people"] == []
    assert "not configured" in body["unavailable"]


def test_the_directory_is_admin_only(aws, monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Every colleague's email address in one response. Not secret inside the company,
    but not something to hand to every account on a pool shared with another tool.
    """
    from fastapi.testclient import TestClient

    from app import auth
    from app.main import app

    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", True)
    monkeypatch.setattr(auth, "DEV_ADMIN", False)
    monkeypatch.setattr(config, "ENFORCE_GROUP", True)

    assert TestClient(app).get("/api/slack/people").status_code == 403


# --------------------------------------------------------------------------------
# Delivering the invitation
# --------------------------------------------------------------------------------


@pytest.fixture
def invited(aws, monkeypatch: pytest.MonkeyPatch):
    """`perform_invite` with Cognito replaced - the pool is shared and real."""

    def _invite_user(email: str) -> dict:
        return {"email": email.lower(), "account_created": True, "group_added": True}

    monkeypatch.setattr(invites.cognito, "invite_user", _invite_user)
    return invites


def test_picking_from_slack_delivers_the_message_as_a_dm(
    invited, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    The point of the whole feature. Without a Slack id the admin is handed the text to
    copy and paste somewhere; with one, the person is simply told.
    """
    sent: list = []
    monkeypatch.setattr(slack, "dm", lambda uid, text: sent.append((uid, text)))

    result = invited.perform_invite(
        "piper@qwealth.com", actor="admin@qwealth.com", slack_user_id="U123"
    )

    assert result["dm_sent"] is True
    assert result["dm_error"] is None
    assert sent[0][0] == "U123"
    # The DM carries the real message, not a summary of it - including the sentence
    # about the compliance-branded password email, which is why the message exists.
    assert "QWealth Marketing Compliance Review" in sent[0][1]


def test_a_typed_address_still_hands_the_message_back(invited) -> None:
    """The path that existed before Slack, unchanged. No id, no DM, message returned."""
    result = invited.perform_invite("piper@qwealth.com", actor="admin@qwealth.com")
    assert result["dm_sent"] is False
    assert result["dm_error"] is None
    assert "Planning Roadmap" in result["message"]


def test_a_failed_dm_does_not_fail_the_invite(
    invited, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    The Cognito account already exists by the time the DM is attempted. Raising here
    would report "invite failed" for something that half-succeeded, and the admin
    would retry into an account that is already there.
    """

    def _refuse(uid: str, text: str) -> None:
        raise slack.SlackError("Slack would not open a DM with that person.")

    monkeypatch.setattr(slack, "dm", _refuse)

    result = invited.perform_invite(
        "piper@qwealth.com", actor="admin@qwealth.com", slack_user_id="U123"
    )

    assert result["account_created"] is True
    assert result["dm_sent"] is False
    assert "would not open a DM" in result["dm_error"]
    # And the caller still gets the text, so the copy-and-paste path is available.
    assert "Planning Roadmap" in result["message"]


def test_somebody_already_on_the_roster_is_not_dmed(
    invited, client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    They have been using the app for months. A fresh "you've been added" is a
    confusing message about an account they already have - same rule the Slack
    command follows.
    """
    client.post(
        "/api/people",
        json={"email": "piper@qwealth.com", "name": "Piper", "roles": ["software-engineer"]},
    )
    sent: list = []
    monkeypatch.setattr(slack, "dm", lambda uid, text: sent.append(uid))

    result = invited.perform_invite(
        "piper@qwealth.com", actor="admin@qwealth.com", slack_user_id="U123"
    )

    assert result["onboarded"] is True
    assert result["dm_sent"] is False
    assert sent == []


def test_the_audit_row_records_whether_it_was_delivered(
    invited, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    "Invited" and "invited and told" are different events, and the difference is
    invisible months later unless it was written down at the time.
    """
    monkeypatch.setattr(slack, "dm", lambda uid, text: None)
    recorded: list = []
    monkeypatch.setattr(
        invites.audit, "record", lambda **kwargs: recorded.append(kwargs)
    )

    invited.perform_invite(
        "piper@qwealth.com", actor="admin@qwealth.com", slack_user_id="U123"
    )

    assert recorded[0]["after"]["dm_sent"] is True
    assert recorded[0]["user_email"] == "admin@qwealth.com"
