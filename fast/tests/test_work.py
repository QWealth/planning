"""
RFCs and tasks: the one-level nesting cap, orphan promotion, and absent-vs-null.

WHAT THESE TESTS ARE ACTUALLY GUARDING
--------------------------------------
Tickets and tasks are ONE entity here, told apart only by a nullable `parent_id`.
That collapse buys a lot - one table, one set of routes, one board - and it is only
safe because the shape is constrained rather than hoped for. Every constraint is
invisible on screen when it breaks:

  * A three-deep tree renders as a board that silently drops a level, or as a
    recursive render that never terminates.
  * A cascade delete looks exactly like "the subtasks were never there".
  * Losing absent-vs-null means renaming a subtask detaches it from its ticket, and
    the only symptom is a task that moved somewhere nobody moved it.

None of the three produce an error, which is why they get tests rather than trust.

The nesting rules are checked at the queries layer, where they live, and once more
through the API so the 400 is proven to be a 400 and not a 500 with a traceback.
"""

import pytest

from app.db.queries import work as q
from app.work import Kind, RfcStatus, TaskStatus


def _rfc(**over):
    body = {
        "title": "How we do code review",
        "body": "# Proposal\n\nTwo approvals.",
        "status": RfcStatus.DRAFT.value,
    }
    body.update(over)
    return q.create_rfc(body)


def _task(**over):
    body = {"title": "Wire up the board", "status": TaskStatus.BACKLOG.value}
    body.update(over)
    return q.create_task(body)


# ------------------------------------------------------------------ the two kinds
def test_rfc_needs_no_project(aws):
    """
    An RFC about no project in particular is the point of the whole feature.

    In the projects table this was unrepresentable: project_id is its partition key,
    so "attached to nothing" would have needed a sentinel partition. Here it is an
    ordinary nullable attribute, and it has to survive the round trip as null rather
    than as the empty string DynamoDB would happily store instead.
    """
    rfc = _rfc()

    assert rfc["project_id"] is None
    assert q.get_rfc(rfc["item_id"])["project_id"] is None
    assert rfc["kind"] == Kind.RFC.value


def test_an_rfc_is_not_a_task(aws):
    """
    Shared table, separate accessors, and the id namespace is not a defence.

    get_task on an RFC's id must return None rather than an item missing every field
    a task has. Otherwise a mistyped id in a URL renders a half-built task instead of
    a 404, and the fields it lacks read as "not filled in yet".
    """
    rfc = _rfc()
    task = _task()

    assert q.get_task(rfc["item_id"]) is None
    assert q.get_rfc(task["item_id"]) is None


def test_a_ticket_is_just_a_task_with_children(aws):
    """There is no Ticket entity, and children_of is the only thing that says so."""
    ticket = _task(title="Search is slow")
    a = _task(title="Profile the query", parent_id=ticket["item_id"])
    b = _task(title="Add the index", parent_id=ticket["item_id"])

    kids = {t["item_id"] for t in q.children_of(ticket["item_id"])}
    assert kids == {a["item_id"], b["item_id"]}
    # And the ticket itself stays in the top-level list. A board that hid parents
    # would leave a ticket with no subtasks yet nowhere to be seen.
    assert ticket["item_id"] in {t["item_id"] for t in q.top_level_tasks()}
    assert a["item_id"] not in {t["item_id"] for t in q.top_level_tasks()}


# ------------------------------------------------------------- the one-level cap
def test_cannot_parent_onto_a_subtask(aws):
    """The cap from below: the proposed parent already has a parent."""
    ticket = _task()
    subtask = _task(parent_id=ticket["item_id"])

    with pytest.raises(q.ValidationError, match="one level deep"):
        _task(title="Too deep", parent_id=subtask["item_id"])


def test_cannot_give_a_parent_to_a_task_that_has_children(aws):
    """
    The cap from above, and the half that is easy to forget.

    Checking only the proposed parent still admits a three-deep tree: attach a
    ticket that already has subtasks underneath another ticket and the subtasks are
    now grandchildren. Nothing rejects the write; the depth appears one level away
    from the row being edited.
    """
    ticket = _task(title="Search is slow")
    _task(title="Profile the query", parent_id=ticket["item_id"])
    other = _task(title="Unrelated ticket")

    with pytest.raises(q.ValidationError, match="subtasks of its own"):
        q.update_task(ticket["item_id"], {"parent_id": other["item_id"]})


def test_a_task_cannot_be_its_own_parent(aws):
    """The one cycle a depth rule alone would still let through."""
    task = _task()

    with pytest.raises(q.ValidationError, match="its own parent"):
        q.update_task(task["item_id"], {"parent_id": task["item_id"]})


