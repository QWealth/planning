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
    MilestoneModel,
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


# -------------------------------------------------- under a phase, or under none
def test_a_milestone_belongs_to_no_phase_by_default(aws):
    """
    The unattached case is the default, not the fallback.

    "Regulatory deadline" is not a step inside any one stage of the work, and the
    field being absent from a request has to mean exactly that rather than being
    treated as an unfinished form.
    """
    project = q.create_project(name="Vault", milestones=[{"name": "Deadline"}])

    assert project["milestones"][0]["phase_id"] is None
    assert q.create_milestone(project["project_id"], {"name": "Go live"})["phase_id"] is None


def test_a_milestone_can_name_a_phase_of_its_own_project(aws):
    project = q.create_project(name="Vault", phases=[{"name": "Infra"}])
    phase_id = project["phases"][0]["phase_id"]

    created = q.create_milestone(
        project["project_id"], {"name": "Infra hardening signed off", "phase_id": phase_id}
    )

    assert created["phase_id"] == phase_id
    # And it survives the read path, not just the write's return value.
    assert q.get_project(project["project_id"])["milestones"][0]["phase_id"] == phase_id


def test_a_phase_id_naming_nothing_is_refused(aws):
    """
    There are no foreign keys, so this check is the only thing standing between a
    typo and a milestone filed under a heading the chart never draws - stored,
    returned by the API, visible nowhere.
    """
    project = q.create_project(name="Vault")

    try:
        q.create_milestone(project["project_id"], {"name": "Ship", "phase_id": "nope"})
    except q.ValidationError:
        pass
    else:
        raise AssertionError("a dangling phase_id must not be storable")


def test_a_phase_from_another_project_is_refused(aws):
    """
    The reference is scoped to the project, not to "does this phase exist anywhere".

    Phases are partitioned on project_id, so a phase id copied from another lane
    would look real to a global existence check and resolve to nothing on the lane
    that stored it. This is the mistake a copied id actually produces.
    """
    mine = q.create_project(name="Vault")
    theirs = q.create_project(name="Tax", phases=[{"name": "Infra"}])
    stolen = theirs["phases"][0]["phase_id"]

    try:
        q.create_milestone(mine["project_id"], {"name": "Ship", "phase_id": stolen})
    except q.ValidationError:
        pass
    else:
        raise AssertionError("a phase_id must name a phase of the SAME project")


def test_patch_can_attach_then_detach(aws):
    """
    Both directions are ordinary edits, and null is the one that must not be dropped.

    `"phase_id": null` means "this belongs to the project, not to that stage" - the
    absent/null distinction the whole Update schema exists for. A queries layer that
    tested `if changes.get("phase_id")` would silently ignore it.
    """
    project = q.create_project(name="Vault", phases=[{"name": "Infra"}], milestones=[{"name": "Ship"}])
    phase_id = project["phases"][0]["phase_id"]
    milestone_id = project["milestones"][0]["milestone_id"]
    pid = project["project_id"]

    attached = q.update_milestone(pid, milestone_id, {"phase_id": phase_id})
    assert attached["phase_id"] == phase_id

    detached = q.update_milestone(pid, milestone_id, {"phase_id": None})
    assert detached["phase_id"] is None
    assert detached["name"] == "Ship"


def test_patch_leaves_an_unmentioned_phase_alone(aws):
    """Renaming a milestone must not un-file it, same rule as the date."""
    project = q.create_project(name="Vault", phases=[{"name": "Infra"}], milestones=[{"name": "Ship"}])
    phase_id = project["phases"][0]["phase_id"]
    pid, milestone_id = project["project_id"], project["milestones"][0]["milestone_id"]
    q.update_milestone(pid, milestone_id, {"phase_id": phase_id})

    updated = q.update_milestone(pid, milestone_id, {"name": "Ship it"})

    assert updated["phase_id"] == phase_id


