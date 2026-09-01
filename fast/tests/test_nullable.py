"""The absent-vs-null distinction, which is the reason this app exists.

Excel could not tell "not scheduled yet" from "scheduled to nothing", so it drew
bars in January 1900 and reported nothing. Every test here pins one half of the
replacement rule:

    field omitted from the PATCH  -> leave the stored value alone
    field present with value null -> store null, meaning unscheduled

If these two ever collapse into each other, the app has quietly reacquired the
workbook's defining bug, and it will not be visible on screen - an unscheduled phase
and a phase whose dates were destroyed by an unrelated edit look identical.
"""

from app.db.queries import projects as q


def _project_with_phase(**phase):
    base = {"name": "Coding", "phase_order": 0}
    base.update(phase)
    return q.create_project(name="Net Worth", lane_order=0, phases=[base])


def test_omitted_field_leaves_dates_alone(aws):
    """Renaming a phase must not wipe its schedule."""
    project = _project_with_phase(start="2026-01-05", end="2026-03-31", progress=0.4)
    phase_id = project["phases"][0]["phase_id"]

    updated = q.update_phase(project["project_id"], phase_id, {"name": "Coding & review"})

    assert updated["name"] == "Coding & review"
    assert updated["start"] == "2026-01-05"
    assert updated["end"] == "2026-03-31"
    assert updated["progress"] == 0.4


def test_explicit_null_clears_a_date(aws):
    """Un-scheduling is a real edit and has to be expressible."""
    project = _project_with_phase(start="2026-01-05", end="2026-03-31")
    phase_id = project["phases"][0]["phase_id"]

    updated = q.update_phase(project["project_id"], phase_id, {"start": None, "end": None})

    assert updated["start"] is None
    assert updated["end"] is None
    # And it survives the round trip rather than being re-read as something else.
    assert q.get_phase(project["project_id"], phase_id)["start"] is None


def test_zero_progress_is_not_null(aws):
    """
    0.0 means "started, nothing done". None means "nobody has said".

    A truthy check in from_item would merge them, and the roadmap would report a
    phase as unmeasured when someone had explicitly measured it at zero. Four phases
    in the migrated data are in the None state and none are at 0.0, so this would
    have gone unnoticed for a long time.
    """
    project = _project_with_phase(progress=0.0)
    phase = q.get_phase(project["project_id"], project["phases"][0]["phase_id"])

    assert phase["progress"] == 0.0
    assert phase["progress"] is not None


def test_progress_is_stored_without_float_error(aws):
    """
    Decimal(str(x)), not Decimal(x).

    Decimal(0.85) is 0.85000000000000008882, which stores fine and comes back as a
    progress bar labelled 85.00000000000001%.
    """
    project = _project_with_phase(progress=0.85)
    phase = q.get_phase(project["project_id"], project["phases"][0]["phase_id"])

    assert phase["progress"] == 0.85


def test_patch_schema_separates_absent_from_null():
    """The Pydantic half of the same rule, independent of DynamoDB."""
    from app.schemas.projects import PhaseUpdate

    assert PhaseUpdate(name="x").changes() == {"name": "x"}
    assert PhaseUpdate(start=None).changes() == {"start": None}
    assert "start" not in PhaseUpdate(name="x").changes()


def test_api_patch_preserves_unmentioned_dates(client):
    """End to end, through the route, because that is where the bug would appear."""
    created = client.post(
        "/api/projects",
        json={
            "name": "Enhanced Data Delivery",
            "lane_order": 1,
            "phases": [{"name": "Accounts", "start": "2026-02-02", "end": "2026-04-30"}],
        },
    ).json()
    pid = created["project_id"]
    phase_id = created["phases"][0]["phase_id"]

    patched = client.patch(
        f"/api/projects/{pid}/phases/{phase_id}", json={"progress": 0.25}
    ).json()

    assert patched["start"] == "2026-02-02"
    assert patched["end"] == "2026-04-30"
    assert patched["progress"] == 0.25

    cleared = client.patch(
        f"/api/projects/{pid}/phases/{phase_id}", json={"start": None}
    ).json()

    assert cleared["start"] is None
    assert cleared["end"] == "2026-04-30"
