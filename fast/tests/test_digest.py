"""
What the Monday digest says, and to whom.

Pure functions, so none of this needs moto or a Slack double. The things worth pinning
here are the ones a scheduled job cannot tell you it got wrong: nobody reads a digest
that was never sent, and nobody notices a milestone that was silently skipped.
"""

from datetime import date
from typing import Optional

from app import digest

MONDAY = date(2026, 9, 7)


def project(
    project_id: str,
    name: str,
    dri: Optional[str],
    milestones: list,
) -> dict:
    return {
        "project_id": project_id,
        "name": name,
        "dri_email": dri,
        "milestones": milestones,
    }


def milestone(name: str, when: Optional[str], done: bool = False) -> dict:
    return {
        "milestone_id": name.lower().replace(" ", "-"),
        "name": name,
        "date": when,
        "done": done,
    }


class TestDigestPrefs:
    def test_somebody_who_has_never_opened_settings_gets_the_default(self):
        """
        A person predating the feature has neither field, so both come from the
        constants. The default was off while the digest was something nobody had asked
        for; it is on now that the team has asked for these to reach everybody.

        Asserted against DEFAULT_DIGEST_ENABLED rather than against a literal, so that
        changing that decision again is a one-line change rather than a change plus a
        red test that says nothing except that the number moved.
        """
        assert digest.digest_prefs({"email": "a@b.com"}) == (
            digest.DEFAULT_DIGEST_ENABLED,
            digest.DEFAULT_DIGEST_DAYS,
        )

    def test_switching_it_off_is_honoured(self):
        """
        The half that actually matters now the default is on: a stored False must beat
        the default, or turning the digest off on the settings page would do nothing and
        there would be no way out of a weekly DM.

        Explicitly `is False`, because `person.get("digest_enabled", DEFAULT)` returning
        the default for a stored False is exactly the bug this guards - and with the
        default now True that bug would be invisible in every other test here.
        """
        assert digest.digest_prefs({"digest_enabled": False})[0] is False

    def test_stored_settings_are_honoured(self):
        person = {"digest_enabled": True, "digest_days": 30}
        assert digest.digest_prefs(person) == (True, 30)

    def test_a_window_nobody_can_choose_falls_back(self):
        # A hand-edited item, or a window retired from DIGEST_WINDOWS later. Honouring
        # it would make the job's behaviour unpredictable from the settings page.
        assert digest.digest_prefs({"digest_enabled": True, "digest_days": 11})[1] == 14
        assert digest.digest_prefs({"digest_enabled": True, "digest_days": "x"})[1] == 14


class TestDueWithin:
    def test_picks_up_what_lands_inside_the_window(self):
        projects = [
            project("p1", "Data Delivery", "dri@qwealth.com", [
                milestone("Sign-off", "2026-09-11"),
            ])
        ]
        found = digest.due_within(projects, MONDAY, 14)
        assert [m["name"] for m in found] == ["Sign-off"]
        assert found[0]["days_away"] == 4
        assert found[0]["overdue"] is False

    def test_ignores_what_lands_beyond_it(self):
        projects = [
            project("p1", "Data Delivery", "dri@qwealth.com", [
                milestone("Far off", "2026-10-30"),
            ])
        ]
        assert digest.due_within(projects, MONDAY, 14) == []

    def test_a_done_milestone_is_finished_even_if_its_date_has_passed(self):
        projects = [
            project("p1", "Data Delivery", "dri@qwealth.com", [
                milestone("Shipped", "2026-08-01", done=True),
            ])
        ]
        assert digest.due_within(projects, MONDAY, 14) == []

    def test_an_undated_milestone_is_unscheduled_not_late(self):
        # Nullable on purpose - "not yet committed". Calling it upcoming would be a
        # sentence about nothing.
        projects = [
            project("p1", "Data Delivery", "dri@qwealth.com", [milestone("Someday", None)])
        ]
        assert digest.due_within(projects, MONDAY, 14) == []

    def test_overdue_is_included_however_old_and_sorts_first(self):
        projects = [
            project("p1", "Data Delivery", "dri@qwealth.com", [
                milestone("Next week", "2026-09-11"),
                milestone("Ancient", "2026-06-01"),
            ])
        ]
        found = digest.due_within(projects, MONDAY, 14)
        assert [m["name"] for m in found] == ["Ancient", "Next week"]
        assert found[0]["overdue"] is True
        assert found[0]["days_away"] < 0

    def test_today_counts_as_due_not_overdue(self):
        projects = [
            project("p1", "P", "dri@qwealth.com", [milestone("Today", "2026-09-07")])
        ]
        found = digest.due_within(projects, MONDAY, 14)
        assert found[0]["overdue"] is False
        assert found[0]["days_away"] == 0

    def test_a_malformed_date_costs_one_line_not_the_run(self):
        # This runs unattended. A console edit that put "next Tuesday" in the date
        # field must not stop everybody else's digest.
        projects = [
            project("p1", "P", "dri@qwealth.com", [
                milestone("Broken", "next Tuesday"),
                milestone("Fine", "2026-09-09"),
            ])
        ]
        assert [m["name"] for m in digest.due_within(projects, MONDAY, 14)] == ["Fine"]


