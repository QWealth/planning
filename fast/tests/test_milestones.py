"""Milestones: key layout, the nullable date, done-vs-overdue, and the routes.

A milestone is the second child entity to share a project's partition, so the first
thing worth pinning down is that adding it did not disturb the key ordering the rest
of the code relies on.
"""

from datetime import date, timedelta

from app.db.models import (
    MILESTONE_SK_PREFIX,
    PHASE_SK_PREFIX,
    PROJECT_SK,
)
from app.db.queries import projects as q
from app.schemas.projects import MilestoneCreate, MilestoneOut, MilestoneUpdate

TODAY = date.today()
YESTERDAY = (TODAY - timedelta(days=1)).isoformat()
NEXT_YEAR = (TODAY + timedelta(days=365)).isoformat()


def test_project_row_still_sorts_first_with_milestones(aws):
    """
    "MILESTONE#" lands between "#PROJECT" and "PHASE#", which is harmless.

    The property that matters is not where milestones sort but that "#" still beats
    everything, so get_project's items[0] is the project row whatever children exist.
    Adding a child entity whose prefix sorted before "#" would break that silently -
    and only for projects that had one.
    """
    assert PROJECT_SK < MILESTONE_SK_PREFIX < PHASE_SK_PREFIX


def test_milestone_date_field_is_actually_a_date(aws):
    """
    Guard against the field name shadowing the imported type.

    Written `date: Optional[date] = None`, the annotation resolves against a class
    namespace where `date` has already been rebound to None, so the field type
    silently becomes NoneType - it accepts null and 422s every real date. Nothing
    fails at import, no test of the query layer notices, and the only symptom is a
    rejected request that is plainly valid. Asserting the resolved type is the
    cheapest way to keep it from coming back.
    """
    for model in (MilestoneCreate, MilestoneUpdate, MilestoneOut):
        assert model.model_fields["date"].annotation is not type(None), model.__name__

    assert MilestoneCreate(name="Beta", date="2026-09-01").date == date(2026, 9, 1)


def test_create_project_with_milestones_and_read_back(aws):
    created = q.create_project(
        name="QWAPP",
        phases=[{"name": "Planning"}],
        milestones=[
            {"name": "Beta launch", "date": "2026-09-01"},
            {"name": "Client demo", "date": "2026-06-15", "note": "with the board"},
        ],
    )

    fetched = q.get_project(created["project_id"])

    assert [m["name"] for m in fetched["milestones"]] == ["Client demo", "Beta launch"]
    assert fetched["milestones"][0]["note"] == "with the board"
    assert fetched["milestones"][1]["done"] is False
    # The phases are untouched by the new sibling rows.
    assert [p["name"] for p in fetched["phases"]] == ["Planning"]


def test_undated_milestones_sort_last(aws):
    """
    An undated milestone is not "the beginning of time".

    Sorting a null date as an empty string would float every uncommitted milestone
    to the top of the list, ahead of everything real - which is the workbook's habit
    of treating a blank cell as zero, in a different costume.
    """
    project = q.create_project(
        name="D2",
        milestones=[
            {"name": "Someday"},
            {"name": "Regulatory deadline", "date": "2026-03-31"},
        ],
    )

    assert [m["name"] for m in project["milestones"]] == [
        "Regulatory deadline",
        "Someday",
    ]


def test_create_milestone_on_existing_project(aws):
    project = q.create_project(name="Vault")

    created = q.create_milestone(
        project["project_id"], {"name": "Go live", "date": "2026-11-02"}
    )

    assert created["milestone_id"]
    assert q.get_milestone(project["project_id"], created["milestone_id"])["name"] == "Go live"
    assert len(q.get_project(project["project_id"])["milestones"]) == 1


def test_milestone_without_a_date_is_stored_as_null(aws):
    """"We need a beta launch, nobody has committed to when" has to be storable."""
    project = q.create_project(name="Vault")

    created = q.create_milestone(project["project_id"], {"name": "Beta launch"})

    assert created["date"] is None


def test_patch_leaves_unmentioned_date_alone(aws):
    """Renaming a milestone must not un-schedule it. See schemas/projects.py."""
    project = q.create_project(name="Vault", milestones=[{"name": "Demo", "date": "2026-05-01"}])
    milestone_id = project["milestones"][0]["milestone_id"]

    updated = q.update_milestone(project["project_id"], milestone_id, {"name": "Board demo"})

    assert updated["name"] == "Board demo"
    assert updated["date"] == "2026-05-01"


def test_patch_with_explicit_null_clears_the_date(aws):
    """The other half of the rule: null means "the commitment has gone"."""
    project = q.create_project(name="Vault", milestones=[{"name": "Demo", "date": "2026-05-01"}])
    milestone_id = project["milestones"][0]["milestone_id"]

    updated = q.update_milestone(project["project_id"], milestone_id, {"date": None})

    assert updated["date"] is None
    assert updated["name"] == "Demo"


