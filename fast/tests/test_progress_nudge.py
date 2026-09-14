"""
The Monday/Wednesday progress nudge: who is asked about what, and what a submit writes.

THE THREE THINGS WORTH GUARDING
-------------------------------
1. WHAT COUNTS AS OPEN. `progress is None` and `progress == 0.0` are different facts -
   "nobody has said" versus "started, nothing done" - and the whole feature exists to
   turn the first into a real answer. A selection that treated unknown as done would
   skip precisely the phases most worth asking about, and the message would look
   perfectly reasonable while doing it.

2. WHO IS ASKED. Owner first, project DRI where nobody owns the phase. Measured against
   the live board, owner-only reaches 28 of 58 open phases and the fallback reaches 54,
   so this is not a stylistic preference: it is the difference between a nudge that
   covers the roadmap and one that quietly covers half of it.

3. THE CLAIM PERIOD IS A DAY, NOT A WEEK. This runs twice a week. A weekly claim - which
   is what the digest uses and what a copy-paste would have inherited - would let
   Monday's send silence Wednesday's, and the symptom is a Wednesday that is simply
   quiet with nothing anywhere saying why.

The service route's own tests are at the bottom. The interesting question there is not
"does it write" but "who does the audit trail say did it", because that is the one thing
this door does differently from /api/service/invite.
"""

from datetime import date
from typing import Optional

import pytest

from app import auth, blocks, config, notifications, progress, slack
from app.db.queries import audit, people as people_q, projects as projects_q

MONDAY = date(2026, 9, 7)
WEDNESDAY = date(2026, 9, 9)

AARDVARK_ROLE = "arn:aws:iam::778983355679:role/AardvarkTaskRole"
AARDVARK_SESSION = "arn:aws:sts::778983355679:assumed-role/AardvarkTaskRole/a1b2c3d4"


def ph(name, progress_value, structural=False, owner=None):
    return {
        "name": name,
        "phase_order": 0,
        "start": None,
        "end": None,
        "progress": progress_value,
        "structural": structural,
        "owner_email": owner,
    }


def proj(name, dri=None, phases=(), active=True):
    created = projects_q.create_project(name=name, dri_email=dri, phases=list(phases))
    if not active:
        projects_q.update_project(created["project_id"], {"active": False})
        created = projects_q.get_project(created["project_id"])
    return created


class FakeSlack:
    """Records DMs instead of sending them."""

    def __init__(self, directory, list_error="", refuses=()):
        self.directory = directory
        self.list_error = list_error
        self.refuses = refuses
        self.sent = []

    def list_people(self, force: bool = False) -> dict:
        if self.list_error:
            raise slack.SlackError(self.list_error)
        return {
            "people": [
                {"email": e, "slack_user_id": u, "name": e} for e, u in self.directory.items()
            ],
            "seen": len(self.directory),
        }

    def dm(self, slack_user_id: str, text: str, blocks: Optional[list] = None) -> None:
        if slack_user_id in self.refuses:
            raise slack.SlackError("channel_not_found")
        self.sent.append((slack_user_id, text, blocks))


@pytest.fixture
def fake_slack(monkeypatch):
    def install(directory, **kwargs):
        fake = FakeSlack(directory, **kwargs)
        monkeypatch.setattr(notifications.slack, "list_people", fake.list_people)
        monkeypatch.setattr(notifications.slack, "dm", fake.dm)
        return fake

    return install


# --- what counts as open ------------------------------------------------------


