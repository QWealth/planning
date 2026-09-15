"""
The daily #request_for_comments chase: who gets named, and when it stops.

WHY THIS FILE IS PARANOID
-------------------------
Every other notification in this app is a DM. This one names colleagues in a public
channel, every weekday. The cost of a bug here is not a missed message - it is somebody
being publicly listed as owing a review they do not owe, or being listed for longer than
anybody agreed to.

So the rules that decide who appears are pinned individually, and three of them are
easy to get wrong in ways that look fine:

  * `wants_to_learn` is appetite, not capability. Somebody who ticked a box saying they
    would like to learn back-end has not signed up to be named as blocking a back-end
    decision. Zero stars must never match.
  * The chase stops after five WORKING days. Counting calendar days would spend two
    fifths of an RFC's budget over a weekend nobody was at a keyboard for.
  * Only `review` is chased. A draft is the author still thinking, and chasing people
    about a document its own author does not consider ready is how the channel earns a
    mute.
"""

from datetime import date

import pytest

from app import blocks, config, notifications, review_chase, slack
from app.db.queries import people as people_q, work as q
from app.work import RfcStatus

# A Wednesday, for the pure working-day arithmetic below.
WEDNESDAY = date(2026, 9, 9)

# Everything that creates an RFC has to reckon from the real clock: review_since is
# stamped at creation, so a pinned "today" in the past makes every proposal look as
# though it opens in the future and nothing is ever chased. That is not a hypothetical
# - it is what the first run of this file did.
TODAY = date.today()
REVIEW = RfcStatus.REVIEW.value


def person(email, skills=(), read=(), active=True):
    """skills is (skill, stars) pairs."""
    created = people_q.create_person(
        email=email,
        name=email.split("@")[0],
        specialisations=[
            {"skill": s, "stars": n, "wants_to_learn": n == 0} for s, n in skills
        ],
        active=active,
    )
    for item_id in read:
        people_q.mark_rfc_read(email, item_id)
    return created


def rfc(skills=(), status=REVIEW, title="A proposal"):
    made = q.create_rfc(
        {"title": title, "body": "", "status": status, "skills": list(skills)}
    )
    return made


class TestWorkingDays:
    def test_the_day_it_opens_is_zero(self):
        assert review_chase.working_days_since(WEDNESDAY, WEDNESDAY) == 0

    def test_a_weekend_costs_nothing(self):
        """
        Friday to Monday is ONE working day, not three. Counting calendar days would
        spend two fifths of the budget while the office is shut.
        """
        friday, monday = date(2026, 9, 11), date(2026, 9, 14)
        assert review_chase.working_days_since(friday, monday) == 1

    def test_a_full_working_week(self):
        monday, next_monday = date(2026, 9, 7), date(2026, 9, 14)
        assert review_chase.working_days_since(monday, next_monday) == 5

    def test_a_date_in_the_future_is_negative_not_expired(self):
        # Only reachable with a wrong clock. Expiring something that has not started
        # would silence it permanently, which is the worse way to be wrong.
        assert review_chase.working_days_since(date(2026, 9, 20), WEDNESDAY) < 0


class TestWhoIsNamed:
    def test_somebody_holding_the_skill_and_not_having_read_it(self, aws):
        doc = rfc(skills=["back-end"])
        person("joe@qwealth.com", skills=[("back-end", 2)])

        got = review_chase.chase_targets(
            q.list_rfcs(), people_q.list_people(), TODAY, REVIEW
        )
        assert [e["outstanding"] for e in got] == [["joe@qwealth.com"]]
        assert got[0]["item_id"] == doc["item_id"]

    def test_wanting_to_learn_a_skill_does_not_get_you_named(self, aws):
        """
        THE ONE THAT MATTERS MOST. Zero stars plus wants_to_learn is appetite, recorded
        in the same list as capability precisely so the two can be told apart. Being
        publicly named as owing a review because you once ticked a box is not the deal
        anybody thought they were making.
        """
        rfc(skills=["back-end"])
        person("keen@qwealth.com", skills=[("back-end", 0)])

        got = review_chase.chase_targets(
            q.list_rfcs(), people_q.list_people(), TODAY, REVIEW
        )
        assert got == []

    def test_having_read_it_takes_you_off_the_list(self, aws):
        doc = rfc(skills=["back-end"])
        person("joe@qwealth.com", skills=[("back-end", 2)], read=[doc["item_id"]])

        got = review_chase.chase_targets(
            q.list_rfcs(), people_q.list_people(), TODAY, REVIEW
        )
        assert got == []

    def test_a_deactivated_person_is_never_named(self, aws):
        rfc(skills=["back-end"])
        person("gone@qwealth.com", skills=[("back-end", 3)], active=False)

        got = review_chase.chase_targets(
            q.list_rfcs(), people_q.list_people(), TODAY, REVIEW
        )
        assert got == []

    def test_holding_a_different_skill_does_not_count(self, aws):
        rfc(skills=["back-end"])
        person("ux@qwealth.com", skills=[("ui-ux", 3)])

        got = review_chase.chase_targets(
            q.list_rfcs(), people_q.list_people(), TODAY, REVIEW
        )
        assert got == []