def test_done_is_independent_of_the_date(aws):
    """
    A milestone can be finished before its date, or overdue and still open.

    Deriving doneness from the date would make every slipped commitment report as
    achieved, which is the single most expensive thing this entity could get wrong.
    """
    project = q.create_project(
        name="Vault", milestones=[{"name": "Ship", "date": NEXT_YEAR}]
    )
    milestone_id = project["milestones"][0]["milestone_id"]

    updated = q.update_milestone(project["project_id"], milestone_id, {"done": True})

    assert updated["done"] is True
    assert updated["date"] == NEXT_YEAR


def test_update_rejects_unknown_fields(aws):
    project = q.create_project(name="Vault", milestones=[{"name": "Ship"}])
    milestone_id = project["milestones"][0]["milestone_id"]

    try:
        q.update_milestone(project["project_id"], milestone_id, {"progress": 0.5})
    except q.ValidationError:
        pass
    else:
        raise AssertionError("a milestone has no progress and must not accept one")


def test_update_missing_milestone_returns_none(aws):
    project = q.create_project(name="Vault")

    assert q.update_milestone(project["project_id"], "nope", {"name": "x"}) is None


def test_delete_milestone(aws):
    project = q.create_project(name="Vault", milestones=[{"name": "Ship"}])
    milestone_id = project["milestones"][0]["milestone_id"]

    assert q.delete_milestone(project["project_id"], milestone_id) is True
    assert q.delete_milestone(project["project_id"], milestone_id) is False
    assert q.get_project(project["project_id"])["milestones"] == []


# ------------------------------------------------------------------------ routes
def test_route_create_update_delete(client):
    project = client.post("/api/projects", json={"name": "QWAPP"}).json()
    pid = project["project_id"]

    created = client.post(
        f"/api/projects/{pid}/milestones",
        json={"name": "Beta launch", "date": "2026-09-01"},
    )
    assert created.status_code == 201
    mid = created.json()["milestone_id"]

    patched = client.patch(
        f"/api/projects/{pid}/milestones/{mid}", json={"done": True}
    )
    assert patched.status_code == 200
    assert patched.json()["done"] is True
    assert patched.json()["date"] == "2026-09-01"

    assert client.delete(f"/api/projects/{pid}/milestones/{mid}").status_code == 204
    assert client.get(f"/api/projects/{pid}").json()["milestones"] == []


def test_route_create_on_unknown_project_404s(client):
    """
    DynamoDB has no foreign keys, so this check is the only thing preventing an
    orphan - a stored milestone that no screen will ever draw.
    """
    response = client.post(
        "/api/projects/does-not-exist/milestones", json={"name": "Ghost"}
    )
    assert response.status_code == 404


def test_route_patch_and_delete_unknown_milestone_404(client):
    project = client.post("/api/projects", json={"name": "QWAPP"}).json()
    pid = project["project_id"]

    assert client.patch(f"/api/projects/{pid}/milestones/nope", json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/projects/{pid}/milestones/nope").status_code == 404


def test_route_rejects_an_over_long_note(client):
    project = client.post("/api/projects", json={"name": "QWAPP"}).json()

    response = client.post(
        f"/api/projects/{project['project_id']}/milestones",
        json={"name": "Beta", "note": "x" * 501},
    )
    assert response.status_code == 422


def test_create_project_with_milestones_through_the_route(client):
    response = client.post(
        "/api/projects",
        json={
            "name": "QWAPP",
            "phases": [{"name": "Planning"}],
            "milestones": [{"name": "Beta launch", "date": "2026-09-01"}],
        },
    )

    assert response.status_code == 201
    assert [m["name"] for m in response.json()["milestones"]] == ["Beta launch"]


def test_audit_records_the_milestone_change(client):
    project = client.post("/api/projects", json={"name": "QWAPP"}).json()
    pid = project["project_id"]
    mid = client.post(
        f"/api/projects/{pid}/milestones", json={"name": "Beta", "date": "2026-09-01"}
    ).json()["milestone_id"]

    client.patch(f"/api/projects/{pid}/milestones/{mid}", json={"date": None})

    history = client.get(f"/api/projects/{mid}/history").json()
    update = [h for h in history if h["action"] == "update"][0]
    assert update["entity"] == "milestone"
    assert update["before"]["date"] == "2026-09-01"
    # The cleared date has to survive as a real null in the snapshot, or the audit
    # trail cannot show that un-scheduling is what happened.
    assert update["after"]["date"] is None


# ------------------------------------------------------------------------- report
def test_milestone_date_widens_the_roadmap_span(client):
    """
    A deadline past the last phase must not fall off the right of the chart.

    That is the entire reason somebody recorded it, and a span computed from phases
    alone would clip it out of view while still returning it in the payload.
    """
    client.post(
        "/api/projects",
        json={
            "name": "QWAPP",
            "phases": [{"name": "Planning", "start": "2026-01-01", "end": "2026-02-01"}],
            "milestones": [{"name": "Regulatory deadline", "date": "2026-12-31"}],
        },
    )

    roadmap = client.get("/api/roadmap").json()

    assert roadmap["span_start"] == "2026-01-01"
    assert roadmap["span_end"] == "2026-12-31"
