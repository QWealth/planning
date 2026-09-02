"""
Specialisations: the closed vocabulary, the star scale, and the compatibility of rows
written before either existed.

The compatibility half is the one that matters operationally, and it matters twice
over now. Ten people are in the `dev` table with no `specialisations` attribute at
all, so "old row reads back as an empty list" is not a hypothetical - it is the state
of production right now, and getting it wrong 500s the roster for everybody.

On top of that, every specialisation recorded before the star scale carries a `level`
string instead of `stars`, and NOTHING WAS MIGRATED - the conversion happens on read
in PersonModel._specialisations, so the tests at the bottom of this file are that
migration's only proof. Delete them and the next person to "tidy up" the read path
has no way to know what it was carrying.

Two axes, and they do not imply each other: `stars` is what somebody can do today,
`wants_to_learn` is whether they want the work. A three-star engineer may still want
more of it; a zero-star one who ticks the box is exactly who a staffing search should
surface when nobody else is free. See app/skills.py for the whole argument.
"""

import pytest

from app.db.models import PersonModel
from app.skills import MAX_STARS, Skill, catalogue


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


def test_figma_is_offered_next_to_ui_ux(client):
    """
    Catalogue order is the form's order - PersonEditor maps straight over it. Figma
    is a design tool, so it belongs beside UI/UX rather than at the end of the list
    where enum members otherwise accumulate.
    """
    values = [e["skill"] for e in client.get("/api/skills").json()]
    assert "figma" in values
    assert values.index("figma") == values.index("ui-ux") + 1


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
            {"skill": "front-end", "stars": 3},
            {"skill": "ui-ux", "stars": 1},
        ],
    )
    assert response.status_code == 201
    got = {s["skill"]: s["stars"] for s in response.json()["specialisations"]}
    assert got == {"front-end": 3, "ui-ux": 1}


def test_stars_and_appetite_are_independent(client):
    """
    The case the old four-answer control could not express: somebody who is already
    the obvious person to ask AND wants more of that work.
    """
    response = _person(
        client, specialisations=[{"skill": "front-end", "stars": 3, "wants_to_learn": True}]
    )
    assert response.status_code == 201
    assert response.json()["specialisations"] == [
        {"skill": "front-end", "stars": 3, "wants_to_learn": True}
    ]


def test_stars_default_to_two(client):
    """Omitting the rating should not silently make somebody the obvious choice."""
    response = _person(client, specialisations=[{"skill": "networking"}])
    assert response.status_code == 201
    assert response.json()["specialisations"][0]["stars"] == 2


def test_wants_to_learn_defaults_to_false(client):
    """Appetite is a claim somebody makes, never one inferred for them."""
    response = _person(client, specialisations=[{"skill": "networking"}])
    assert response.json()["specialisations"][0]["wants_to_learn"] is False


def test_zero_stars_with_no_appetite_is_refused(client):
    """
    An entry saying neither "I can do this" nor "I want to" says nothing at all. The
    form clears the row instead of sending one; storing it would put a person on a
    skill's list who has no relationship to it.
    """
    response = _person(
        client, specialisations=[{"skill": "back-end", "stars": 0, "wants_to_learn": False}]
    )
    assert response.status_code == 422


def test_zero_stars_is_allowed_when_they_want_to_learn(client):
    """The whole point of splitting appetite out: nought stars is a real answer."""
    response = _person(
        client, specialisations=[{"skill": "back-end", "stars": 0, "wants_to_learn": True}]
    )
    assert response.status_code == 201
    assert response.json()["specialisations"] == [
        {"skill": "back-end", "stars": 0, "wants_to_learn": True}
    ]


@pytest.mark.parametrize("stars", [-1, 4, 99])
def test_stars_outside_the_scale_are_refused(client, stars):
    """A write is checked; only reads are lenient. See the clamping tests below."""
    response = _person(client, specialisations=[{"skill": "back-end", "stars": stars}])
    assert response.status_code == 422


def test_the_old_level_field_is_not_accepted_on_a_write(client):
    """
    Reads still understand `level`, writes deliberately do not. A client left on the
    old shape must fail loudly rather than have "primary" silently dropped and the
    person recorded at the default two stars.
    """
    response = _person(
        client, specialisations=[{"skill": "back-end", "level": "primary"}]
    )
    assert response.status_code == 422


def test_unknown_skill_is_refused(client):
    """The entire point of a closed vocabulary."""
    response = _person(client, specialisations=[{"skill": "frontend"}])
    assert response.status_code == 422


