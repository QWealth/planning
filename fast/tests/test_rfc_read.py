"""
Per-person read marks on RFCs.

THE ONE THAT WOULD BREAK SILENTLY
---------------------------------
`rfcs_read` is a MAP on the person row, and the whole feature rests on adding one key
without disturbing the others. Get that wrong - write the attribute rather than the key
- and every RFC somebody had read turns unread the moment they open the next one. The
list still renders, nothing errors, and the only symptom is a page that is wrong in a
way people assume is their own memory.

That is why the second test here exists, and why `rfcs_read` is deliberately absent from
PERSON_UPDATABLE: an allowlisted PATCH takes a whole new map, so one request sending
`{}` would do exactly that damage through a route meant for editing somebody's name.
"""

import pytest

from app.db.queries import people as people_q, work as q
from app.work import RfcStatus


def _rfc(title="A proposal"):
    return q.create_rfc({"title": title, "body": "", "status": RfcStatus.DRAFT.value})


class TestMarkingRead:
    def test_opening_an_rfc_records_a_timestamp(self, aws):
        people_q.create_person(email="joe@qwealth.com", name="Joe")
        rfc = _rfc()

        people_q.mark_rfc_read("joe@qwealth.com", rfc["item_id"])

        read = people_q.get_person("joe@qwealth.com")["rfcs_read"]
        assert rfc["item_id"] in read
        # A timestamp rather than `true`, so "edited since you read it" stays answerable.
        assert read[rfc["item_id"]].startswith("20")

    def test_reading_a_second_rfc_does_not_forget_the_first(self, aws):
        """
        The map-merge. Writing the attribute instead of the key would silently mark
        everything previously read as unread again, with nothing on screen to say so.
        """
        people_q.create_person(email="joe@qwealth.com", name="Joe")
        first, second = _rfc("First"), _rfc("Second")

        people_q.mark_rfc_read("joe@qwealth.com", first["item_id"])
        people_q.mark_rfc_read("joe@qwealth.com", second["item_id"])

        read = people_q.get_person("joe@qwealth.com")["rfcs_read"]
        assert set(read) == {first["item_id"], second["item_id"]}

    def test_the_first_mark_works_on_a_person_who_has_read_nothing(self, aws):
        # The nested update fails outright when the parent attribute is absent, which is
        # every person until the first time they open anything - hence the two-step.
        people_q.create_person(email="new@qwealth.com", name="New")
        assert people_q.get_person("new@qwealth.com")["rfcs_read"] == {}

        rfc = _rfc()
        people_q.mark_rfc_read("new@qwealth.com", rfc["item_id"])
        assert rfc["item_id"] in people_q.get_person("new@qwealth.com")["rfcs_read"]

    def test_marking_twice_just_moves_the_timestamp(self, aws):
        people_q.create_person(email="joe@qwealth.com", name="Joe")
        rfc = _rfc()

        people_q.mark_rfc_read("joe@qwealth.com", rfc["item_id"])
        first = people_q.get_person("joe@qwealth.com")["rfcs_read"][rfc["item_id"]]
        people_q.mark_rfc_read("joe@qwealth.com", rfc["item_id"])
        second = people_q.get_person("joe@qwealth.com")["rfcs_read"][rfc["item_id"]]

        assert second >= first
        assert len(people_q.get_person("joe@qwealth.com")["rfcs_read"]) == 1

    def test_somebody_with_no_roster_row_is_not_an_error(self, aws):
        """
        Access is granted by the planning group; the roster is a separate list somebody
        fills in later. Those people have nowhere to store a mark, so everything stays
        highlighted for them - which is honest and fixes itself once they are added.
        """
        rfc = _rfc()
        assert people_q.mark_rfc_read("stranger@qwealth.com", rfc["item_id"]) is None


class TestThroughTheApi:
    def test_the_route_marks_it_read_for_the_caller(self, client, aws):
        people_q.create_person(email="tester@qwealth.com", name="Tester")
        rfc = _rfc()

        assert client.post(f"/api/rfcs/{rfc['item_id']}/read").status_code == 204
        assert rfc["item_id"] in people_q.get_person("tester@qwealth.com")["rfcs_read"]

    def test_reading_an_rfc_that_is_not_there_is_404(self, client, aws):
        assert client.post("/api/rfcs/rfc_nope/read").status_code == 404

    def test_a_patch_cannot_touch_the_read_map(self, client, aws):
        """
        The guard that stops one malformed request marking everything unread at once.

        Note what this asserts and what it does not. PersonPatch has no `rfcs_read`
        field, so pydantic DROPS it and the request succeeds having changed nothing -
        it is ignored rather than refused. That is a weaker contract than a 422 and it
        is the one that actually protects the data, which is what this pins: the map
        survives a request that tried to replace it.

        Checked through the API rather than only at the queries layer, because the
        allowlist is what a future convenience field gets added to without anybody
        thinking about what a map-valued updatable field would mean.
        """
        people_q.create_person(email="tester@qwealth.com", name="Tester")
        rfc = _rfc()
        people_q.mark_rfc_read("tester@qwealth.com", rfc["item_id"])

        client.patch("/api/people/tester@qwealth.com", json={"rfcs_read": {}})

        # Whatever the status was, nothing was lost.
        assert rfc["item_id"] in people_q.get_person("tester@qwealth.com")["rfcs_read"]

    def test_the_queries_layer_refuses_it_outright(self, aws):
        """
        The stronger half of the same guard, where it can actually be enforced.

        update_person raises on anything outside PERSON_UPDATABLE, so even a caller that
        bypasses the schema cannot replace the map.
        """
        people_q.create_person(email="tester@qwealth.com", name="Tester")
        with pytest.raises(ValueError, match="rfcs_read"):
            people_q.update_person("tester@qwealth.com", {"rfcs_read": {}})

    def test_the_person_payload_carries_the_map(self, client, aws):
        # The list page reads it from here, so it has to survive the response model.
        people_q.create_person(email="tester@qwealth.com", name="Tester")
        rfc = _rfc()
        client.post(f"/api/rfcs/{rfc['item_id']}/read")

        body = client.get("/api/people/tester@qwealth.com").json()
        assert rfc["item_id"] in body["rfcs_read"]
