"""
Specialisations: the closed vocabulary, the primary/secondary level, and the
compatibility of rows written before the field existed.

The last of those is the one that matters operationally. Ten people are already in
the `dev` table with no `specialisations` attribute at all, so "old row reads back
as an empty list" is not a hypothetical - it is the state of production right now,
and getting it wrong 500s the roster for everybody.
"""

import pytest

from app.db.models import PersonModel
from app.skills import Skill, SkillLevel, catalogue


def _person(client, email="new@qwealth.com", **kwargs):
    # roles is required by PersonCreate, so it is defaulted here rather than repeated
    # at a dozen call sites. These tests are about skills; the role is scaffolding.
    # The two are different axes on purpose - see app/roles.py.
    body = {"email": email, "name": "New Person", "roles": ["software-engineer"], **kwargs}
    return client.post("/api/people", json=body)


# --------------------------------------------------------------------------
# The vocabulary
# --------------------------------------------------------------------------


def test_catalogue_covers_every_skill():
    """
    Every enum member needs a label and a description.

    Adding a Skill without a LABELS entry would otherwise KeyError inside the
    endpoint at request time rather than here.
    """
    entries = catalogue()
    assert len(entries) == len(list(Skill))
    for entry in entries:
        assert entry["label"]
        assert entry["description"]


def test_skills_endpoint_serves_the_vocabulary(client):
    response = client.get("/api/skills")
    assert response.status_code == 200
    values = [e["skill"] for e in response.json()]
    assert "qa-testing" in values
    assert "data-engineering" in values
    assert "compliance" in values
    assert len(values) == len(set(values)), "vocabulary contains a duplicate"


def test_skills_endpoint_requires_the_group(aws, monkeypatch):
    """The vocabulary is not public: it describes how the firm is organised."""
    from fastapi.testclient import TestClient

    from app import auth, config
    from app.main import app

    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(config, "ENFORCE_GROUP", True)

    assert TestClient(app).get("/api/skills").status_code == 401


# --------------------------------------------------------------------------
# Writing skills
# --------------------------------------------------------------------------


def test_create_person_with_specialisations(client):
    response = _person(
        client,
        specialisations=[
            {"skill": "front-end", "level": "primary"},
            {"skill": "ui-ux", "level": "secondary"},
        ],
    )
    assert response.status_code == 201
    got = {s["skill"]: s["level"] for s in response.json()["specialisations"]}
    assert got == {"front-end": "primary", "ui-ux": "secondary"}


def test_level_defaults_to_secondary(client):
    """Omitting the level should not silently make somebody the obvious choice."""
    response = _person(client, specialisations=[{"skill": "networking"}])
    assert response.status_code == 201
    assert response.json()["specialisations"][0]["level"] == "secondary"


def test_unknown_skill_is_refused(client):
    """The entire point of a closed vocabulary."""
    response = _person(client, specialisations=[{"skill": "frontend"}])
    assert response.status_code == 422


def test_unknown_level_is_refused(client):
    response = _person(
        client, specialisations=[{"skill": "back-end", "level": "expert"}]
    )
    assert response.status_code == 422


def test_duplicate_skill_is_refused(client):
    """
    Otherwise the stored level depends on form field order, and the person flips
    between "ask them" and "they could cover" for no visible reason.
    """
    response = _person(
        client,
        specialisations=[
            {"skill": "back-end", "level": "primary"},
            {"skill": "back-end", "level": "secondary"},
        ],
    )
    assert response.status_code == 422


def test_specialisations_default_to_empty(client):
    """A person can be added without claiming any skill at all."""
    response = _person(client)
    assert response.status_code == 201
    assert response.json()["specialisations"] == []


# --------------------------------------------------------------------------
# Updating
# --------------------------------------------------------------------------


