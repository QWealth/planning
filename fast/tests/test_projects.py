"""
Project and phase storage: key layout, reserved words, validation.

Mostly against the query layer, which is where these particular mistakes live. The two
phase-delete tests are the exception and go through HTTP on purpose - what could break
there is the route's 404 guard and the blast radius of the delete, neither of which is
visible from `q.delete_phase`.
"""

import pytest

from app.db.models import PHASE_SK_PREFIX, PROJECT_SK
from app.db.queries import projects as q


def test_project_row_sorts_before_its_phases(aws):
    """
    "#PROJECT" is punctuation-first so it is always items[0].

    With the obvious "PROJECT" the phases would sort ahead of it ("PHASE#" <
    "PROJECT"), and get_project's scan for the project row would still work while any
    caller reasonably assuming items[0] was the project would be wrong - but only
    once a project had phases, so never in a small test.
    """
    assert PROJECT_SK < PHASE_SK_PREFIX


def test_create_and_read_back_with_phases(aws):
    created = q.create_project(
        name="QWAPP",
        lane_order=0,
        dri_email="joe@qwealth.com",
        phases=[
            {"name": "Planning", "phase_order": 0},
            {"name": "Wireframes", "phase_order": 1},
            {"name": "Maintenance", "phase_order": 9, "structural": True},
        ],
    )

    fetched = q.get_project(created["project_id"])

    assert fetched["name"] == "QWAPP"
    assert fetched["dri_email"] == "joe@qwealth.com"
    assert fetched["support_email"] is None
    assert [p["name"] for p in fetched["phases"]] == ["Planning", "Wireframes", "Maintenance"]
    assert fetched["phases"][2]["structural"] is True


def test_reserved_words_survive_an_update(aws):
    """
    "name", "end" and "active" are all DynamoDB reserved words.

    Every attribute goes through a #name alias precisely so that this is not a
    special case. Without the aliases this raises ValidationException, and it would
    do so on the single most common edit in the app.
    """
    project = q.create_project(name="D2", phases=[{"name": "Testing"}])
    phase_id = project["phases"][0]["phase_id"]

    q.update_project(project["project_id"], {"name": "D2 Rebuild", "active": False})
    updated = q.update_phase(project["project_id"], phase_id, {"end": "2026-06-30"})

    assert q.get_project(project["project_id"])["name"] == "D2 Rebuild"
    assert updated["end"] == "2026-06-30"


def test_update_rejects_unknown_fields(aws):
    """The allowlist stops a raw request body overwriting project_id or created_at."""
    project = q.create_project(name="Qfeed")

    with pytest.raises(q.ValidationError):
        q.update_project(project["project_id"], {"project_id": "hijacked"})


def test_update_refuses_to_resurrect_a_deleted_phase(aws):
    """
    attribute_exists guards against recreating a row as a stub.

    Without the condition, patching a phase another user has just deleted writes a
    brand new item holding only the patched field - a phase with no name, which the
    roadmap then draws as a blank band nobody can account for.
    """
    project = q.create_project(name="Qfeed", phases=[{"name": "Coding"}])
    phase_id = project["phases"][0]["phase_id"]
    q.delete_phase(project["project_id"], phase_id)

    assert q.update_phase(project["project_id"], phase_id, {"name": "Coding"}) is None
    assert q.get_phase(project["project_id"], phase_id) is None


def test_end_before_start_is_refused_against_the_merged_row(aws):
    """
    The check is on the result, not the request.

    A PATCH carrying only `end` has no `start` to compare against, so validating the
    request alone would let it move the end before a start already in the table.
    """
    project = q.create_project(
        name="DocuTelligence",
        phases=[{"name": "Architecting", "start": "2026-05-01", "end": "2026-07-01"}],
    )
    phase_id = project["phases"][0]["phase_id"]

    with pytest.raises(q.ValidationError, match="before start"):
        q.update_phase(project["project_id"], phase_id, {"end": "2026-02-01"})

    # The stored value is untouched by the rejected write.
    assert q.get_phase(project["project_id"], phase_id)["end"] == "2026-07-01"


def test_structural_phase_cannot_take_dates(aws):
    """Maintenance is an ongoing band, not scheduled work, so it draws no bar."""
    project = q.create_project(
        name="Net Worth", phases=[{"name": "Maintenance", "structural": True}]
    )
    phase_id = project["phases"][0]["phase_id"]

    with pytest.raises(q.ValidationError, match="structural"):
        q.update_phase(project["project_id"], phase_id, {"start": "2026-01-01"})


