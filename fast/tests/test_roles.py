"""
Roles: the closed vocabulary, the required-on-create rule, and the rows that
predate the field.

That last one is the operationally interesting case and the reason this file is not
just a copy of test_skills.py. Roles are *required* going in but every person already
in the table has none, so the schema has to be strict at the edge and forgiving on
read at the same time. Get that backwards in either direction and one of two things
happens: the existing roster 500s on the first GET, or the requirement is silently
not a requirement.
"""

import pytest

from app.db.models import PersonModel
from app.roles import Role, catalogue


def _person(client, email="new@qwealth.com", **kwargs):
    body = {"email": email, "name": "New Person", "roles": ["ba"], **kwargs}
    return client.post("/api/people", json=body)


# --------------------------------------------------------------------------
# The vocabulary
# --------------------------------------------------------------------------


def test_catalogue_covers_every_role():
    """
    Every enum member needs a label and a description.

    Adding a Role without a LABELS entry would otherwise KeyError inside the endpoint
    at request time rather than here.
    """
    entries = catalogue()
    assert len(entries) == len(list(Role))
    for entry in entries:
        assert entry["label"]
        assert entry["description"]


def test_roles_endpoint_serves_the_catalogue(client):
    """
    Served, not duplicated in TypeScript, so the picker and the stored values cannot
    drift apart. Same argument as /api/skills.
    """
    response = client.get("/api/roles")
    assert response.status_code == 200
    assert [r["role"] for r in response.json()] == [r.value for r in Role]


def test_the_seven_roles_are_the_ones_that_were_asked_for(client):
    """
    Pinned deliberately. The list is short and coarse on purpose - it is for reading a
    roster at a glance, and granularity belongs in skills, which is the list that
    grows. An eighth role appearing here should be a decision somebody made, not a
    diff that slipped through.

    `outside-engineering` was the seventh, added by request: six of the entries name a
    craft and somebody who does none of them - operations, product, compliance - had
    no honest row. See the catch-all section in app/roles.py for why it is one entry
    and not four.
    """
    assert {r.value for r in Role} == {
        "ba",
        "ux",
        "software-engineer",
        "qa",
        "data",
        "leadership",
        "outside-engineering",
    }


def test_the_catch_all_is_last(client):
    """
    Display order is enum order - catalogue() iterates Role directly. The catch-all
    belongs at the bottom of the picker for the same reason `other` sits at the bottom
    of the phase-state ranking: it is where you land when nothing above fits, and a
    list that offers it first invites people to stop reading.
    """
    assert [r["role"] for r in client.get("/api/roles").json()][-1] == (
        "outside-engineering"
    )


# --------------------------------------------------------------------------
# Required going in
# --------------------------------------------------------------------------


def test_create_stores_the_roles(client):
    response = _person(client, roles=["ba", "ux"])
    assert response.status_code == 201, response.text
    assert response.json()["roles"] == ["ba", "ux"]


def test_create_without_roles_is_refused(client):
    """
    The whole point of "required". A roster of blank roles is the workbook's Team
    sheet again, and nobody ever goes back to fill one in.
    """
    response = client.post(
        "/api/people", json={"email": "new@qwealth.com", "name": "New Person"}
    )
    assert response.status_code == 422


def test_create_with_an_empty_role_list_is_refused(client):
    """
    Sending `[]` is the obvious way around a required field, and it has to be refused
    for the same reason as omitting it. The message says what to do rather than
    naming a constraint.
    """
    response = _person(client, roles=[])
    assert response.status_code == 422
    assert "at least one" in response.text


def test_an_unknown_role_is_refused(client):
    """
    Closed vocabulary. "Developer" and "software-engineer" are one role and two
    strings, and the moment both exist any filter built on roles is wrong.
    """
    response = _person(client, roles=["developer"])
    assert response.status_code == 422


def test_the_same_role_twice_is_refused(client):
    response = _person(client, roles=["ba", "ba"])
    assert response.status_code == 422
    assert "more than once" in response.text


def test_several_roles_are_allowed(client):
    """The reason this is a list at all: a BA who also does UX can say so."""
    response = _person(client, roles=["ba", "ux", "qa"])
    assert response.status_code == 201, response.text
    assert response.json()["roles"] == ["ba", "ux", "qa"]


# --------------------------------------------------------------------------
# Patching
# --------------------------------------------------------------------------


