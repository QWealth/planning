"""The audit trail.

The workbook had no answer to "who moved this date" - it was one file on a share,
edited by whoever had it open. Every mutation here writes a before/after row, and
the table is keyed entity_id + timestamp so the answer is one Query rather than a
full scan (which is the shape the marketing tool's own config.py records as a
mistake).
"""

from app.db.queries import audit, people as people_q, projects as q


def test_every_mutation_is_recorded(client, aws):
    created = client.post(
        "/api/projects",
        json={"name": "D2", "lane_order": 0, "phases": [{"name": "Coding"}]},
    ).json()
    pid = created["project_id"]

    client.patch(f"/api/projects/{pid}", json={"dri_email": "joe@qwealth.com"})

    rows = audit.history(pid)
    actions = [r["action"] for r in rows]

    assert "create" in actions
    assert "update" in actions
    assert all(r["user_email"] == "tester@qwealth.com" for r in rows)


def test_history_is_newest_first(client, aws):
    created = client.post("/api/projects", json={"name": "Net Worth"}).json()
    pid = created["project_id"]
    client.patch(f"/api/projects/{pid}", json={"name": "Net Worth v2"})
    client.patch(f"/api/projects/{pid}", json={"name": "Net Worth v3"})

    rows = audit.history(pid)

    assert rows[0]["after"]["name"] == "Net Worth v3"


def test_before_and_after_capture_the_actual_change(client, aws):
    """
    The before-snapshot is read prior to the write.

    Reading it afterwards would record the new value twice, producing a trail that
    answers "what is it now" - which the record itself already answers - rather than
    "what did this person do".
    """
    created = client.post(
        "/api/projects",
        json={
            "name": "Enhanced Data Delivery",
            "phases": [{"name": "Testing", "start": "2026-03-02", "end": "2026-04-30"}],
        },
    ).json()
    pid, phase_id = created["project_id"], created["phases"][0]["phase_id"]

    client.patch(f"/api/projects/{pid}/phases/{phase_id}", json={"end": "2026-06-30"})

    row = audit.history(phase_id)[0]

    assert row["before"]["end"] == "2026-04-30"
    assert row["after"]["end"] == "2026-06-30"


def test_clearing_a_date_is_visible_in_the_trail(client, aws):
    """
    "Who un-scheduled this" has to be as answerable as "who moved it".

    A null in the after-snapshot must be a real JSON null, not a dropped key -
    otherwise the trail cannot distinguish an un-scheduling from an edit that never
    touched the field.
    """
    created = client.post(
        "/api/projects",
        json={"name": "DocuTelligence", "phases": [{"name": "Planning", "start": "2026-01-05"}]},
    ).json()
    pid, phase_id = created["project_id"], created["phases"][0]["phase_id"]

    client.patch(f"/api/projects/{pid}/phases/{phase_id}", json={"start": None})

    row = audit.history(phase_id)[0]

    assert row["before"]["start"] == "2026-01-05"
    assert "start" in row["after"]
    assert row["after"]["start"] is None


def test_deleting_a_phase_keeps_its_content(client, aws):
    """A phase is hard-deleted, so the audit row is the only surviving copy."""
    created = client.post(
        "/api/projects",
        json={"name": "Qfeed", "phases": [{"name": "Architecting", "progress": 0.6}]},
    ).json()
    pid, phase_id = created["project_id"], created["phases"][0]["phase_id"]

    client.delete(f"/api/projects/{pid}/phases/{phase_id}")

    row = audit.history(phase_id)[0]

    assert row["action"] == "delete"
    assert row["before"]["name"] == "Architecting"
    assert row["before"]["progress"] == 0.6


def test_recent_by_entity_uses_the_gsi(client, aws):
    """The second question: "what changed lately", across all projects."""
    client.post("/api/projects", json={"name": "One"})
    client.post("/api/projects", json={"name": "Two"})

    rows = audit.recent("project")

    assert len(rows) >= 2
    assert {r["after"]["name"] for r in rows} >= {"One", "Two"}


def test_a_failed_audit_write_does_not_fail_the_request(client, aws, monkeypatch, caplog):
    """
    Deliberate trade: a gap in the history beats blocking the edit.

    For an internal planning tool, a transient DynamoDB error on the audit table
    should not stop people rescheduling work. The compensating control is that the
    failure is logged at error with the payload intact. This trade would be the
    wrong way round for the compliance tool, where the trail is the artefact a
    regulator is shown.
    """
    from botocore.exceptions import ClientError

    def boom(*args, **kwargs):
        raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException"}}, "PutItem")

    monkeypatch.setattr(audit, "get_audit_table", lambda: type("T", (), {"put_item": boom})())

    response = client.post("/api/projects", json={"name": "Still Works"})

    assert response.status_code == 201
    assert any("Audit write failed" in r.message for r in caplog.records)


def test_person_changes_are_audited(client, aws):
    people_q.create_person(email="joe@qwealth.com", name="Joe")

    client.patch("/api/people/joe@qwealth.com", json={"name": "Joe B"})

    row = audit.history("joe@qwealth.com")[0]

    assert row["entity"] == "person"
    assert row["before"]["name"] == "Joe"
    assert row["after"]["name"] == "Joe B"