def test_delete_project_is_soft_and_hides_it(aws):
    project = q.create_project(name="Retired Thing")
    assert q.delete_project(project["project_id"]) is True

    assert project["project_id"] not in [p["project_id"] for p in q.list_projects()]
    assert project["project_id"] in [
        p["project_id"] for p in q.list_projects(include_inactive=True)
    ]


def test_deleting_a_seeded_phase_leaves_the_rest_of_the_lane(client):
    """
    Removing one of the six standard phases is the normal use of the delete.

    A new lane is seeded generously - Planning, Wireframes, Architecting, Coding,
    Testing and a Maintenance band - on the argument that it is easier to remove a
    stage than to remember one. Not every project has a Wireframes stage, so this is
    the second half of that decision rather than an escape hatch for mistakes.

    Asserted through HTTP rather than against the query layer because the thing that
    could break is the route: a phase is a separate item under the project's partition
    key, and a delete that took the project row or a sibling phase with it would still
    answer 204.
    """
    created = client.post(
        "/api/projects",
        json={
            "name": "Partner Onboarding",
            "phases": [
                {"name": "Planning", "phase_order": 0},
                {"name": "Wireframes", "phase_order": 1},
                {"name": "Coding", "phase_order": 2},
            ],
        },
    ).json()
    project_id = created["project_id"]
    wireframes = next(p for p in created["phases"] if p["name"] == "Wireframes")

    response = client.delete(f"/api/projects/{project_id}/phases/{wireframes['phase_id']}")
    assert response.status_code == 204

    fetched = client.get(f"/api/projects/{project_id}").json()
    assert fetched["name"] == "Partner Onboarding"
    assert [p["name"] for p in fetched["phases"]] == ["Planning", "Coding"]


def test_deleting_an_unknown_phase_is_a_404_not_a_silent_success(client):
    """
    DynamoDB's delete_item is happily idempotent, so a 204 here would be free.

    It would also be wrong: the UI removes the row from the lane on a 2xx, so a
    mistyped or already-deleted id would disappear from the screen and come back on
    the next load, which reads as the app having lost the edit.
    """
    project_id = client.post("/api/projects", json={"name": "Qfeed"}).json()["project_id"]

    assert client.delete(f"/api/projects/{project_id}/phases/phase-nope").status_code == 404


def test_list_projects_is_in_lane_order(aws):
    q.create_project(name="Third", lane_order=2)
    q.create_project(name="First", lane_order=0)
    q.create_project(name="Second", lane_order=1)

    assert [p["name"] for p in q.list_projects()] == ["First", "Second", "Third"]


def test_missing_project_is_none_not_an_empty_shell(aws):
    """
    A phantom project id returns None.

    The Query returns zero items rather than raising, so a careless implementation
    would build a project dict full of Nones and the UI would render an untitled
    empty lane instead of a 404.
    """
    assert q.get_project("does-not-exist") is None


# --- the category, which groups lanes on the roadmap -------------------------


def test_a_project_can_be_filed_under_a_category(aws) -> None:
    from app.db.queries import projects as q

    created = q.create_project(name="QWAPP", category="App")
    assert created["category"] == "App"
    assert q.get_project(created["project_id"])["category"] == "App"


def test_a_project_with_no_category_is_a_real_state(aws) -> None:
    # Every project predates this field, so absent means "not filed" rather than an
    # error - the same rule roles and specialisations already follow.
    from app.db.queries import projects as q

    assert q.create_project(name="Tax")["category"] is None


def test_the_category_is_trimmed_but_not_lowercased(client) -> None:
    """
    The difference between a key and a label. It is drawn as a group heading in the
    user's own capitalisation, so "Data" must survive - but " Data" and "Data" as two
    headings is exactly what the editor's datalist exists to prevent, and trailing
    whitespace would be invisible in the input.
    """
    response = client.post("/api/projects", json={"name": "Qfeed", "category": "  Data "})
    assert response.status_code == 201
    assert response.json()["category"] == "Data"


def test_an_empty_category_becomes_null(client) -> None:
    # What an HTML form sends for "nothing chosen". Left alone it would be a group
    # heading with no name.
    response = client.post("/api/projects", json={"name": "Tax", "category": "   "})
    assert response.json()["category"] is None


def test_the_category_can_be_changed_and_cleared(client) -> None:
    project_id = client.post("/api/projects", json={"name": "D2"}).json()["project_id"]

    patched = client.patch(f"/api/projects/{project_id}", json={"category": "Data"})
    assert patched.json()["category"] == "Data"

    cleared = client.patch(f"/api/projects/{project_id}", json={"category": ""})
    assert cleared.json()["category"] is None