def test_unknown_parent_is_refused(aws):
    """
    DynamoDB has no foreign keys, so this is the only thing preventing it.

    Without the check the task is stored, costs money, and never appears on any
    board - the grouping is by parent_id and no such parent exists to group under.
    """
    with pytest.raises(q.ValidationError, match="no such parent"):
        _task(parent_id="tsk_doesnotexist")


def test_an_rfc_cannot_be_a_parent(aws):
    """Same table, same id shape, and a task hanging off an RFC is nonsense."""
    rfc = _rfc()

    with pytest.raises(q.ValidationError, match="no such parent"):
        _task(parent_id=rfc["item_id"])


def test_reparenting_between_tickets_is_allowed(aws):
    """The cap forbids depth, not movement. Moving a subtask is a daily edit."""
    first = _task(title="Ticket one")
    second = _task(title="Ticket two")
    subtask = _task(parent_id=first["item_id"])

    moved = q.update_task(subtask["item_id"], {"parent_id": second["item_id"]})

    assert moved["parent_id"] == second["item_id"]
    assert q.children_of(first["item_id"]) == []


# --------------------------------------------------------------- absent vs null
def test_omitted_parent_leaves_the_link_alone(aws):
    """
    Renaming a subtask must not rip it out of its ticket.

    This is the failure the absent/null rule exists to prevent, and it is silent:
    the task simply appears at the top of the backlog, with nothing on screen to say
    it was ever attached to anything.
    """
    ticket = _task()
    subtask = _task(title="Old name", parent_id=ticket["item_id"], due="2026-03-31")

    updated = q.update_task(subtask["item_id"], {"title": "New name"})

    assert updated["title"] == "New name"
    assert updated["parent_id"] == ticket["item_id"]
    assert updated["due"] == "2026-03-31"


def test_explicit_null_parent_promotes_to_top_level(aws):
    """"Actually this is its own piece of work" has to be expressible."""
    ticket = _task()
    subtask = _task(parent_id=ticket["item_id"])

    promoted = q.update_task(subtask["item_id"], {"parent_id": None})

    assert promoted["parent_id"] is None
    assert q.get_task(subtask["item_id"])["parent_id"] is None
    assert subtask["item_id"] in {t["item_id"] for t in q.top_level_tasks()}


def test_explicit_null_detaches_an_rfc_from_its_project(aws):
    """The same rule on the field the feature was asked for."""
    rfc = _rfc(project_id="proj_abc")

    detached = q.update_rfc(rfc["item_id"], {"project_id": None})

    assert detached["project_id"] is None
    assert q.get_rfc(rfc["item_id"])["project_id"] is None


def test_null_due_clears_only_the_due_date(aws):
    """Clearing one field must not take its neighbours with it."""
    task = _task(due="2026-03-31", owner_email="ha@qwealth.com")

    updated = q.update_task(task["item_id"], {"due": None})

    assert updated["due"] is None
    assert updated["owner_email"] == "ha@qwealth.com"


# ----------------------------------------------------------------------- deletes
def test_deleting_a_ticket_promotes_its_subtasks(aws):
    """
    NOT a cascade.

    Deleting a ticket is usually "this was raised in the wrong place", and quietly
    destroying work nobody asked to destroy is the worse of the two failures. The
    subtasks land in the backlog where somebody will see them; `dropped` is the
    status for deciding against work.
    """
    ticket = _task()
    a = _task(parent_id=ticket["item_id"])
    b = _task(parent_id=ticket["item_id"])

    assert q.delete_task(ticket["item_id"]) is True

    assert q.get_task(ticket["item_id"]) is None
    assert q.get_task(a["item_id"])["parent_id"] is None
    assert q.get_task(b["item_id"])["parent_id"] is None


def test_deleting_something_that_is_not_there_is_false_not_an_error(aws):
    """So the route can answer 404 rather than 500."""
    assert q.delete_task("tsk_nope") is False
    assert q.delete_rfc("rfc_nope") is False


def test_delete_respects_the_kind(aws):
    """Deleting an RFC through the task accessor would be a very quiet disaster."""
    rfc = _rfc()

    assert q.delete_task(rfc["item_id"]) is False
    assert q.get_rfc(rfc["item_id"]) is not None


# ------------------------------------------------------------------- allowlists
def test_kind_cannot_be_changed(aws):
    """
    An RFC does not become a task.

    They have different lifecycles and different field lists, so a flipped row would
    carry fields its new kind has no meaning for and be missing ones it needs.
    """
    rfc = _rfc()

    with pytest.raises(q.ValidationError, match="cannot update: kind"):
        q.update_rfc(rfc["item_id"], {"kind": Kind.TASK.value})


