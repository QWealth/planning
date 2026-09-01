"""
Deleting a person, and the assignment-blanking that makes it safe.

Projects and phases store an owner as an email string, not a foreign key, so nothing
in DynamoDB stops a roster row from being removed while four lanes still name it.
The whole risk of a hard delete lives in that gap, and so does this file: every test
here is really asking "is there anything left pointing at someone who no longer
exists?".

Deactivation is covered too, because the two now sit on different verbs and the easy
regression is for one to quietly start doing the other's job.
"""

from app.db.queries import audit
from app.db.queries import people as people_q
from app.db.queries import projects as q

JOE = "joe@qwealth.com"
TIMAN = "timan@qwealth.com"


def _roster(aws):
    people_q.create_person(email=JOE, name="Joe")
    people_q.create_person(email=TIMAN, name="Timan")


def _project(name, dri=None, support=None, phases=None, active=True):
    return q.create_project(
        name=name,
        dri_email=dri,
        support_email=support,
        active=active,
        phases=phases or [],
    )


def test_find_assignments_reports_every_role(aws):
    _roster(aws)
    _project("QWAPP", dri=JOE, phases=[{"name": "Coding", "owner_email": JOE}])
    _project("Tax", support=JOE)
    _project("D2", dri=TIMAN, phases=[{"name": "Planning", "owner_email": TIMAN}])

    found = q.find_assignments(JOE)

    assert [p["project_name"] for p in found["dri"]] == ["QWAPP"]
    assert [p["project_name"] for p in found["support"]] == ["Tax"]
    assert [p["phase_name"] for p in found["phases"]] == ["Coding"]


def test_find_assignments_is_case_insensitive(aws):
    """
    Stored addresses are lowercased on write, but the caller's is not guaranteed to be.

    A delete driven from a URL path segment can arrive as "Joe@qwealth.com". Matching
    it literally would report no assignments, blank nothing, and still remove the
    roster row - the exact dangling-reference state this module exists to prevent,
    reached by the route that was supposed to prevent it.
    """
    _roster(aws)
    _project("QWAPP", dri=JOE)

    assert len(q.find_assignments("Joe@QWealth.com ")["dri"]) == 1


def test_find_assignments_includes_archived_projects(aws):
    """An inactive lane still stores the email, so it still has to be cleared."""
    _roster(aws)
    _project("Retired thing", dri=JOE, active=False)

    assert len(q.find_assignments(JOE)["dri"]) == 1


def test_unassign_clears_both_roles_on_one_project(aws):
    """
    Being DRI and Support of the same lane is two references, not one.

    Handled per field rather than per project: a loop that stopped at the first match
    would leave the lane with a support_email pointing at a deleted person.
    """
    _roster(aws)
    created = _project("Solo", dri=JOE, support=JOE)

    q.unassign_person(JOE)

    after = q.get_project(created["project_id"])
    assert after["dri_email"] is None
    assert after["support_email"] is None


def test_unassign_leaves_other_people_alone(aws):
    """The lane must not lose its other owner because one of the two was deleted."""
    _roster(aws)
    created = _project(
        "Shared",
        dri=JOE,
        support=TIMAN,
        phases=[{"name": "Coding", "owner_email": TIMAN}],
    )

    q.unassign_person(JOE)

    after = q.get_project(created["project_id"])
    assert after["dri_email"] is None
    assert after["support_email"] == TIMAN
    assert after["phases"][0]["owner_email"] == TIMAN


def test_delete_route_removes_person_and_all_references(aws, client):
    _roster(aws)
    a = _project("QWAPP", dri=JOE, phases=[{"name": "Coding", "owner_email": JOE}])
    b = _project("Tax", support=JOE)

    response = client.delete(f"/api/people/{JOE}")
    assert response.status_code == 200

    body = response.json()
    assert body["email"] == JOE
    assert body["name"] == "Joe"
    assert [p["project_name"] for p in body["unassigned"]["dri"]] == ["QWAPP"]
    assert [p["project_name"] for p in body["unassigned"]["support"]] == ["Tax"]
    assert [p["phase_name"] for p in body["unassigned"]["phases"]] == ["Coding"]

    assert people_q.get_person(JOE) is None
    assert q.get_project(a["project_id"])["dri_email"] is None
    assert q.get_project(a["project_id"])["phases"][0]["owner_email"] is None
    assert q.get_project(b["project_id"])["support_email"] is None


def test_delete_route_404s_for_unknown_person(aws, client):
    assert client.delete("/api/people/nobody@qwealth.com").status_code == 404


def test_delete_does_not_touch_the_roadmap_beyond_unassigning(aws, client):
    """
    The lanes survive; only the names on them go.

    Worth stating because "delete the person" and "delete their work" are one careless
    join away from each other, and the phases carry the dates the chart is drawn from.
    """
    _roster(aws)
    _project("QWAPP", dri=JOE, phases=[{"name": "Coding", "owner_email": JOE}])

    client.delete(f"/api/people/{JOE}")

    roadmap = client.get("/api/roadmap").json()
    assert len(roadmap["projects"]) == 1
    assert len(roadmap["projects"][0]["phases"]) == 1


def test_delete_leaves_the_lane_unowned_rather_than_removing_it(aws, client):
    """
    Deleting the DRI must blank the assignment, not take the project with it.

    This used to also assert the now-unowned lane appeared in the gap report, which
    was the only thing that announced it. That report is gone, so nothing surfaces an
    unowned lane any more - it is visible on the chart's DRI cell and nowhere else.
    """
    _roster(aws)
    _project("QWAPP", dri=JOE)

    client.delete(f"/api/people/{JOE}")

    projects = client.get("/api/roadmap").json()["projects"]
    assert [p["name"] for p in projects] == ["QWAPP"]
    assert projects[0]["dri_email"] is None


def test_delete_is_audited_with_what_it_cleared(aws, client):
    """
    The audit row is the only trace left, so it has to carry the assignments.

    Recording just the person would leave "who was DRI of QWAPP before this" with no
    answer anywhere in the system.
    """
    _roster(aws)
    _project("QWAPP", dri=JOE)

    client.delete(f"/api/people/{JOE}")

    deletes = [row for row in audit.history(JOE) if row["action"] == "delete"]
    assert len(deletes) == 1
    assert deletes[0]["before"]["person"]["email"] == JOE
    assert deletes[0]["before"]["unassigned"]["dri"][0]["project_name"] == "QWAPP"


def test_deactivate_keeps_the_row_and_the_assignments(aws, client):
    """The gentler removal, and the point of keeping both: nothing is unassigned."""
    _roster(aws)
    created = _project("QWAPP", dri=JOE, phases=[{"name": "Coding", "owner_email": JOE}])

    response = client.post(f"/api/people/{JOE}/deactivate")
    assert response.status_code == 200
    assert response.json()["active"] is False

    assert people_q.get_person(JOE) is not None
    after = q.get_project(created["project_id"])
    assert after["dri_email"] == JOE
    assert after["phases"][0]["owner_email"] == JOE
