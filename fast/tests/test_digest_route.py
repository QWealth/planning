"""
The two ways in: the preview endpoint, and the handler EventBridge invokes.

The cases that matter here are the ones where a switch does not do what its name
suggests. A master switch that also silences the preview would make the feature
impossible to look at before enabling; a preview that claimed the week would cancel
the digest it was previewing.
"""

from datetime import date, timedelta

import pytest

from app import config, notifications
from app.db.queries import people as people_q, projects as projects_q

MONDAY = date(2026, 9, 7)


class FakeSlack:
    def __init__(self, directory: dict):
        self.directory = directory
        self.sent: list = []

    def list_people(self, force: bool = False) -> dict:
        return {
            "people": [
                {"email": e, "slack_user_id": u, "name": e}
                for e, u in self.directory.items()
            ],
            "seen": len(self.directory),
        }

    def dm(self, slack_user_id: str, text: str) -> None:
        self.sent.append((slack_user_id, text))


@pytest.fixture
def fake_slack(monkeypatch):
    fake = FakeSlack({"tester@qwealth.com": "U1"})
    monkeypatch.setattr(notifications.slack, "list_people", fake.list_people)
    monkeypatch.setattr(notifications.slack, "dm", fake.dm)
    return fake


def _soon() -> str:
    """A date inside every offered window, whenever this suite happens to run."""
    return (date.today() + timedelta(days=3)).isoformat()


class TestPreview:
    def test_it_shows_the_caller_their_own_milestones(self, client, aws):
        people_q.create_person(email="tester@qwealth.com", name="Tess Tester")
        projects_q.create_project(
            name="Data Delivery",
            dri_email="tester@qwealth.com",
            milestones=[{"name": "Sign-off", "date": _soon()}],
        )

        body = client.get("/api/digest/preview").json()

        assert "Sign-off" in body["digest"]
        assert "Data Delivery" in body["digest"]
        assert body["enabled"] is False  # opt-in: seeing it is not subscribing to it

    def test_it_shows_nothing_of_anybody_elses(self, client, aws):
        # A preview that dry-ran the whole job would put one colleague's reminders in
        # another's browser. This is the test that keeps it per-caller.
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        people_q.create_person(email="other@qwealth.com", name="Otto")
        projects_q.create_project(
            name="Not Mine",
            dri_email="other@qwealth.com",
            milestones=[{"name": "Secret", "date": _soon()}],
        )

        body = client.get("/api/digest/preview").json()

        assert body["digest"] == ""
        assert "Secret" not in body["unowned_report"]

    def test_nothing_due_previews_as_nothing_rather_than_an_error(self, client, aws):
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        body = client.get("/api/digest/preview").json()
        assert body["digest"] == ""
        assert body["unowned_report"] == ""

    def test_a_window_can_be_tried_before_it_is_saved(self, client, aws):
        # What makes the settings page a settings page rather than a form you submit
        # and then wait a week to see the result of.
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        far = (date.today() + timedelta(days=20)).isoformat()
        projects_q.create_project(
            name="P", dri_email="tester@qwealth.com", milestones=[{"name": "Later", "date": far}]
        )

        assert client.get("/api/digest/preview?days=7").json()["digest"] == ""
        assert "Later" in client.get("/api/digest/preview?days=30").json()["digest"]

    def test_a_window_nobody_is_offered_is_refused(self, client, aws):
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        assert client.get("/api/digest/preview?days=11").status_code == 422

    def test_the_unowned_report_is_only_for_somebody_subscribed_to_it(self, client, aws):
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        projects_q.create_project(
            name="Translations", milestones=[{"name": "Cutover", "date": _soon()}]
        )

        assert client.get("/api/digest/preview").json()["unowned_report"] == ""

        people_q.update_person("tester@qwealth.com", {"digest_admin_report": True})
        assert "Cutover" in client.get("/api/digest/preview").json()["unowned_report"]

    def test_it_says_whether_this_deployment_sends_at_all(self, client, aws, monkeypatch):
        # Without this the settings page would confirm a subscription that the master
        # switch is quietly discarding.
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        monkeypatch.setattr(config, "DIGEST_ENABLED", False)
        assert client.get("/api/digest/preview").json()["sending_enabled"] is False
        monkeypatch.setattr(config, "DIGEST_ENABLED", True)
        assert client.get("/api/digest/preview").json()["sending_enabled"] is True

    def test_a_capitalised_address_still_finds_its_own_projects(self, client, aws, monkeypatch):
        # Cognito holds whatever was typed at sign-up; dri_email is normalised. Matching
        # the two raw would preview an empty digest and look like "nothing due".
        from app import auth

        monkeypatch.setattr(auth, "DEV_USER_EMAIL", "Tester@QWealth.com")
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        projects_q.create_project(
            name="P", dri_email="tester@qwealth.com", milestones=[{"name": "Mine", "date": _soon()}]
        )

        assert "Mine" in client.get("/api/digest/preview").json()["digest"]