def test_duplicate_skill_is_refused(client):
    """
    Otherwise the stored rating depends on form field order, and the person flips
    between "ask them" and "they could cover" for no visible reason.
    """
    response = _person(
        client,
        specialisations=[
            {"skill": "back-end", "stars": 3},
            {"skill": "back-end", "stars": 1},
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
    _person(client, specialisations=[{"skill": "front-end", "stars": 3}])

    response = client.patch(
        "/api/people/new@qwealth.com",
        json={"specialisations": [{"skill": "compliance", "stars": 1}]},
    )
    assert response.status_code == 200
    assert response.json()["specialisations"] == [
        {"skill": "compliance", "stars": 1, "wants_to_learn": False}
    ]


def test_patch_can_clear_specialisations(client):
    _person(client, specialisations=[{"skill": "networking", "stars": 3}])
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
    _person(client, specialisations=[{"skill": "qa-testing", "stars": 3}])
    response = client.patch("/api/people/new@qwealth.com", json={"name": "Renamed"})
    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"
    assert response.json()["specialisations"] == [
        {"skill": "qa-testing", "stars": 3, "wants_to_learn": False}
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
            {"skill": "front-end", "stars": 3},
            "junk",
            {"stars": 3},
            {"skill": "ui-ux"},
        ],
    }
    assert PersonModel.from_item(item)["specialisations"] == [
        {"skill": "front-end", "stars": 3, "wants_to_learn": False},
        {"skill": "ui-ux", "stars": 2, "wants_to_learn": False},
    ]


# --------------------------------------------------------------------------
# The migration, which only exists on the read path
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "level,stars,wants",
    [
        ("primary", 3, False),
        ("secondary", 2, False),
        # `learning` was never a rung on the capability ladder, which is precisely why
        # it was split out. It converts to no stars plus appetite, not to one star.
        ("learning", 0, True),
        # A level nobody defined lands on the same default an absent one does, rather
        # than dropping the skill and quietly shortening somebody's list.
        ("expert", 2, False),
        ("", 2, False),
    ],
)
def test_a_stored_level_reads_back_as_stars(level, stars, wants):
    item = {
        "email": "a@b.com",
        "name": "A",
        "specialisations": [{"skill": "front-end", "level": level}],
    }
    assert PersonModel.from_item(item)["specialisations"] == [
        {"skill": "front-end", "stars": stars, "wants_to_learn": wants}
    ]


def test_stars_win_over_a_leftover_level():
    """
    A row rewritten through the new form keeps whatever `level` the old one left
    behind, because the write replaces the list rather than the attribute. The new
    field is authoritative or every re-save would revert.
    """
    item = {
        "email": "a@b.com",
        "name": "A",
        "specialisations": [{"skill": "front-end", "level": "primary", "stars": 1}],
    }
    assert PersonModel.from_item(item)["specialisations"] == [
        {"skill": "front-end", "stars": 1, "wants_to_learn": False}
    ]


def test_a_stored_learning_level_survives_alongside_stars():
    """Appetite recorded the old way is not lost when a rating is added later."""
    item = {
        "email": "a@b.com",
        "name": "A",
        "specialisations": [{"skill": "front-end", "level": "learning", "stars": 2}],
    }
    assert PersonModel.from_item(item)["specialisations"] == [
        {"skill": "front-end", "stars": 2, "wants_to_learn": True}
    ]


@pytest.mark.parametrize(
    "stored,expected", [(-4, 0), (7, MAX_STARS), ("2", 2), (None, 2)]
)
def test_out_of_range_stars_are_clamped_not_raised(stored, expected):
    """
    Reads are lenient where writes are strict. Hand-edited data and a future scale
    with more rungs both have to land somewhere sensible; raising here would take the
    whole roster down over one person's row.
    """
    item = {
        "email": "a@b.com",
        "name": "A",
        "specialisations": [{"skill": "front-end", "stars": stored}],
    }
    assert PersonModel.from_item(item)["specialisations"][0]["stars"] == expected


def test_a_legacy_row_lists_without_a_500(client):
    """
    The live shape, end to end: a row holding `level` strings, read through the
    response model that now describes stars. This is the one that breaks first if the
    read-time mapping is ever removed.
    """
    from app.db.queries import people as q

    q.get_people_table().put_item(
        Item={
            "email": "legacy@example.invalid",
            "name": "Legacy",
            "active": True,
            "specialisations": [
                {"skill": "front-end", "level": "primary"},
                {"skill": "ui-ux", "level": "learning"},
            ],
        }
    )
    response = client.get("/api/people")
    assert response.status_code == 200
    row = next(p for p in response.json() if p["email"] == "legacy@example.invalid")
    assert row["specialisations"] == [
        {"skill": "front-end", "stars": 3, "wants_to_learn": False},
        {"skill": "ui-ux", "stars": 0, "wants_to_learn": True},
    ]


def test_existing_roster_survives_the_new_field(client):
    """
    The other live shape: people written by the seed loader, before specialisations
    existed at all, listed through a response model that now requires the field.
    """
    from app.db.queries import people as q

    q.get_people_table().put_item(
        Item={"email": "seeded@example.invalid", "name": "Seeded", "active": True}
    )
    response = client.get("/api/people")
    assert response.status_code == 200
    row = next(p for p in response.json() if p["email"] == "seeded@example.invalid")
    assert row["specialisations"] == []


def test_workload_carries_specialisations(client):
    """The Team page reads workload, not /api/people, so skills must ride along."""
    _person(client, specialisations=[{"skill": "data-engineering", "stars": 3}])
    response = client.get("/api/people/workload")
    assert response.status_code == 200
    row = next(p for p in response.json() if p["email"] == "new@qwealth.com")
    assert row["specialisations"] == [
        {"skill": "data-engineering", "stars": 3, "wants_to_learn": False}
    ]
    assert row["dri_project_ids"] == []


def test_skill_values_are_stable_identifiers():
    """
    Guards a rename. These strings are stored against people; changing one orphans
    every person who holds it, and the UI would quietly stop matching them.
    """
    assert Skill.QA_TESTING.value == "qa-testing"
    assert Skill.NON_RELATIONAL_DB.value == "non-relational-databases"
    assert Skill.FIGMA.value == "figma"