def test_created_at_cannot_be_overwritten(aws):
    """The allowlist is what stands between a raw request body and the key fields."""
    task = _task()

    with pytest.raises(q.ValidationError, match="cannot update"):
        q.update_task(task["item_id"], {"created_at": "1999-01-01T00:00:00"})


# ------------------------------------------------------------- status vocabulary
def test_a_parents_status_is_not_derived_from_its_children(aws):
    """
    Deliberate, and the kind of helpfulness that is worse than nothing.

    A ticket whose subtasks are all done is not necessarily done - the last one is
    usually "and deploy it". Deriving the status would mark it complete on somebody
    else's behalf and take it off the board before the work was finished.
    """
    ticket = _task(status=TaskStatus.IN_PROGRESS.value)
    a = _task(parent_id=ticket["item_id"])
    b = _task(parent_id=ticket["item_id"])

    q.update_task(a["item_id"], {"status": TaskStatus.DONE.value})
    q.update_task(b["item_id"], {"status": TaskStatus.DONE.value})

    assert q.get_task(ticket["item_id"])["status"] == TaskStatus.IN_PROGRESS.value


# ------------------------------------------------------------------------- api
def test_statuses_route_serves_the_vocabulary(client):
    """
    The client renders whatever it is given, so a sixth status is one deploy.

    Both catalogue routes are declared before /{item_id}; FastAPI matches in
    declaration order, and the other way round "statuses" is read as an item id.
    """
    rfcs = client.get("/api/rfcs/statuses")
    tasks = client.get("/api/tasks/statuses")

    assert rfcs.status_code == 200
    assert [s["status"] for s in rfcs.json()] == [s.value for s in RfcStatus]
    assert all(s["label"] and s["description"] for s in rfcs.json())
    assert [s["status"] for s in tasks.json()] == [s.value for s in TaskStatus]


def test_statuses_say_which_ones_are_closed(client):
    """
    So the client does not need its own copy of the closed set.

    A list that drew a withdrawn proposal exactly like a live one would be the only
    symptom of the frontend guessing, and it would look like a styling oversight
    rather than a vocabulary that had drifted.
    """
    closed = {s["status"]: s["closed"] for s in client.get("/api/rfcs/statuses").json()}

    assert closed == {
        "draft": False,
        "review": False,
        "accepted": True,
        "rejected": True,
        "withdrawn": True,
    }

    tasks = {s["status"]: s["closed"] for s in client.get("/api/tasks/statuses").json()}
    assert tasks["backlog"] is False and tasks["done"] is True and tasks["dropped"] is True


def test_create_an_rfc_over_the_api(client):
    """created_by comes from the token, never from the body."""
    response = client.post(
        "/api/rfcs",
        json={"title": "How we do code review", "body": "# Proposal", "status": "draft"},
    )

    assert response.status_code == 201
    created = response.json()
    assert created["created_by"] == "tester@qwealth.com"
    assert created["project_id"] is None
    assert created["item_id"].startswith("rfc_")


def test_created_by_cannot_be_spoofed(client):
    """
    An unknown field in the body is ignored rather than stored.

    created_by is the one field answering "who wrote this". Pydantic drops what the
    schema does not declare, and this pins that rather than assuming it.
    """
    response = client.post(
        "/api/rfcs",
        json={"title": "Sneaky", "status": "draft", "created_by": "someone@else.com"},
    )

    assert response.status_code == 201
    assert response.json()["created_by"] == "tester@qwealth.com"


def test_bad_status_is_rejected_by_the_schema(client):
    """
    A closed vocabulary, enforced at the edge.

    "in progress" with a space, or "todo" from a client written against a different
    board, has to 422 here. Stored, it would be a task that no status filter matches
    and that therefore appears on no column of the board at all.
    """
    response = client.post(
        "/api/tasks", json={"title": "Whatever", "status": "todo"}
    )

    assert response.status_code == 422


def test_empty_title_is_rejected(client):
    """A row nobody can identify on a list is not a row worth storing."""
    response = client.post("/api/tasks", json={"title": "", "status": "backlog"})

    assert response.status_code == 422