class TestOpenPhases:
    def test_a_finished_phase_is_not_asked_about(self, aws):
        project = proj("P", "dri@qwealth.com", [ph("Coding", 1.0)])
        assert progress.open_phases([project]) == []

    def test_progress_not_recorded_IS_open(self, aws):
        """
        The case the whole feature exists for. Unknown is not done, and a selection that
        skipped it would leave the least-known phases the least asked about.
        """
        project = proj("P", "dri@qwealth.com", [ph("Coding", None)])
        rows = progress.open_phases([project])
        assert [r["phase_name"] for r in rows] == ["Coding"]

    def test_zero_is_open_and_is_not_the_same_as_unrecorded(self, aws):
        # Both are asked about, and they must render differently - see TestBlocks.
        project = proj("P", "dri@qwealth.com", [ph("A", 0.0), ph("B", None)])
        rows = progress.open_phases([project])
        assert {r["progress"] for r in rows} == {0.0, None}

    def test_a_maintenance_band_is_never_asked_about(self, aws):
        """
        Structural phases are ongoing support with no end. "How far through Maintenance
        are you" has no answer, and it would appear in every message forever.
        """
        project = proj("P", "dri@qwealth.com", [ph("Maintenance", None, structural=True)])
        assert progress.open_phases([project]) == []

    def test_a_retired_project_is_left_alone(self, aws):
        # Nobody should be chased about a lane somebody deliberately took off the board.
        project = proj("Gone", "dri@qwealth.com", [ph("Coding", 0.2)], active=False)
        assert progress.open_phases([project]) == []


# --- who gets asked -----------------------------------------------------------


class TestAsker:
    def test_the_phase_owner_is_asked_before_the_dri(self, aws):
        project = proj("P", "dri@qwealth.com", [ph("Coding", 0.2, owner="owner@qwealth.com")])
        row = progress.open_phases([project])[0]
        assert (row["asker"], row["basis"]) == ("owner@qwealth.com", "owner")

    def test_the_dri_is_asked_when_nobody_owns_the_phase(self, aws):
        project = proj("P", "dri@qwealth.com", [ph("Coding", 0.2)])
        row = progress.open_phases([project])[0]
        assert (row["asker"], row["basis"]) == ("dri@qwealth.com", "dri")

    def test_a_phase_with_no_owner_and_no_dri_is_asked_by_nobody(self, aws):
        """
        Not an error, and not quietly dropped. There is no honest person to send it to,
        so it is counted as unreachable and surfaced in the run summary.
        """
        project = proj("Orphan", None, [ph("Coding", 0.2)])
        rows = progress.open_phases([project])
        assert rows[0]["asker"] is None
        assert len(progress.unasked(rows)) == 1

    def test_addresses_are_lowercased(self, aws):
        # The roster stores lowercase; a Cognito claim does not. Comparing them raw is
        # how somebody stops matching their own work.
        project = proj("P", None, [ph("Coding", 0.2, owner="Owner@QWealth.com")])
        assert progress.open_phases([project])[0]["asker"] == "owner@qwealth.com"

    def test_grouping_keeps_each_person_to_their_own_phases(self, aws):
        project = proj(
            "P",
            "dri@qwealth.com",
            [ph("Mine", 0.1, owner="a@qwealth.com"), ph("Theirs", 0.1, owner="b@qwealth.com")],
        )
        grouped = progress.group_by_asker(progress.open_phases([project]))
        assert set(grouped) == {"a@qwealth.com", "b@qwealth.com"}
        assert grouped["a@qwealth.com"]["count"] == 1


# --- what the message looks like ----------------------------------------------