class TestWhichRfcs:
    @pytest.mark.parametrize("status", ["draft", "accepted", "rejected", "withdrawn"])
    def test_only_in_review_is_chased(self, aws, status):
        rfc(skills=["back-end"], status=status)
        person("joe@qwealth.com", skills=[("back-end", 2)])

        got = review_chase.chase_targets(
            q.list_rfcs(), people_q.list_people(), TODAY, REVIEW
        )
        assert got == []

    def test_an_untagged_rfc_chases_nobody(self, aws):
        # No tags means no audience to derive. Chasing everybody would be the fastest
        # way to make the channel ignorable.
        rfc(skills=[])
        person("joe@qwealth.com", skills=[("back-end", 2)])

        got = review_chase.chase_targets(
            q.list_rfcs(), people_q.list_people(), TODAY, REVIEW
        )
        assert got == []

    def test_it_stops_after_five_working_days(self, aws):
        doc = rfc(skills=["back-end"])
        person("joe@qwealth.com", skills=[("back-end", 2)])

        opened = review_chase.parse_day(q.get_rfc(doc["item_id"])["review_since"])
        # Day five still chases; the sixth working day does not.
        last = opened
        for _ in range(review_chase.CHASE_WORKING_DAYS):
            last = _next_working_day(last)
        assert review_chase.chase_targets(q.list_rfcs(), people_q.list_people(), last, REVIEW)

        over = _next_working_day(last)
        assert review_chase.chase_targets(q.list_rfcs(), people_q.list_people(), over, REVIEW) == []

    def test_an_rfc_in_review_with_no_stamp_is_left_alone(self, aws):
        """
        A row that predates review_since, or whose transition was not recorded. There is
        no honest day to count from, and guessing one would either nag forever or never.
        """
        doc = rfc(skills=["back-end"], status="draft")
        person("joe@qwealth.com", skills=[("back-end", 2)])
        # Straight to review in the table, bypassing the transition that stamps it.
        q.get_work_table().update_item(
            Key={"item_id": doc["item_id"], "sk": "#ITEM"},
            UpdateExpression="SET #s = :r",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":r": REVIEW},
        )
        assert q.get_rfc(doc["item_id"])["review_since"] is None

        got = review_chase.chase_targets(
            q.list_rfcs(), people_q.list_people(), TODAY, REVIEW
        )
        assert got == []


def _next_working_day(day):
    from datetime import timedelta

    nxt = day + timedelta(days=1)
    while nxt.weekday() >= 5:
        nxt += timedelta(days=1)
    return nxt


class TestTheStamp:
    def test_moving_into_review_starts_the_clock(self, aws):
        doc = rfc(skills=["back-end"], status="draft")
        assert doc["review_since"] is None

        moved = q.update_rfc(doc["item_id"], {"status": REVIEW})
        assert moved["review_since"] is not None

    def test_moving_out_of_review_clears_it(self, aws):
        # A stale stamp would be a fact on the row that nothing reads correctly.
        doc = rfc(skills=["back-end"])
        assert doc["review_since"] is not None

        moved = q.update_rfc(doc["item_id"], {"status": "withdrawn"})
        assert moved["review_since"] is None

    def test_editing_the_title_does_not_restart_the_clock(self, aws):
        """
        The reason this is its own field rather than `updated_at`: fixing a typo must
        not buy the author another five days of everybody else's attention.
        """
        doc = rfc(skills=["back-end"])
        before = doc["review_since"]

        after = q.update_rfc(doc["item_id"], {"title": "A better title"})
        assert after["review_since"] == before

    def test_a_caller_cannot_set_it(self, aws):
        doc = rfc(skills=["back-end"], status="draft")
        with pytest.raises(ValueError, match="review_since"):
            q.update_rfc(doc["item_id"], {"review_since": "2020-01-01T00:00:00"})