def test_patch_replaces_the_whole_list(client):
    """
    Replaced, not merged. A merging PATCH could only ever add, so "I no longer do UX"
    would be unexpressible without a second verb the API does not have.
    """
    _person(client, roles=["ba", "ux"])
    response = client.patch("/api/people/new@qwealth.com", json={"roles": ["data"]})
    assert response.status_code == 200, response.text
    assert response.json()["roles"] == ["data"]


def test_patch_without_roles_leaves_them_alone(client):
    """Absent means "leave alone". The absent-vs-null rule, on this field too."""
    _person(client, roles=["qa"])
    response = client.patch("/api/people/new@qwealth.com", json={"name": "Renamed"})
    assert response.status_code == 200, response.text
    assert response.json()["roles"] == ["qa"]
    assert response.json()["name"] == "Renamed"


def test_patch_cannot_clear_the_roles(client):
    """
    You may change your roles; you may not end up with none. Note the asymmetry with
    specialisations, which CAN be cleared: an empty skill list is a true statement
    about what somebody is available for, whereas an empty role list just means the
    row was never filled in.
    """
    _person(client, roles=["qa"])
    response = client.patch("/api/people/new@qwealth.com", json={"roles": []})
    assert response.status_code == 422
    assert "at least one" in response.text


# --------------------------------------------------------------------------
# Rows that predate the field
# --------------------------------------------------------------------------


def test_a_person_written_before_roles_existed_reads_back_as_empty():
    """
    Not hypothetical: everybody seeded from the workbook is in exactly this state,
    because the workbook records names and not disciplines. Without the default this
    fails response validation on the very first read of the roster.
    """
    assert PersonModel.from_item({"email": "old@qwealth.com", "name": "Old"})["roles"] == []


def test_the_roster_still_lists_somebody_with_no_roles(aws, client):
    """
    The end-to-end version of the above, which is the one that would actually have
    been noticed: one un-migrated row must cost one blank cell, never the whole
    endpoint.
    """
    from app.db.queries import people as people_q

    people_q.create_person(email="old@qwealth.com", name="Old")

    response = client.get("/api/people")
    assert response.status_code == 200, response.text
    assert [p for p in response.json() if p["email"] == "old@qwealth.com"]


@pytest.mark.parametrize("stored", [None, "ba", 7, {"role": "ba"}, [1, "ba", None]])
def test_a_malformed_stored_role_list_never_takes_down_the_row(stored):
    """
    A DynamoDB list holds anything, and this attribute is reachable from the console.
    Same rule as _specialisations: one bad record costs one odd-looking row.
    """
    person = PersonModel.from_item({"email": "x@qwealth.com", "name": "X", "roles": stored})
    assert isinstance(person["roles"], list)
    assert all(isinstance(r, str) for r in person["roles"])


def test_a_retired_role_still_shows_on_the_people_who_have_it():
    """
    Read back as plain strings, NOT validated against the enum.

    If a role were ever dropped from the vocabulary, filtering it out here would make
    it disappear from those people's rows silently - so the roster would assert they
    do nothing, which is worse than showing a value the picker no longer offers.
    """
    person = PersonModel.from_item(
        {"email": "x@qwealth.com", "name": "X", "roles": ["scrum-master"]}
    )
    assert person["roles"] == ["scrum-master"]


# --------------------------------------------------------------------------
# What a role is not
# --------------------------------------------------------------------------


def test_leadership_is_a_job_not_a_permission(monkeypatch, aws):
    """
    The trap this whole feature sets, guarded explicitly.

    People set their own roles. If anything ever read `leadership` as authorisation,
    granting yourself admin would be a two-click self-service operation. Admin is the
    Cognito group and nothing else.
    """
    from fastapi.testclient import TestClient

    from app import auth, config
    from app.main import app
    from tests.test_people_self_service import ME, _member

    claims = _member().scope["aws.event"]["requestContext"]["authorizer"]["claims"]
    monkeypatch.setattr(auth, "_authorizer_claims", lambda _r: claims)
    client = TestClient(app)

    made = client.post(
        "/api/people", json={"email": ME, "name": "Thomas", "roles": ["leadership"]}
    )
    assert made.status_code == 201, made.text

    # Still not an admin, and still cannot act on anybody else.
    assert client.get("/api/me").json()["is_admin"] is False
    assert client.delete(f"/api/people/{ME}").status_code == 403