def test_patch_of_another_field_tolerates_an_already_dangling_phase(aws):
    """
    Only a phase_id that was SENT is checked.

    Validating the merged result - update_phase's pattern, and the wrong one here -
    would re-check the stored attachment on every unrelated PATCH. A milestone left
    pointing at a phase that went away by some other route would then refuse to have
    its name fixed, punishing the wrong edit for a mess it did not make.
    """
    project = q.create_project(name="Vault", phases=[{"name": "Infra"}], milestones=[{"name": "Ship"}])
    pid = project["project_id"]
    phase_id = project["phases"][0]["phase_id"]
    milestone_id = project["milestones"][0]["milestone_id"]
    q.update_milestone(pid, milestone_id, {"phase_id": phase_id})

    # Straight at the table, so the detach in delete_phase does not run. This is the
    # hand-repaired state, not something the API can produce.
    q.get_projects_table().delete_item(
        Key={"project_id": pid, "sk": f"{PHASE_SK_PREFIX}{phase_id}"}
    )

    updated = q.update_milestone(pid, milestone_id, {"name": "Ship it"})

    assert updated["name"] == "Ship it"
    assert updated["phase_id"] == phase_id


def test_an_empty_phase_id_means_no_phase(aws):
    """
    `""` is what a `<select>`'s "Not tied to a phase" option submits.

    Left as an empty string it passes a truthy check, matches no phase, and would be
    refused as a dangling reference - a 400 for what the person correctly answered as
    "none". Normalised in the schema, so both create and patch get it.
    """
    assert MilestoneCreate(name="Ship", phase_id="").phase_id is None
    assert MilestoneCreate(name="Ship", phase_id="   ").phase_id is None
    assert MilestoneUpdate(phase_id="").changes() == {"phase_id": None}


def test_deleting_a_phase_detaches_its_milestones(aws):
    """
    DELETING A PHASE PROMOTES ITS MILESTONES; IT DOES NOT TAKE THEM WITH IT.

    A milestone is a commitment somebody made, and "we restructured the phases" is
    not a decision to drop it. Leaving the id behind would be worse than either
    option: the milestone would still exist and would group under a heading nothing
    draws. Only the milestones of THAT phase move.
    """
    project = q.create_project(
        name="Vault",
        phases=[{"name": "Infra"}, {"name": "Build"}],
        milestones=[{"name": "Hardened"}, {"name": "Built"}, {"name": "Deadline"}],
    )
    pid = project["project_id"]
    infra, build = (p["phase_id"] for p in project["phases"])
    by_name = {m["name"]: m["milestone_id"] for m in project["milestones"]}
    q.update_milestone(pid, by_name["Hardened"], {"phase_id": infra})
    q.update_milestone(pid, by_name["Built"], {"phase_id": build})

    assert q.delete_phase(pid, infra) is True

    after = {m["name"]: m["phase_id"] for m in q.get_project(pid)["milestones"]}
    assert after == {"Hardened": None, "Built": build, "Deadline": None}


def test_deleting_a_phase_leaves_another_project_alone(aws):
    """Same guard as the create check, from the other side of the write."""
    mine = q.create_project(name="Vault", phases=[{"name": "Infra"}])
    theirs = q.create_project(name="Tax", phases=[{"name": "Infra"}], milestones=[{"name": "Ship"}])
    q.update_milestone(
        theirs["project_id"],
        theirs["milestones"][0]["milestone_id"],
        {"phase_id": theirs["phases"][0]["phase_id"]},
    )

    q.delete_phase(mine["project_id"], mine["phases"][0]["phase_id"])

    still = q.get_project(theirs["project_id"])["milestones"][0]
    assert still["phase_id"] == theirs["phases"][0]["phase_id"]


def test_create_project_refuses_a_milestone_that_names_a_phase(aws):
    """
    There is no id a caller could have meant on this path.

    The phases in the same request are getting their ids inside this call, so any
    string sent here names a phase of some other project. Storing it would file the
    milestone under a heading this lane never draws; ignoring it would accept the
    request and lose the attachment. Neither is honest.
    """
    try:
        q.create_project(
            name="Vault",
            phases=[{"name": "Infra"}],
            milestones=[{"name": "Hardened", "phase_id": "guessed"}],
        )
    except q.ValidationError:
        pass
    else:
        raise AssertionError("create_project must refuse a milestone's phase_id")


