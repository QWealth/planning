"""
The digest runner: who gets a message, who does not, and what happens on a retry.

`test_digest.py` covers what the text says. These are the things that only show up
once real tables and a Slack client are involved - and they are the ones a scheduled
job cannot report on, because there is nobody watching when it runs at 08:00 Monday.

Slack is a pair of fakes rather than an HTTP mock. The interesting question here is
never "was the request well formed" - test_slack.py owns that - it is "was a DM sent
to that person, and how many".
"""

from datetime import date
from typing import Optional

import pytest

from app import notifications, slack
from app.db.queries import people as people_q, projects as projects_q

MONDAY = date(2026, 9, 7)


class FakeSlack:
    """Records DMs instead of sending them. Optionally fails, in one of two ways."""

    def __init__(
        self,
        directory: dict,
        dm_error: str = "",
        list_error: str = "",
        refuses: tuple = (),
    ):
        self.directory = directory
        self.dm_error = dm_error
        self.list_error = list_error
        self.refuses = refuses
        self.sent: list[tuple] = []
        self.sent_blocks: list[tuple] = []

    def list_people(self, force: bool = False) -> dict:
        if self.list_error:
            raise slack.SlackError(self.list_error)
        people = [
            {"email": email, "slack_user_id": uid, "name": email}
            for email, uid in self.directory.items()
        ]
        return {"people": people, "seen": len(people)}

    def dm(
        self,
        slack_user_id: str,
        text: str,
        blocks: Optional[list] = None,
    ) -> None:
        """
        Mirrors slack.dm, `blocks` included.

        The keyword is accepted even though the digest never passes one, because a
        double whose signature has drifted from the real function fails every test that
        touches it with a TypeError - which is what happened when the progress nudge
        taught dm() to send Block Kit. Recorded alongside the text so a test can assert
        on the rendered message rather than only on the notification line.
        """
        if self.dm_error or slack_user_id in self.refuses:
            raise slack.SlackError(self.dm_error or "channel_not_found")
        self.sent.append((slack_user_id, text))
        self.sent_blocks.append((slack_user_id, blocks))


@pytest.fixture
def fake_slack(monkeypatch):
    """Wire a FakeSlack in, and hand back a function to configure it."""

    def install(directory: dict, **kwargs) -> FakeSlack:
        fake = FakeSlack(directory, **kwargs)
        monkeypatch.setattr(notifications.slack, "list_people", fake.list_people)
        monkeypatch.setattr(notifications.slack, "dm", fake.dm)
        return fake

    return install


def person(email: str, name: str, **prefs) -> dict:
    created = people_q.create_person(email=email, name=name)
    if prefs:
        people_q.update_person(email, prefs)
    return created


def project_with(name: str, dri: str, milestones: list) -> dict:
    return projects_q.create_project(name=name, dri_email=dri or None, milestones=milestones)