class TestBlocks:
    @pytest.mark.parametrize(
        "value,shown", [(None, "not recorded"), (0.0, "0%"), (0.455, "46%"), (1.0, "100%")]
    )
    def test_progress_renders_honestly(self, value, shown):
        assert blocks.percent(value) == shown

    def test_nothing_open_means_no_message_at_all(self):
        # A recurring DM saying "you have nothing to do" is how a channel gets muted.
        assert blocks.compose_nudge("Joe", {}, {}) is None

    def test_the_button_carries_what_the_modal_needs(self):
        rows = [{"phase_id": "f1", "phase_name": "Coding", "progress": 0.5, "basis": "owner"}]
        body = blocks.compose_nudge("Joe", {"D2": rows}, {"D2": "p1"})
        action = [b for b in body if b["type"] == "actions"][0]
        value = action["elements"][0]["value"]
        assert '"pid":"p1"' in value and '"i":"f1"' in value

    def test_an_oversized_payload_drops_phases_rather_than_failing_to_send(self):
        """
        Slack rejects a button value over 2000 characters with a 400 that names the
        block and not the cause. Six of seven phases is worth much more than no message.
        """
        rows = [
            {"phase_id": f"f{i}", "phase_name": "x" * 200, "progress": 0.5, "basis": "owner"}
            for i in range(40)
        ]
        value = blocks.button_value("p1", rows)
        assert len(value) <= blocks.MAX_VALUE

    def test_a_long_project_name_cannot_break_the_button(self):
        # Button text is capped at 75 by Slack, and lane names are user-supplied.
        rows = [{"phase_id": "f1", "phase_name": "Coding", "progress": 0.5, "basis": "owner"}]
        body = blocks.compose_nudge("Joe", {"L" * 300: rows}, {"L" * 300: "p1"})
        action = [b for b in body if b["type"] == "actions"][0]
        assert len(action["elements"][0]["text"]["text"]) <= 75

    def test_being_asked_as_dri_is_explained(self):
        # Somebody chased about a phase they do not own should see why it reached them.
        rows = [{"phase_id": "f1", "phase_name": "Coding", "progress": 0.5, "basis": "dri"}]
        body = blocks.compose_nudge("Joe", {"D2": rows}, {"D2": "p1"})
        assert any("DRI" in str(b) for b in body)

    def test_the_notification_line_is_never_empty(self):
        # Without it Slack pushes "This content can't be displayed" to the lock screen.
        assert "2 open phases" in blocks.fallback_text("Joe", 2)
        assert "1 open phase" in blocks.fallback_text("Joe", 1)


# --- sending ------------------------------------------------------------------


class TestSending:
    def test_a_person_with_open_work_gets_one_dm_with_blocks(self, aws, fake_slack):
        people_q.create_person(email="joe@qwealth.com", name="Joe")
        proj("D2", "joe@qwealth.com", [ph("Coding", 0.5)])
        fake = fake_slack({"joe@qwealth.com": "U1"})

        result = notifications.run_progress_nudge(today=MONDAY)

        assert result["sent"] == 1
        user, text, body = fake.sent[0]
        assert user == "U1"
        assert body is not None and body[0]["type"] == "header"
        assert "Coding" in str(body)

    def test_monday_does_not_silence_wednesday(self, aws, fake_slack):
        """
        THE claim-period test. The digest claims by week; this claims by day, because it
        runs twice. Inheriting the weekly key would make Wednesday quiet with nothing
        anywhere explaining it.
        """
        people_q.create_person(email="joe@qwealth.com", name="Joe")
        proj("D2", "joe@qwealth.com", [ph("Coding", 0.5)])
        fake = fake_slack({"joe@qwealth.com": "U1"})

        notifications.run_progress_nudge(today=MONDAY)
        second = notifications.run_progress_nudge(today=WEDNESDAY)

        assert second["sent"] == 1
        assert len(fake.sent) == 2

    def test_the_same_day_twice_sends_once(self, aws, fake_slack):
        # A retried EventBridge event must not DM anybody twice.
        people_q.create_person(email="joe@qwealth.com", name="Joe")
        proj("D2", "joe@qwealth.com", [ph("Coding", 0.5)])
        fake = fake_slack({"joe@qwealth.com": "U1"})

        notifications.run_progress_nudge(today=MONDAY)
        again = notifications.run_progress_nudge(today=MONDAY)

        assert again["already_sent"] == 1
        assert len(fake.sent) == 1

    def test_somebody_not_in_slack_is_named_not_dropped(self, aws, fake_slack):
        people_q.create_person(email="gone@qwealth.com", name="Gone")
        proj("D2", "gone@qwealth.com", [ph("Coding", 0.5)])
        fake_slack({"someone@qwealth.com": "U9"})

        result = notifications.run_progress_nudge(today=MONDAY)

        assert result["no_slack_account"] == ["gone@qwealth.com"]
        assert result["sent"] == 0

    def test_unreachable_phases_are_counted_even_when_nobody_is_messaged(self, aws, fake_slack):
        # A run that reported only its successes would look healthy while part of the
        # board went unchased.
        proj("Orphan", None, [ph("Coding", 0.2)])
        fake_slack({})

        result = notifications.run_progress_nudge(today=MONDAY)

        assert result["open_phases"] == 1
        assert result["unasked_phases"] == 1
        assert result["sent"] == 0

    def test_a_dry_run_claims_nothing_and_sends_nothing(self, aws, fake_slack):
        # This is how the message gets looked at in production before it is switched on.
        people_q.create_person(email="joe@qwealth.com", name="Joe")
        proj("D2", "joe@qwealth.com", [ph("Coding", 0.5)])
        fake = fake_slack({"joe@qwealth.com": "U1"})

        preview = notifications.run_progress_nudge(today=MONDAY, dry_run=True)
        assert fake.sent == []
        assert preview["messages"][0]["blocks"] is not None

        real = notifications.run_progress_nudge(today=MONDAY)
        assert real["sent"] == 1, "the preview must not have claimed the day"