class TestGrouping:
    def test_splits_owned_from_unowned(self):
        projects = [
            project("p1", "Owned", "dri@qwealth.com", [milestone("A", "2026-09-09")]),
            project("p2", "Unowned", None, [milestone("B", "2026-09-10")]),
        ]
        owned, unowned = digest.group_by_dri(digest.due_within(projects, MONDAY, 14))
        assert list(owned) == ["dri@qwealth.com"]
        assert [m["name"] for m in unowned] == ["B"]

    def test_a_blank_dri_is_no_dri(self):
        # The column is nullable and the migration left empty strings in places.
        projects = [project("p1", "P", "   ", [milestone("A", "2026-09-09")])]
        owned, unowned = digest.group_by_dri(digest.due_within(projects, MONDAY, 14))
        assert owned == {}
        assert len(unowned) == 1

    def test_one_person_collects_milestones_from_every_project_they_own(self):
        projects = [
            project("p1", "One", "dri@qwealth.com", [milestone("A", "2026-09-09")]),
            project("p2", "Two", "DRI@qwealth.com", [milestone("B", "2026-09-10")]),
        ]
        owned, _ = digest.group_by_dri(digest.due_within(projects, MONDAY, 14))
        # Addresses are lowercased on the way in, so the two spellings are one person.
        assert list(owned) == ["dri@qwealth.com"]
        assert len(owned["dri@qwealth.com"]) == 2


class TestComposition:
    def test_nothing_due_composes_to_nothing(self):
        # The caller sends nothing. A weekly "you have no milestones" is how a
        # notification becomes one people mute.
        assert digest.compose_digest("Sara", [], 14) == ""
        assert digest.compose_admin_report([], 14) == ""

    def test_the_digest_names_the_milestone_the_project_and_when(self):
        projects = [
            project("p1", "Enhanced Data Delivery", "d@q.com", [
                milestone("Regulatory sign-off", "2026-09-11"),
            ])
        ]
        items = digest.due_within(projects, MONDAY, 14)
        text = digest.compose_digest("Sara Ahmed", items, 14)
        assert "Sara" in text
        assert "Regulatory sign-off" in text
        assert "Enhanced Data Delivery" in text
        assert "in 4 days" in text

    def test_overdue_leads_and_is_labelled_as_past(self):
        projects = [
            project("p1", "P", "d@q.com", [
                milestone("Upcoming", "2026-09-14"),
                milestone("Slipped", "2026-09-01"),
            ])
        ]
        text = digest.compose_digest("Sara", digest.due_within(projects, MONDAY, 14), 14)
        assert text.index("Past their date") < text.index("Next 14 days")
        assert "6 days ago" in text

    def test_today_and_tomorrow_are_worded_not_counted(self):
        projects = [
            project("p1", "P", "d@q.com", [
                milestone("Now", "2026-09-07"),
                milestone("Soon", "2026-09-08"),
            ])
        ]
        text = digest.compose_digest(None, digest.due_within(projects, MONDAY, 14), 14)
        assert "— today" in text
        assert "— tomorrow" in text

    def test_the_admin_report_says_why_nobody_was_messaged(self):
        projects = [project("p1", "Translations", None, [milestone("Cutover", "2026-09-09")])]
        _, unowned = digest.group_by_dri(digest.due_within(projects, MONDAY, 14))
        text = digest.compose_admin_report(unowned, 14)
        assert "Translations" in text
        assert "no DRI" in text


class TestWeekStart:
    def test_every_day_of_one_week_keys_to_the_same_monday(self):
        # The deduplication key. A Wednesday retry of a failed Monday run must be
        # recognised as the same digest, not as a new one.
        keys = {digest.week_start(date(2026, 9, d)) for d in range(7, 14)}
        assert keys == {"2026-09-07"}

    def test_the_next_week_is_a_different_key(self):
        assert digest.week_start(date(2026, 9, 14)) == "2026-09-14"