class TestWhoIsMessaged:
    def test_an_opted_in_dri_with_something_due_gets_one_dm(self, aws, fake_slack):
        person("dri@qwealth.com", "Sara Ahmed", digest_enabled=True, digest_days=14)
        project_with(
            "Data Delivery", "dri@qwealth.com", [{"name": "Sign-off", "date": "2026-09-11"}]
        )
        fake = fake_slack({"dri@qwealth.com": "U1"})

        result = notifications.run_weekly_digest(today=MONDAY)

        assert result["sent"] == 1
        assert len(fake.sent) == 1
        user_id, text = fake.sent[0]
        assert user_id == "U1"
        assert "Sign-off" in text

    def test_nobody_opted_in_means_slack_is_never_called(self, aws, fake_slack):
        # The expected state for a while after this ships. Reading the directory would
        # be a rate-limited API call to send nothing to nobody.
        person("off@qwealth.com", "Nobody")
        project_with("P", "off@qwealth.com", [{"name": "M", "date": "2026-09-08"}])
        fake = fake_slack({"off@qwealth.com": "U1"}, list_error="should not be called")

        result = notifications.run_weekly_digest(today=MONDAY)

        assert result == {**result, "opted_in": 0, "sent": 0}
        assert fake.sent == []

    def test_somebody_with_nothing_due_is_sent_nothing_and_counted(self, aws, fake_slack):
        # Not an error and not a send. A weekly "nothing this week" is how a
        # notification becomes one people mute.
        person("quiet@qwealth.com", "Quiet", digest_enabled=True, digest_days=7)
        fake = fake_slack({"quiet@qwealth.com": "U1"})

        result = notifications.run_weekly_digest(today=MONDAY)

        assert result["nothing_due"] == 1
        assert result["sent"] == 0
        assert fake.sent == []

    def test_a_dri_who_never_opted_in_is_not_messaged(self, aws, fake_slack):
        person("on@qwealth.com", "On", digest_enabled=True, digest_days=14)
        person("off@qwealth.com", "Off")
        project_with("Theirs", "off@qwealth.com", [{"name": "M", "date": "2026-09-09"}])
        project_with("Mine", "on@qwealth.com", [{"name": "N", "date": "2026-09-09"}])
        fake = fake_slack({"on@qwealth.com": "U1", "off@qwealth.com": "U2"})

        notifications.run_weekly_digest(today=MONDAY)

        assert [uid for uid, _ in fake.sent] == ["U1"]

    def test_each_person_gets_only_their_own_projects(self, aws, fake_slack):
        person("a@qwealth.com", "Ann", digest_enabled=True, digest_days=14)
        person("b@qwealth.com", "Ben", digest_enabled=True, digest_days=14)
        project_with("Ann's", "a@qwealth.com", [{"name": "Alpha", "date": "2026-09-09"}])
        project_with("Ben's", "b@qwealth.com", [{"name": "Beta", "date": "2026-09-09"}])
        fake = fake_slack({"a@qwealth.com": "UA", "b@qwealth.com": "UB"})

        notifications.run_weekly_digest(today=MONDAY)

        by_user = dict(fake.sent)
        assert "Alpha" in by_user["UA"] and "Beta" not in by_user["UA"]
        assert "Beta" in by_user["UB"] and "Alpha" not in by_user["UB"]

    def test_the_lookahead_is_per_person(self, aws, fake_slack):
        # The whole reason the setting exists. One pass over the projects is filtered
        # per recipient, so this is the test that the filtering is not shared state.
        person("near@qwealth.com", "Near", digest_enabled=True, digest_days=7)
        person("far@qwealth.com", "Far", digest_enabled=True, digest_days=30)
        project_with("Near's", "near@qwealth.com", [{"name": "Late", "date": "2026-09-25"}])
        project_with("Far's", "far@qwealth.com", [{"name": "Late", "date": "2026-09-25"}])
        fake = fake_slack({"near@qwealth.com": "UN", "far@qwealth.com": "UF"})

        notifications.run_weekly_digest(today=MONDAY)

        assert [uid for uid, _ in fake.sent] == ["UF"]

    def test_somebody_on_the_roster_but_not_in_slack_is_named_not_dropped(
        self, aws, fake_slack
    ):
        # Otherwise this is silent: they have the switch on and simply never receive
        # anything, and there is no page anywhere that would show them why.
        person("gone@qwealth.com", "Gone", digest_enabled=True, digest_days=14)
        project_with("P", "gone@qwealth.com", [{"name": "M", "date": "2026-09-09"}])
        fake_slack({"someone-else@qwealth.com": "U9"})

        result = notifications.run_weekly_digest(today=MONDAY)

        assert result["no_slack_account"] == ["gone@qwealth.com"]
        assert result["sent"] == 0


class TestDeduplication:
    def test_a_second_run_in_the_same_week_sends_nothing(self, aws, fake_slack):
        # A retried EventBridge event, or somebody re-running it by hand. A duplicate
        # DM is the failure that teaches people to mute the bot.
        person("dri@qwealth.com", "Sara", digest_enabled=True, digest_days=14)
        project_with("P", "dri@qwealth.com", [{"name": "M", "date": "2026-09-09"}])
        fake = fake_slack({"dri@qwealth.com": "U1"})

        first = notifications.run_weekly_digest(today=MONDAY)
        second = notifications.run_weekly_digest(today=MONDAY)

        assert first["sent"] == 1
        assert second["sent"] == 0
        assert second["already_sent"] == 1
        assert len(fake.sent) == 1

    def test_a_rerun_later_in_the_same_week_is_still_the_same_week(self, aws, fake_slack):
        person("dri@qwealth.com", "Sara", digest_enabled=True, digest_days=14)
        project_with("P", "dri@qwealth.com", [{"name": "M", "date": "2026-09-16"}])
        fake = fake_slack({"dri@qwealth.com": "U1"})

        notifications.run_weekly_digest(today=MONDAY)
        wednesday = notifications.run_weekly_digest(today=date(2026, 9, 9))

        assert wednesday["already_sent"] == 1
        assert len(fake.sent) == 1

    def test_the_next_week_sends_again(self, aws, fake_slack):
        person("dri@qwealth.com", "Sara", digest_enabled=True, digest_days=30)
        project_with("P", "dri@qwealth.com", [{"name": "M", "date": "2026-09-30"}])
        fake = fake_slack({"dri@qwealth.com": "U1"})

        notifications.run_weekly_digest(today=MONDAY)
        notifications.run_weekly_digest(today=date(2026, 9, 14))

        assert len(fake.sent) == 2

    def test_the_week_is_claimed_before_the_send_so_a_failure_does_not_retry(
        self, aws, fake_slack
    ):
        # The deliberate direction to fail. A Slack error leaves the week claimed, so
        # the next scheduled run stays quiet rather than risking a double send; the
        # failure is in the summary for a human to act on.
        person("dri@qwealth.com", "Sara", digest_enabled=True, digest_days=14)
        project_with("P", "dri@qwealth.com", [{"name": "M", "date": "2026-09-09"}])
        fake_slack({"dri@qwealth.com": "U1"}, dm_error="channel_not_found")

        failed = notifications.run_weekly_digest(today=MONDAY)
        assert failed["sent"] == 0
        assert failed["failed"] == [{"email": "dri@qwealth.com", "error": "channel_not_found"}]

        fake = fake_slack({"dri@qwealth.com": "U1"})
        again = notifications.run_weekly_digest(today=MONDAY)
        assert again["already_sent"] == 1
        assert fake.sent == []