def test_oversized_body_fails_at_the_edge(client):
    """
    Better than a 500 from boto3 when the item passes DynamoDB's 400KB ceiling.

    The author has every reason to think a long RFC is reasonable, and the failure
    they get should name the problem rather than being a stack trace on save.
    """
    from app.schemas.work import MAX_BODY

    response = client.post(
        "/api/rfcs",
        json={"title": "Long", "status": "draft", "body": "x" * (MAX_BODY + 1)},
    )

    assert response.status_code == 422


def test_nesting_violation_is_a_400_not_a_500(client):
    """The rule is enforced in the queries layer; this proves the route maps it."""
    ticket = client.post("/api/tasks", json={"title": "Ticket", "status": "backlog"})
    parent_id = ticket.json()["item_id"]
    sub = client.post(
        "/api/tasks",
        json={"title": "Sub", "status": "backlog", "parent_id": parent_id},
    )

    response = client.post(
        "/api/tasks",
        json={"title": "Too deep", "status": "backlog", "parent_id": sub.json()["item_id"]},
    )

    assert response.status_code == 400
    assert "one level deep" in response.json()["detail"]


def test_patch_over_the_api_keeps_absent_absent(client):
    """The same rule as the queries test, through the Pydantic layer that feeds it."""
    created = client.post(
        "/api/tasks",
        json={"title": "Old", "status": "backlog", "due": "2026-03-31"},
    ).json()

    response = client.patch(
        "/api/tasks/%s" % created["item_id"], json={"title": "New"}
    )

    assert response.status_code == 200
    assert response.json()["due"] == "2026-03-31"


def test_patch_over_the_api_stores_an_explicit_null(client):
    """And the other half, which is the same request shape minus one word."""
    created = client.post(
        "/api/tasks",
        json={"title": "Old", "status": "backlog", "due": "2026-03-31"},
    ).json()

    response = client.patch(
        "/api/tasks/%s" % created["item_id"], json={"due": None}
    )

    assert response.status_code == 200
    assert response.json()["due"] is None


def test_missing_item_is_404_on_every_verb(client):
    """Including PATCH and DELETE, which would otherwise resurrect or 500."""
    assert client.get("/api/rfcs/rfc_nope").status_code == 404
    assert client.patch("/api/rfcs/rfc_nope", json={"title": "x"}).status_code == 404
    assert client.delete("/api/rfcs/rfc_nope").status_code == 404
    assert client.get("/api/tasks/tsk_nope").status_code == 404
    assert client.patch("/api/tasks/tsk_nope", json={"title": "x"}).status_code == 404
    assert client.delete("/api/tasks/tsk_nope").status_code == 404


def test_history_records_who_changed_what(client):
    """
    The audit row must hold the value from BEFORE the write.

    Reading the snapshot after the update records the new value twice, which answers
    "what is it now" - a question the record itself already answers - instead of
    "what did this person do".
    """
    created = client.post(
        "/api/rfcs", json={"title": "Draft one", "status": "draft"}
    ).json()

    client.patch(
        "/api/rfcs/%s" % created["item_id"], json={"status": "accepted"}
    )

    history = client.get("/api/rfcs/%s/history" % created["item_id"]).json()
    actions = [entry["action"] for entry in history]

    assert "create" in actions and "update" in actions
    update = next(e for e in history if e["action"] == "update")
    assert update["entity"] == "rfc"
    assert update["before"]["status"] == "draft"
    assert update["after"]["status"] == "accepted"
    assert update["user_email"] == "tester@qwealth.com"


def test_promoted_subtasks_get_their_own_audit_row(client):
    """
    Otherwise a task appears at the top of the backlog with nothing explaining it.

    The only other trace would be a delete entry filed under an id that no longer
    resolves to anything, which is not somewhere anyone would think to look.
    """
    ticket = client.post(
        "/api/tasks", json={"title": "Ticket", "status": "backlog"}
    ).json()
    sub = client.post(
        "/api/tasks",
        json={"title": "Sub", "status": "backlog", "parent_id": ticket["item_id"]},
    ).json()

    assert client.delete("/api/tasks/%s" % ticket["item_id"]).status_code == 204

    history = client.get("/api/tasks/%s/history" % sub["item_id"]).json()
    promotion = next(e for e in history if e["action"] == "update")

    assert promotion["before"]["parent_id"] == ticket["item_id"]
    assert promotion["after"]["parent_id"] is None


# --- filing a task under a phase --------------------------------------------
#
# The same arrangement milestones already have, so the tests that matter are the ones
# proving the reference cannot go stale: a phase from another project, a phase with no
# project, and a phase that gets deleted out from under the task.