def test_a_milestone_written_before_this_field_existed_reads_as_unattached(aws):
    """
    Absent and "attached to nothing" are the same fact here.

    Every milestone in the table predates the field, so from_item has to answer for
    an item with no such attribute. Unlike `date`, where absent and null would mean
    different things, there is nothing to distinguish - so no migration is needed.
    """
    legacy = {
        "project_id": "p1",
        "sk": f"{MILESTONE_SK_PREFIX}m1",
        "milestone_id": "m1",
        "name": "Beta launch",
        "date": "2026-09-01",
        "done": False,
    }

    assert MilestoneModel.from_item(legacy)["phase_id"] is None


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


def test_route_attaches_a_milestone_to_a_phase(client):
    project = client.post(
        "/api/projects", json={"name": "QWAPP", "phases": [{"name": "Infra"}]}
    ).json()
    pid = project["project_id"]
    phase_id = project["phases"][0]["phase_id"]

    created = client.post(
        f"/api/projects/{pid}/milestones",
        json={"name": "Infra hardening signed off", "phase_id": phase_id},
    )
    assert created.status_code == 201
    assert created.json()["phase_id"] == phase_id

    # And "" from a select's "Not tied to a phase" option detaches rather than 400s.
    detached = client.patch(
        f"/api/projects/{pid}/milestones/{created.json()['milestone_id']}",
        json={"phase_id": ""},
    )
    assert detached.status_code == 200
    assert detached.json()["phase_id"] is None


def test_route_400s_on_a_phase_id_that_is_not_this_projects(client):
    """A 400 with a reason, not a stored row nothing draws."""
    mine = client.post("/api/projects", json={"name": "QWAPP"}).json()
    theirs = client.post(
        "/api/projects", json={"name": "Tax", "phases": [{"name": "Infra"}]}
    ).json()

    response = client.post(
        f"/api/projects/{mine['project_id']}/milestones",
        json={"name": "Ship", "phase_id": theirs["phases"][0]["phase_id"]},
    )

    assert response.status_code == 400
    assert "phase" in response.json()["detail"]


def test_route_400s_on_a_created_project_whose_milestone_names_a_phase(client):
    response = client.post(
        "/api/projects",
        json={
            "name": "QWAPP",
            "phases": [{"name": "Infra"}],
            "milestones": [{"name": "Hardened", "phase_id": "guessed"}],
        },
    )

    assert response.status_code == 400


def test_route_deleting_a_phase_audits_each_detached_milestone(client):
    """
    The detach is a real edit to a real row and gets its own audit entry.

    Folding it into the phase's delete entry would make "why is this milestone no
    longer under Infra" answerable only by somebody who already knew to go and read
    a different entity's history.
    """
    project = client.post(
        "/api/projects", json={"name": "QWAPP", "phases": [{"name": "Infra"}]}
    ).json()
    pid = project["project_id"]
    phase_id = project["phases"][0]["phase_id"]
    mid = client.post(
        f"/api/projects/{pid}/milestones", json={"name": "Hardened", "phase_id": phase_id}
    ).json()["milestone_id"]

    assert client.delete(f"/api/projects/{pid}/phases/{phase_id}").status_code == 204

    # The milestone survived the phase, unattached.
    milestones = client.get(f"/api/projects/{pid}").json()["milestones"]
    assert [(m["name"], m["phase_id"]) for m in milestones] == [("Hardened", None)]

    history = client.get(f"/api/projects/{mid}/history").json()
    detach = [h for h in history if h["action"] == "update"][0]
    assert detach["entity"] == "milestone"
    assert detach["before"]["phase_id"] == phase_id
    assert detach["after"]["phase_id"] is None


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