class TestUnownedMilestones:
    def test_an_admin_who_asked_for_it_gets_the_unowned_report(self, aws, fake_slack):
        person("boss@qwealth.com", "Boss", digest_enabled=True, digest_admin_report=True)
        project_with("Translations", "", [{"name": "Cutover", "date": "2026-09-09"}])
        fake = fake_slack({"boss@qwealth.com": "UB"})

        result = notifications.run_weekly_digest(today=MONDAY)

        assert result["unowned_milestones"] == 1
        assert len(fake.sent) == 1
        assert "no DRI" in fake.sent[0][1]

    def test_an_ordinary_person_never_sees_it(self, aws, fake_slack):
        person("dri@qwealth.com", "Sara", digest_enabled=True)
        project_with("Translations", "", [{"name": "Cutover", "date": "2026-09-09"}])
        fake = fake_slack({"dri@qwealth.com": "U1"})

        result = notifications.run_weekly_digest(today=MONDAY)

        assert result["unowned_milestones"] == 1
        assert fake.sent == []

    def test_an_admin_with_their_own_work_gets_two_separate_messages(self, aws, fake_slack):
        # Two claim keys as well as two messages: they answer different questions, and
        # a week where one sends and the other fails should leave the other sendable.
        person("boss@qwealth.com", "Boss", digest_enabled=True, digest_admin_report=True)
        project_with("Theirs", "boss@qwealth.com", [{"name": "Mine", "date": "2026-09-09"}])
        project_with("Nobody's", "", [{"name": "Orphan", "date": "2026-09-09"}])
        fake = fake_slack({"boss@qwealth.com": "UB"})

        result = notifications.run_weekly_digest(today=MONDAY)

        assert result["sent"] == 2
        texts = "".join(text for _, text in fake.sent)
        assert "Mine" in texts and "Orphan" in texts


class TestDegrading:
    def test_slack_being_unreachable_claims_nothing(self, aws, fake_slack):
        # The whole run is retryable as-is, because nothing was claimed. Claiming
        # first and then discovering there is no directory would burn the week.
        person("dri@qwealth.com", "Sara", digest_enabled=True)
        project_with("P", "dri@qwealth.com", [{"name": "M", "date": "2026-09-09"}])
        fake_slack({}, list_error="invalid_auth")

        broken = notifications.run_weekly_digest(today=MONDAY)
        assert broken["sent"] == 0
        assert broken["failed"] == [{"email": "*", "error": "invalid_auth"}]

        fake = fake_slack({"dri@qwealth.com": "U1"})
        recovered = notifications.run_weekly_digest(today=MONDAY)
        assert recovered["sent"] == 1
        assert len(fake.sent) == 1

    def test_one_persons_failure_does_not_cost_everybody_else_theirs(self, aws, fake_slack):
        person("a@qwealth.com", "Ann", digest_enabled=True)
        person("b@qwealth.com", "Ben", digest_enabled=True)
        project_with("Ann's", "a@qwealth.com", [{"name": "Alpha", "date": "2026-09-09"}])
        project_with("Ben's", "b@qwealth.com", [{"name": "Beta", "date": "2026-09-09"}])

        fake = fake_slack({"a@qwealth.com": "UA", "b@qwealth.com": "UB"}, refuses=("UA",))

        result = notifications.run_weekly_digest(today=MONDAY)

        assert result["sent"] == 1
        assert [e["email"] for e in result["failed"]] == ["a@qwealth.com"]
        assert [uid for uid, _ in fake.sent] == ["UB"]


class TestDryRun:
    def test_it_composes_everything_and_sends_nothing(self, aws, fake_slack):
        person("dri@qwealth.com", "Sara", digest_enabled=True, digest_days=14)
        project_with("P", "dri@qwealth.com", [{"name": "Sign-off", "date": "2026-09-11"}])
        fake = fake_slack({"dri@qwealth.com": "U1"})

        result = notifications.run_weekly_digest(today=MONDAY, dry_run=True)

        assert fake.sent == []
        assert result["sent"] == 0
        assert [m["email"] for m in result["messages"]] == ["dri@qwealth.com"]
        assert "Sign-off" in result["messages"][0]["text"]

    def test_a_preview_does_not_claim_the_week(self, aws, fake_slack):
        # Otherwise looking at the digest would cancel it, which is the worst possible
        # behaviour for a preview.
        person("dri@qwealth.com", "Sara", digest_enabled=True)
        project_with("P", "dri@qwealth.com", [{"name": "M", "date": "2026-09-09"}])
        fake = fake_slack({"dri@qwealth.com": "U1"})

        notifications.run_weekly_digest(today=MONDAY, dry_run=True)
        result = notifications.run_weekly_digest(today=MONDAY)

        assert result["sent"] == 1
        assert len(fake.sent) == 1