def _project_with_phase(name: str = "DocuTelligence"):
    """A project and one phase of it. Returns (project_id, phase_id)."""
    from app.db.queries import projects as pq

    project = pq.create_project(name=name)
    phase = pq.create_phase(project["project_id"], {"name": "Coding", "phase_order": 0})
    return project["project_id"], phase["phase_id"]


def test_a_task_can_be_filed_under_a_phase(aws) -> None:
    from app.db.queries import work as q

    project_id, phase_id = _project_with_phase()
    task = q.create_task(
        {"title": "Wire up the queue", "status": "backlog", "project_id": project_id,
         "phase_id": phase_id}
    )
    assert task["phase_id"] == phase_id
    assert q.get_task(task["item_id"])["phase_id"] == phase_id


def test_a_task_with_no_phase_is_a_real_state(aws) -> None:
    # 287 tasks came across with no phase and nobody is going to hand-file them, so
    # unfiled has to stay first-class rather than be treated as missing data.
    from app.db.queries import work as q

    project_id, _ = _project_with_phase()
    assert q.create_task(
        {"title": "x", "status": "backlog", "project_id": project_id}
    )["phase_id"] is None


def test_a_phase_from_another_project_is_refused(aws) -> None:
    """
    DynamoDB has no foreign keys, so this would be stored happily and then group the
    task under a heading its own lane never draws - present in the API, invisible on
    the chart. Exactly what projects._check_phase_ref exists to prevent for milestones.
    """
    from app.db.queries import _updates, work as q

    mine, _ = _project_with_phase("Mine")
    _, theirs_phase = _project_with_phase("Theirs")

    with pytest.raises(_updates.ValidationError):
        q.create_task(
            {"title": "x", "status": "backlog", "project_id": mine, "phase_id": theirs_phase}
        )


def test_a_phase_without_a_project_is_refused(aws) -> None:
    # Not quietly cleared: "belongs to Coding, but to no project" is a half-finished
    # form, and a silent null makes it a task nobody can find under the phase they
    # thought they filed it against.
    from app.db.queries import _updates, work as q

    _, phase_id = _project_with_phase()
    with pytest.raises(_updates.ValidationError):
        q.create_task({"title": "x", "status": "backlog", "phase_id": phase_id})


def test_moving_a_task_and_its_phase_together_is_allowed(aws) -> None:
    """
    The case that decides where the check runs. Validating the new phase against the
    OLD project would refuse this, which is a legitimate edit.
    """
    from app.db.queries import work as q

    first, first_phase = _project_with_phase("First")
    second, second_phase = _project_with_phase("Second")
    task = q.create_task(
        {"title": "x", "status": "backlog", "project_id": first, "phase_id": first_phase}
    )

    moved = q.update_task(task["item_id"], {"project_id": second, "phase_id": second_phase})
    assert moved["project_id"] == second
    assert moved["phase_id"] == second_phase


def test_moving_only_the_project_refuses_a_now_stale_phase(aws) -> None:
    # Refused rather than silently cleared. "I moved it and it lost its phase" is the
    # kind of thing nobody notices until the task is missing from the lane.
    from app.db.queries import _updates, work as q

    first, first_phase = _project_with_phase("First")
    second, _ = _project_with_phase("Second")
    task = q.create_task(
        {"title": "x", "status": "backlog", "project_id": first, "phase_id": first_phase}
    )

    with pytest.raises(_updates.ValidationError):
        q.update_task(task["item_id"], {"project_id": second})


def test_a_task_can_be_unfiled(aws) -> None:
    from app.db.queries import work as q

    project_id, phase_id = _project_with_phase()
    task = q.create_task(
        {"title": "x", "status": "backlog", "project_id": project_id, "phase_id": phase_id}
    )
    assert q.update_task(task["item_id"], {"phase_id": None})["phase_id"] is None


def test_deleting_a_phase_promotes_its_tasks(client, aws) -> None:
    """
    Deleting a phase must not delete the work filed under it. The id would otherwise
    survive as a reference to a phase that is gone, and the task would group under a
    heading nothing draws - stored, returned, and invisible.
    """
    from app.db.queries import work as q

    project_id, phase_id = _project_with_phase()
    kept = q.create_task(
        {"title": "still real", "status": "backlog", "project_id": project_id,
         "phase_id": phase_id}
    )
    elsewhere = q.create_task(
        {"title": "untouched", "status": "backlog", "project_id": project_id}
    )

    assert client.delete(f"/api/projects/{project_id}/phases/{phase_id}").status_code == 204

    assert q.get_task(kept["item_id"])["phase_id"] is None
    assert q.get_task(kept["item_id"])["title"] == "still real"
    assert q.get_task(elsewhere["item_id"]) is not None