class TestLambdaEntryPoint:
    def test_the_master_switch_off_sends_nothing(self, aws, fake_slack, monkeypatch):
        monkeypatch.setattr(config, "DIGEST_ENABLED", False)
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        people_q.update_person("tester@qwealth.com", {"digest_enabled": True})
        projects_q.create_project(
            name="P", dri_email="tester@qwealth.com", milestones=[{"name": "M", "date": _soon()}]
        )

        result = notifications.lambda_handler({}, None)

        assert result["sent"] == 0
        assert fake_slack.sent == []

    def test_the_master_switch_on_delivers(self, aws, fake_slack, monkeypatch):
        monkeypatch.setattr(config, "DIGEST_ENABLED", True)
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        people_q.update_person("tester@qwealth.com", {"digest_enabled": True})
        projects_q.create_project(
            name="P", dri_email="tester@qwealth.com", milestones=[{"name": "M", "date": _soon()}]
        )

        result = notifications.lambda_handler({}, None)

        assert result["sent"] == 1
        assert len(fake_slack.sent) == 1

    def test_a_dry_run_works_even_with_the_switch_off(self, aws, fake_slack, monkeypatch):
        # The point of the switch is that it gates DELIVERY. Being unable to compose a
        # preview until it is on would make the switch impossible to make a decision
        # about.
        monkeypatch.setattr(config, "DIGEST_ENABLED", False)
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        people_q.update_person("tester@qwealth.com", {"digest_enabled": True})
        projects_q.create_project(
            name="P", dri_email="tester@qwealth.com", milestones=[{"name": "M", "date": _soon()}]
        )

        result = notifications.lambda_handler({"dry_run": True}, None)

        assert fake_slack.sent == []
        assert [m["email"] for m in result["messages"]] == ["tester@qwealth.com"]

    def test_a_week_can_be_named_for_a_manual_rerun(self, aws, fake_slack, monkeypatch):
        monkeypatch.setattr(config, "DIGEST_ENABLED", True)
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        people_q.update_person("tester@qwealth.com", {"digest_enabled": True})
        projects_q.create_project(
            name="P",
            dri_email="tester@qwealth.com",
            milestones=[{"name": "M", "date": "2026-09-11"}],
        )

        result = notifications.lambda_handler({"today": MONDAY.isoformat()}, None)

        assert result["week"] == "2026-09-07"
        assert result["sent"] == 1

    def test_an_unreadable_date_falls_back_to_today_rather_than_raising(
        self, aws, fake_slack, monkeypatch
    ):
        # A raise here is a Lambda error metric and an automatic retry, and retrying a
        # digest is the one thing worth avoiding.
        monkeypatch.setattr(config, "DIGEST_ENABLED", True)
        result = notifications.lambda_handler({"today": "next Tuesday"}, None)
        assert result["today"] == date.today().isoformat()

    def test_a_scheduled_event_carries_neither_flag(self, aws, fake_slack, monkeypatch):
        # EventBridge sends its own shape. Nothing in it should be mistaken for an
        # instruction to dry-run or to re-run a past week.
        monkeypatch.setattr(config, "DIGEST_ENABLED", True)
        people_q.create_person(email="tester@qwealth.com", name="Tess")
        people_q.update_person("tester@qwealth.com", {"digest_enabled": True})
        projects_q.create_project(
            name="P", dri_email="tester@qwealth.com", milestones=[{"name": "M", "date": _soon()}]
        )

        event = {"detail-type": "Scheduled Event", "time": "2020-01-01T12:00:00Z", "detail": {}}
        result = notifications.lambda_handler(event, None)

        assert result["today"] == date.today().isoformat()
        assert result["dry_run"] is False
        assert len(fake_slack.sent) == 1