class TestTheSwitch:
    def test_the_handler_sends_nothing_while_the_switch_is_off(
        self, aws, fake_slack, monkeypatch
    ):
        people_q.create_person(email="joe@qwealth.com", name="Joe")
        proj("D2", "joe@qwealth.com", [ph("Coding", 0.5)])
        fake = fake_slack({"joe@qwealth.com": "U1"})
        monkeypatch.setattr(config, "PROGRESS_ENABLED", False)

        result = notifications.lambda_handler({"job": "progress"})

        assert result["sent"] == 0
        assert fake.sent == []

    def test_the_digest_switch_does_not_turn_this_on(self, aws, fake_slack, monkeypatch):
        """
        Two switches, deliberately. Turning milestone reminders on must not also start
        DMing people twice a week and inviting them to edit data - that is a separate
        decision about a different audience.
        """
        people_q.create_person(email="joe@qwealth.com", name="Joe")
        proj("D2", "joe@qwealth.com", [ph("Coding", 0.5)])
        fake = fake_slack({"joe@qwealth.com": "U1"})
        monkeypatch.setattr(config, "DIGEST_ENABLED", True)
        monkeypatch.setattr(config, "PROGRESS_ENABLED", False)

        notifications.lambda_handler({"job": "progress"})
        assert fake.sent == []

    def test_an_unknown_job_sends_nothing_rather_than_guessing(self, aws, fake_slack):
        # A typo in a schedule's payload must not send the wrong message on the wrong
        # day. Silence plus a named reason beats a plausible-looking wrong send.
        fake = fake_slack({})
        result = notifications.lambda_handler({"job": "progres"})
        assert "unknown job" in result["skipped"]
        assert fake.sent == []

    def test_an_event_with_no_job_is_still_the_digest(self, aws, fake_slack, monkeypatch):
        # The schedule that existed before this dispatch did carries no `job`.
        monkeypatch.setattr(config, "DIGEST_ENABLED", False)
        fake_slack({})
        result = notifications.lambda_handler({})
        assert result["skipped"] == "DIGEST_ENABLED is off"


# --- the write route ----------------------------------------------------------


@pytest.fixture
def service_client(client, monkeypatch):
    """The test client arriving as the allowlisted Aardvark task role."""
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(auth, "_iam_caller_arn", lambda request: AARDVARK_SESSION)
    monkeypatch.setattr(config, "SERVICE_CALLER_ARNS", [AARDVARK_ROLE])
    return client