class TestTheRun:
    @pytest.fixture
    def fake_slack(self, monkeypatch):
        posts = []

        def list_people(force=False):
            return {
                "people": [
                    {"email": "joe@qwealth.com", "slack_user_id": "U1", "name": "Joe"}
                ],
                "seen": 1,
            }

        def post(channel, text, blocks=None):
            posts.append((channel, text, blocks))

        monkeypatch.setattr(notifications.slack, "list_people", list_people)
        monkeypatch.setattr(notifications.slack, "post", post)
        return posts

    def test_it_refuses_to_post_without_a_channel(self, aws, fake_slack, monkeypatch):
        """
        Posting a list of colleagues who owe a review into the wrong room is not a
        mistake worth risking to save a deploy, so an unset channel is a hard stop.
        """
        monkeypatch.setattr(config, "RFC_REVIEW_CHANNEL", "")
        rfc(skills=["back-end"])
        person("joe@qwealth.com", skills=[("back-end", 2)])

        result = notifications.run_rfc_chase(today=TODAY)
        assert result["posted"] is False
        assert fake_slack == []

    def test_it_posts_once_and_mentions_the_person(self, aws, fake_slack, monkeypatch):
        monkeypatch.setattr(config, "RFC_REVIEW_CHANNEL", "C123")
        rfc(skills=["back-end"], title="Local AI queueing")
        person("joe@qwealth.com", skills=[("back-end", 2)])

        result = notifications.run_rfc_chase(today=TODAY)

        assert result["posted"] is True
        channel, _text, body = fake_slack[0]
        assert channel == "C123"
        assert "<@U1>" in str(body)
        assert "Local AI queueing" in str(body)

    def test_the_same_day_twice_posts_once(self, aws, fake_slack, monkeypatch):
        # A retried schedule must not post the list again.
        monkeypatch.setattr(config, "RFC_REVIEW_CHANNEL", "C123")
        rfc(skills=["back-end"])
        person("joe@qwealth.com", skills=[("back-end", 2)])

        notifications.run_rfc_chase(today=TODAY)
        again = notifications.run_rfc_chase(today=TODAY)

        assert again["already_posted"] is True
        assert len(fake_slack) == 1

    def test_nothing_outstanding_says_nothing(self, aws, fake_slack, monkeypatch):
        # A daily "all clear" is how a channel gets muted, and a quiet channel already
        # says it.
        monkeypatch.setattr(config, "RFC_REVIEW_CHANNEL", "C123")
        doc = rfc(skills=["back-end"])
        person("joe@qwealth.com", skills=[("back-end", 2)], read=[doc["item_id"]])

        result = notifications.run_rfc_chase(today=TODAY)
        assert result["rfcs_chased"] == 0
        assert fake_slack == []

    def test_the_switch_being_off_posts_nothing(self, aws, fake_slack, monkeypatch):
        monkeypatch.setattr(config, "RFC_CHASE_ENABLED", False)
        monkeypatch.setattr(config, "RFC_REVIEW_CHANNEL", "C123")
        rfc(skills=["back-end"])
        person("joe@qwealth.com", skills=[("back-end", 2)])

        result = notifications.lambda_handler({"job": "rfc-chase"})
        assert result["posted"] is False
        assert fake_slack == []


class TestTheMessage:
    def test_it_says_how_long_is_left(self):
        # A reminder that will silently give up is worse than one that says so.
        entry = {
            "item_id": "rfc_1",
            "title": "A proposal",
            "skills": ["back-end"],
            "days_left": 2,
        }
        line = blocks.chase_line(entry, ["<@U1>"], "https://example.invalid")
        assert "2 working days left" in line
        assert "<@U1>" in line

    def test_the_last_day_says_so(self):
        entry = {"item_id": "rfc_1", "title": "T", "skills": ["back-end"], "days_left": 0}
        assert "last day" in blocks.chase_line(entry, [], "https://example.invalid")

    def test_nothing_outstanding_composes_nothing(self):
        assert blocks.compose_chase([], {}, "https://example.invalid") is None
