"""The roadmap aggregate: one request that carries the whole chart.

This file used to also cover the live gap report, which has been removed along with
the "Still to decide" panel that displayed it.

What is left pins the properties that make the aggregate safe to draw from: an empty
roadmap reports an empty span rather than one centred on today, the span covers every
date including milestones, and one malformed stored row degrades to a single odd row
rather than a 500.
"""

from app.db.queries import people as people_q, projects as q


def _seed():
    q.create_project(
        name="QWAPP",
        lane_order=0,
        dri_email="joe@qwealth.com",
        support_email="timan@qwealth.com",
        phases=[
            {"name": "Planning", "start": "2026-01-05", "end": "2026-01-30", "progress": 1.0},
            {"name": "Coding", "start": "2026-02-02", "end": "2026-05-29", "progress": 0.4},
            {"name": "Maintenance", "structural": True, "phase_order": 9},
        ],
    )
    q.create_project(
        name="Qfeed",
        lane_order=1,
        phases=[
            # The migrated state: all five phases were #REF! in the workbook, so
            # everything is null and honestly so.
            {"name": "Planning"},
            {"name": "Maintenance", "structural": True, "phase_order": 9},
        ],
    )


def test_roadmap_span_is_none_when_nothing_is_scheduled(aws, client):
    """
    An empty roadmap renders as empty, not as a one-day chart centred on today.

    Defaulting the span to now() would be the workbook's mistake in a new place: a
    chart that looks like data and is not.
    """
    q.create_project(name="Unscheduled Thing", phases=[{"name": "Planning"}])

    body = client.get("/api/roadmap").json()

    assert body["span_start"] is None
    assert body["span_end"] is None
    assert len(body["projects"]) == 1


def test_roadmap_span_covers_every_date(aws, client):
    _seed()

    body = client.get("/api/roadmap").json()

    assert body["span_start"] == "2026-01-05"
    assert body["span_end"] == "2026-05-29"


def test_workload_counts_ownership_per_person(aws, client):
    """
    The question the Team sheet could not answer without reading nine lanes by eye.

    Notably it has to report the zero: four people on the roster own nothing, and
    that only becomes visible when ownership is aggregated per person.
    """
    people_q.create_person(email="joe@qwealth.com", name="Joe")
    people_q.create_person(email="timan@qwealth.com", name="Timan")
    people_q.create_person(email="artem@qwealth.com", name="Artem")
    _seed()

    rows = {p["email"]: p for p in client.get("/api/people/workload").json()}

    assert rows["joe@qwealth.com"]["dri_project_ids"] != []
    assert rows["timan@qwealth.com"]["support_project_ids"] != []
    assert rows["artem@qwealth.com"]["dri_project_ids"] == []
    assert rows["artem@qwealth.com"]["support_project_ids"] == []
    assert rows["artem@qwealth.com"]["owned_phase_count"] == 0


def test_workload_route_is_not_shadowed_by_the_email_route(aws, client):
    """
    /workload must be declared before /{email}.

    FastAPI matches in declaration order, so the other way round resolves this as a
    person whose email is the literal string "workload" and answers 404 forever.
    """
    assert client.get("/api/people/workload").status_code == 200


def test_one_odd_stored_address_does_not_kill_the_whole_response(aws, client):
    """
    A malformed email in the table degrades to one odd row, never a dead endpoint.

    EmailStr on a *response* model would raise ResponseValidationError here and take
    the entire roster - and the whole roadmap screen - down with it. Validation
    belongs on the way in, where the caller can still be told what was wrong.

    Not hypothetical: seeding the local demo with @example.invalid addresses (an RFC
    2606 reserved TLD that email-validator refuses) turned GET /api/roadmap into a
    500 with nine perfectly good projects sitting in the table.
    """
    people_q.create_person(email="fine@qwealth.com", name="Fine")
    # Straight past the Pydantic input layer, exactly as the seed loader and any
    # hand-edited item would arrive.
    people_q.get_people_table().put_item(
        Item={"email": "not-an-address", "name": "Legacy Row", "active": True}
    )

    response = client.get("/api/people")

    assert response.status_code == 200
    assert {p["email"] for p in response.json()} == {"fine@qwealth.com", "not-an-address"}
    assert client.get("/api/roadmap").status_code == 200