def test_patch_replaces_the_whole_list(client):
    """
    Replace, not merge. A merging PATCH could only ever add, so removing a skill -
    or clearing them all - would be unexpressible.
    """
    _person(client, specialisations=[{"skill": "front-end", "level": "primary"}])

    response = client.patch(
        "/api/people/new@qwealth.com",
        json={"specialisations": [{"skill": "compliance", "level": "secondary"}]},
    )
    assert response.status_code == 200
    assert response.json()["specialisations"] == [
        {"skill": "compliance", "level": "secondary"}
    ]


def test_patch_can_clear_specialisations(client):
    _person(client, specialisations=[{"skill": "networking", "level": "primary"}])
    response = client.patch(
        "/api/people/new@qwealth.com", json={"specialisations": []}
    )
    assert response.status_code == 200
    assert response.json()["specialisations"] == []


def test_patch_without_specialisations_leaves_them_alone(client):
    """
    Absent means "leave alone"; the field is only touched when sent. Same
    absent-vs-null rule the phase editor depends on.
    """
    _person(client, specialisations=[{"skill": "qa-testing", "level": "primary"}])
    response = client.patch("/api/people/new@qwealth.com", json={"name": "Renamed"})
    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"
    assert response.json()["specialisations"] == [
        {"skill": "qa-testing", "level": "primary"}
    ]


def test_patch_rejects_an_unknown_skill(client):
    _person(client)
    response = client.patch(
        "/api/people/new@qwealth.com",
        json={"specialisations": [{"skill": "wizardry"}]},
    )
    assert response.status_code == 422


# --------------------------------------------------------------------------
# Rows that predate the field - i.e. everyone currently in dev
# --------------------------------------------------------------------------


def test_row_without_the_attribute_reads_as_empty():
    assert PersonModel.from_item({"email": "a@b.com", "name": "A"})[
        "specialisations"
    ] == []


@pytest.mark.parametrize("stored", ["not-a-list", 42, {"skill": "front-end"}])
def test_malformed_specialisations_degrade_to_empty(stored):
    """
    One bad record costs one odd-looking row, never the whole endpoint - the same
    rule that makes PersonOut.email a plain str.
    """
    item = {"email": "a@b.com", "name": "A", "specialisations": stored}
    assert PersonModel.from_item(item)["specialisations"] == []


def test_malformed_entries_are_dropped_individually():
    """A good skill beside a broken one survives."""
    item = {
        "email": "a@b.com",
        "name": "A",
        "specialisations": [
            {"skill": "front-end", "level": "primary"},
            "junk",
            {"level": "primary"},
            {"skill": "ui-ux"},
        ],
    }
    assert PersonModel.from_item(item)["specialisations"] == [
        {"skill": "front-end", "level": "primary"},
        {"skill": "ui-ux", "level": "secondary"},
    ]


def test_existing_roster_survives_the_new_field(client):
    """
    The live shape: people written by the seed loader, before specialisations
    existed, listed through the response model that now requires the field.
    """
    from app.db.queries import people as q

    q.get_people_table().put_item(
        Item={"email": "legacy@example.invalid", "name": "Legacy", "active": True}
    )
    response = client.get("/api/people")
    assert response.status_code == 200
    row = next(p for p in response.json() if p["email"] == "legacy@example.invalid")
    assert row["specialisations"] == []


def test_workload_carries_specialisations(client):
    """The Team page reads workload, not /api/people, so skills must ride along."""
    _person(client, specialisations=[{"skill": "data-engineering", "level": "primary"}])
    response = client.get("/api/people/workload")
    assert response.status_code == 200
    row = next(p for p in response.json() if p["email"] == "new@qwealth.com")
    assert row["specialisations"] == [
        {"skill": "data-engineering", "level": "primary"}
    ]
    assert row["dri_project_ids"] == []


def test_skill_values_are_stable_identifiers():
    """
    Guards a rename. These strings are stored against people; changing one orphans
    every person who holds it, and the UI would quietly stop matching them.
    """
    assert Skill.QA_TESTING.value == "qa-testing"
    assert Skill.NON_RELATIONAL_DB.value == "non-relational-databases"
    assert SkillLevel.PRIMARY.value == "primary"
