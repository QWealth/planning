"""The migration loader.

Cross-checks the far side of the one-way door. The emails here are test fixtures,
not the real roster - the loader refuses to guess an address precisely so that the
real mapping has to be written down by a human, and inventing one in a test would
undercut the rule it is testing.
"""

import pytest

from app.db.queries import people as people_q, projects as project_q
from app.seeds.load_roadmap import load, plan, resolve_people

ROADMAP = {
    "people": [
        {"name": "Joe"},
        {"name": "Timan"},
        {"name": "Artem"},
    ],
    "projects": [
        {
            "name": "QWAPP",
            "order": 0,
            "dri": "Joe",
            "support": "Timan",
            "phases": [
                {"name": "Planning", "owner": "Joe", "start": None, "end": None,
                 "progress": 1.0, "structural": False},
                {"name": "Coding", "owner": None, "start": "2026-02-02",
                 "end": "2026-05-29", "progress": 0.4, "structural": False},
                {"name": "Maintenance", "owner": None, "start": None, "end": None,
                 "progress": None, "structural": True},
            ],
        },
        {
            "name": "Qfeed",
            "order": 1,
            "dri": None,
            "support": None,
            "phases": [
                {"name": "Planning", "owner": None, "start": None, "end": None,
                 "progress": None, "structural": False},
            ],
        },
    ],
}

MAPPING = {"Joe": "joe@example.test", "Timan": "timan@example.test",
           "Artem": "artem@example.test"}


def test_every_mentioned_name_is_resolved():
    resolved, unmapped = resolve_people(ROADMAP, MAPPING)

    assert unmapped == []
    assert resolved["Joe"] == "joe@example.test"


def test_unmapped_names_are_reported_not_guessed():
    """
    The rule the loader exists to enforce.

    joe.lower() + "@qwealth.com" would be a plausible guess and a silent one: it
    creates a person who looks real, owns projects and never receives anything.
    """
    resolved, unmapped = resolve_people(ROADMAP, {"Joe": "joe@example.test"})

    assert unmapped == ["Artem", "Timan"]
    assert "Timan" not in resolved


def test_name_matching_ignores_case_and_whitespace():
    """"Joe " and "joe" both appear in the sheet and are not different people."""
    resolved, _ = resolve_people(
        {"people": [{"name": "Joe "}], "projects": []}, {"joe": "joe@example.test"}
    )

    assert resolved["Joe "] == "joe@example.test"


def test_nulls_survive_the_migration():
    """
    A #REF!, a 1900-era serial and a blank cell all arrive here as None and stay
    None. Filling them with anything is how the workbook got into this state.
    """
    written = plan(ROADMAP, dict(MAPPING))
    qfeed = next(p for p in written["projects"] if p["name"] == "Qfeed")

    assert qfeed["dri_email"] is None
    assert qfeed["support_email"] is None
    assert qfeed["phases"][0]["start"] is None
    assert qfeed["phases"][0]["progress"] is None


def test_structural_phases_are_stripped_of_schedule_data():
    """
    Belt and braces against a workbook that put a stray date on a Maintenance row.

    create_phase would accept it, and the roadmap would then draw a bar for a band
    that is meant to represent ongoing support rather than scheduled work.
    """
    roadmap = {
        "people": [],
        "projects": [{
            "name": "X", "order": 0, "dri": None, "support": None,
            "phases": [{"name": "Maintenance", "owner": None, "start": "2026-01-01",
                        "end": "2026-02-01", "progress": 0.5, "structural": True}],
        }],
    }

    phase = plan(roadmap, {})["projects"][0]["phases"][0]

    assert phase["structural"] is True
    assert phase["start"] is None
    assert phase["end"] is None
    assert phase["progress"] is None


def test_seeded_people_arrive_with_no_roles(aws):
    """
    The loader does not guess what anybody does.

    Same rule as the email mapping this module's docstring describes: the workbook
    records names, and a discipline inferred from a first name is an invention. So a
    seeded person lands with an empty role list and fills it in themselves.

    Asserted rather than assumed because roles are *required* at the API edge, and
    the obvious way to make that true would be to give the loader a default - which
    would put "Software engineer" against a designer and look authoritative.
    """
    load(plan(ROADMAP, dict(MAPPING)))

    assert people_q.get_person("timan@example.test")["roles"] == []


def test_load_writes_people_before_projects(aws):
    """
    Order matters: a project's dri_email should point at a person who exists.

    Nothing enforces it at the database level - DynamoDB has no foreign keys - so
    the ordering is the only thing that keeps the workload view from logging every
    owner as unknown on a fresh seed.
    """
    written = plan(ROADMAP, dict(MAPPING))
    load(written)

    assert people_q.get_person("joe@example.test")["name"] == "Joe"

    projects = project_q.list_projects()
    qwapp = next(p for p in projects if p["name"] == "QWAPP")
    assert qwapp["dri_email"] == "joe@example.test"
    assert qwapp["support_email"] == "timan@example.test"
    assert [ph["name"] for ph in qwapp["phases"]] == ["Planning", "Coding", "Maintenance"]


def test_reseeding_leaves_corrected_people_alone(aws):
    """
    A person already on the roster is not overwritten.

    Someone will fix a name or fill in their roles in the app and then re-run the seed, and
    silently reverting that correction is the kind of bug nobody reports because it
    looks like they imagined making the edit.
    """
    people_q.create_person(email="joe@example.test", name="Joseph B")

    load(plan(ROADMAP, dict(MAPPING)))

    assert people_q.get_person("joe@example.test")["name"] == "Joseph B"


def test_phase_order_follows_the_sheet(aws):
    """
    Lane order and phase order come from the sheet, not from a sort.

    The workbook's row order is the plan's intended reading order - Planning before
    Coding before Testing - and alphabetising it would scramble every lane.
    """
    written = plan(ROADMAP, dict(MAPPING))

    assert [p["name"] for p in written["projects"]] == ["QWAPP", "Qfeed"]
    assert [p["phase_order"] for p in written["projects"][0]["phases"]] == [0, 1, 2]
