"""
The day-of milestone check: who gets asked about what, and what the message says.

Pure tests. Nothing here touches DynamoDB or Slack, which is the point of the split
between milestone_check.py and notifications.py - see either module's docstring.
"""

from datetime import date

from app import blocks, milestone_check


def project(**overrides):
    """A project with one open, dated milestone. Overrides replace whole keys."""
    base = {
        "project_id": "p1",
        "name": "DocuTelligence",
        "active": True,
        "dri_email": "dri@qwealth.com",
        "milestones": [
            {
                "milestone_id": "m1",
                "name": "Pilot sign-off",
                "date": "2026-09-16",
                "done": False,
            }
        ],
    }
    base.update(overrides)
    return base


# 2026-09-16 is a Wednesday, so the window is one day and the weekend cases below have
# to say Monday explicitly. Pinned rather than computed from today, because a test whose
# window changes with the day it runs on is a test that passes until a Monday.
WEDNESDAY = date(2026, 9, 16)
MONDAY = date(2026, 9, 14)


class TestWindow:
    def test_an_ordinary_weekday_covers_only_itself(self):
        assert milestone_check.window(WEDNESDAY) == (WEDNESDAY, WEDNESDAY)

    def test_monday_reaches_back_over_the_weekend(self):
        # The whole reason this takes a window. A Saturday deadline has to be asked
        # about on the Monday or it is never asked about at all.
        since, until = milestone_check.window(MONDAY)
        assert since == date(2026, 9, 12)  # the Saturday
        assert until == MONDAY

    def test_the_lookback_is_capped(self):
        # Not reachable from a normal schedule; this is the first run after the job has
        # been off, which must not DM everybody about a fortnight of deadlines at once.
        since, _ = milestone_check.window(WEDNESDAY)
        assert (WEDNESDAY - since).days <= milestone_check.MAX_LOOKBACK_DAYS

    def test_last_working_day_skips_the_weekend(self):
        assert milestone_check.last_working_day(MONDAY) == date(2026, 9, 11)  # Friday
        assert milestone_check.last_working_day(WEDNESDAY) == date(2026, 9, 15)


class TestDueInWindow:
    def test_a_milestone_dated_today_is_asked_about(self):
        rows = milestone_check.due_in_window([project()], WEDNESDAY)
        assert [r["milestone_id"] for r in rows] == ["m1"]
        assert rows[0]["dri"] == "dri@qwealth.com"
        # Due today is not late yet. The message says "is due" rather than "was due",
        # and picking a fight with somebody who has the rest of the day is the failure
        # this flag exists to avoid.
        assert rows[0]["late"] is False

    def test_a_weekend_milestone_is_asked_about_on_monday(self):
        saturday = project(
            milestones=[
                {"milestone_id": "m1", "name": "Cutover", "date": "2026-09-12", "done": False}
            ]
        )
        rows = milestone_check.due_in_window([saturday], MONDAY)
        assert len(rows) == 1
        assert rows[0]["late"] is True

    def test_a_done_milestone_is_not_asked_about(self):
        done = project(
            milestones=[
                {"milestone_id": "m1", "name": "x", "date": "2026-09-16", "done": True}
            ]
        )
        assert milestone_check.due_in_window([done], WEDNESDAY) == []

    def test_an_undated_milestone_is_not_asked_about(self):
        # Not late, just unscheduled. There is no day on which to ask.
        undated = project(
            milestones=[{"milestone_id": "m1", "name": "x", "date": None, "done": False}]
        )
        assert milestone_check.due_in_window([undated], WEDNESDAY) == []

    def test_yesterdays_milestone_is_not_re_asked(self):
        # The window tiles the calendar: Tuesday's question was asked on Tuesday. Asking
        # again today would be the daily nagging the feature deliberately avoids.
        yesterday = project(
            milestones=[
                {"milestone_id": "m1", "name": "x", "date": "2026-09-15", "done": False}
            ]
        )
        assert milestone_check.due_in_window([yesterday], WEDNESDAY) == []

    def test_a_future_milestone_is_not_asked_about(self):
        future = project(
            milestones=[
                {"milestone_id": "m1", "name": "x", "date": "2026-09-30", "done": False}
            ]
        )
        assert milestone_check.due_in_window([future], WEDNESDAY) == []

    def test_an_inactive_project_is_skipped(self):
        assert milestone_check.due_in_window([project(active=False)], WEDNESDAY) == []

    def test_a_project_with_no_dri_still_appears_but_unasked(self):
        # Surfaced rather than dropped. A deadline with nobody accountable is the one
        # most worth noticing, and a run that silently skipped it would look healthy.
        rows = milestone_check.due_in_window([project(dri_email=None)], WEDNESDAY)
        assert len(rows) == 1
        assert rows[0]["dri"] is None
        assert milestone_check.unasked(rows) == rows
        assert milestone_check.group_by_dri(rows) == {}

    def test_addresses_are_lowercased(self):
        rows = milestone_check.due_in_window(
            [project(dri_email="  DRI@QWealth.com ")], WEDNESDAY
        )
        assert rows[0]["dri"] == "dri@qwealth.com"

    def test_oldest_first(self):
        two = project(
            milestones=[
                {"milestone_id": "b", "name": "B", "date": "2026-09-14", "done": False},
                {"milestone_id": "a", "name": "A", "date": "2026-09-12", "done": False},
            ]
        )
        rows = milestone_check.due_in_window([two], MONDAY)
        assert [r["milestone_id"] for r in rows] == ["a", "b"]