class TestServiceProgressRoute:
    def test_it_writes_the_progress(self, service_client, aws):
        project = proj("D2", "joe@qwealth.com", [ph("Coding", 0.2)])
        phase_id = project["phases"][0]["phase_id"]

        response = service_client.post(
            "/api/service/phases/progress",
            json={
                "actor_email": "Joe@QWealth.com",
                "updates": [
                    {"project_id": project["project_id"], "phase_id": phase_id, "progress": 0.6}
                ],
            },
        )

        assert response.status_code == 200
        assert response.json()["updated"] == 1
        assert projects_q.get_phase(project["project_id"], phase_id)["progress"] == 0.6

    def test_the_audit_names_the_person_not_the_service(self, service_client, aws):
        """
        The one thing this door does differently from /api/service/invite, and the
        reason it takes actor_email at all. An invite is attributed to `service:` because
        the API cannot know who asked; here it can, and a progress figure nobody appears
        to have entered is worse than an unattributed invite - it is data people plan
        against.
        """
        project = proj("D2", "joe@qwealth.com", [ph("Coding", 0.2)])
        phase_id = project["phases"][0]["phase_id"]

        service_client.post(
            "/api/service/phases/progress",
            json={
                "actor_email": "joe@qwealth.com",
                "updates": [
                    {"project_id": project["project_id"], "phase_id": phase_id, "progress": 0.6}
                ],
            },
        )

        entries = audit.history(phase_id)
        assert entries and entries[0]["user_email"] == "joe@qwealth.com"
        assert not entries[0]["user_email"].startswith("service:")

    def test_null_puts_a_phase_back_to_not_recorded(self, service_client, aws):
        # Somebody who set 40% by mistake needs a way to say nobody actually knows. 0%
        # is a different claim.
        project = proj("D2", "joe@qwealth.com", [ph("Coding", 0.4)])
        phase_id = project["phases"][0]["phase_id"]

        service_client.post(
            "/api/service/phases/progress",
            json={
                "actor_email": "joe@qwealth.com",
                "updates": [
                    {"project_id": project["project_id"], "phase_id": phase_id, "progress": None}
                ],
            },
        )

        assert projects_q.get_phase(project["project_id"], phase_id)["progress"] is None

    def test_a_vanished_phase_is_named_and_the_rest_still_write(self, service_client, aws):
        """
        Partial success is reported rather than rolled back. A phase deleted between the
        DM and the submit must not cost the person the other answers they just gave.
        """
        project = proj("D2", "joe@qwealth.com", [ph("Coding", 0.2), ph("Testing", 0.1)])
        real, gone = project["phases"][0]["phase_id"], "ph_nope"

        response = service_client.post(
            "/api/service/phases/progress",
            json={
                "actor_email": "joe@qwealth.com",
                "updates": [
                    {"project_id": project["project_id"], "phase_id": real, "progress": 0.6},
                    {"project_id": project["project_id"], "phase_id": gone, "progress": 0.9},
                ],
            },
        )

        body = response.json()
        assert body["updated"] == 1 and body["missing"] == [gone]

    @pytest.mark.parametrize("bad", [1.5, -0.1])
    def test_progress_outside_nought_to_one_is_refused(self, service_client, aws, bad):
        project = proj("D2", "joe@qwealth.com", [ph("Coding", 0.2)])
        response = service_client.post(
            "/api/service/phases/progress",
            json={
                "actor_email": "joe@qwealth.com",
                "updates": [
                    {
                        "project_id": project["project_id"],
                        "phase_id": project["phases"][0]["phase_id"],
                        "progress": bad,
                    }
                ],
            },
        )
        assert response.status_code == 422

    def test_an_unlisted_caller_cannot_write_progress(self, client, aws, monkeypatch):
        """
        The route is not reachable just by being inside the AWS account. Same lock as
        /invite, and it has to be proven separately because the grant is per-METHOD.
        """
        monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
        monkeypatch.setattr(
            auth, "_iam_caller_arn", lambda request: "arn:aws:sts::1:assumed-role/Other/x"
        )
        monkeypatch.setattr(config, "SERVICE_CALLER_ARNS", [AARDVARK_ROLE])

        refused = client.post(
            "/api/service/phases/progress",
            json={"actor_email": "joe@qwealth.com", "updates": [{"project_id": "p", "phase_id": "f", "progress": 0.5}]},
        )
        assert refused.status_code == 403