class TestGrouping:
    def test_one_person_gets_one_entry_with_all_of_theirs(self):
        rows = milestone_check.due_in_window(
            [
                project(),
                project(project_id="p2", name="Net Worth"),
            ],
            WEDNESDAY,
        )
        grouped = milestone_check.group_by_dri(rows)
        assert list(grouped) == ["dri@qwealth.com"]
        assert len(grouped["dri@qwealth.com"]) == 2

    def test_two_people_are_kept_apart(self):
        rows = milestone_check.due_in_window(
            [project(), project(project_id="p2", dri_email="other@qwealth.com")],
            WEDNESDAY,
        )
        assert sorted(milestone_check.group_by_dri(rows)) == [
            "dri@qwealth.com",
            "other@qwealth.com",
        ]


class TestBlocks:
    def test_nothing_due_composes_nothing(self):
        # None rather than "you have nothing due today", which on most days for most
        # people would be a daily DM saying nothing.
        assert blocks.compose_milestone_check("Thomas", []) is None

    def test_each_milestone_gets_its_own_pair_of_buttons(self):
        rows = milestone_check.due_in_window(
            [
                project(
                    milestones=[
                        {"milestone_id": "a", "name": "A", "date": "2026-09-16", "done": False},
                        {"milestone_id": "b", "name": "B", "date": "2026-09-16", "done": False},
                    ]
                )
            ],
            WEDNESDAY,
        )
        body = blocks.compose_milestone_check("Thomas", rows)
        actions = [b for b in body if b["type"] == "actions"]
        assert len(actions) == 2
        for block, mid in zip(actions, ["a", "b"]):
            ids = [e["action_id"] for e in block["elements"]]
            # The milestone id is in the action_id, so two questions in one message are
            # told apart without parsing a payload first.
            assert ids == [
                f"{blocks.ACTION_MILESTONE_DONE}::{mid}",
                f"{blocks.ACTION_MILESTONE_MISSED}::{mid}",
            ]

    def test_the_button_carries_the_milestone_as_asked(self):
        import json

        rows = milestone_check.due_in_window([project()], WEDNESDAY)
        value = json.loads(blocks.milestone_value(rows[0]))
        # Name and date ride along so the log records the question as it was put, not
        # as the roadmap stands whenever somebody reads it back.
        assert value == {
            "pid": "p1",
            "mid": "m1",
            "n": "Pilot sign-off",
            "d": "2026-09-16",
        }

    def test_the_value_stays_inside_slacks_cap(self):
        rows = milestone_check.due_in_window(
            [
                project(
                    name="x" * 400,
                    milestones=[
                        {
                            "milestone_id": "m1",
                            "name": "y" * 4000,
                            "date": "2026-09-16",
                            "done": False,
                        }
                    ],
                )
            ],
            WEDNESDAY,
        )
        assert len(blocks.milestone_value(rows[0])) <= blocks.MAX_VALUE

    def test_the_message_says_the_answer_is_recorded(self):
        # Somebody typing a reason is owed the fact that it is written down and who
        # reads it. A log nobody was told about is what people resent later.
        rows = milestone_check.due_in_window([project()], WEDNESDAY)
        text = str(blocks.compose_milestone_check("Thomas", rows))
        assert "recorded" in text
        assert "analyst" in text.lower()

    def test_the_fallback_line_reads_as_a_sentence(self):
        assert blocks.milestone_fallback("Thomas", 1) == (
            "Thomas, a milestone was due — did it land?"
        )
        assert blocks.milestone_fallback(None, 3) == (
            "3 milestones were due — did they land?"
        )
