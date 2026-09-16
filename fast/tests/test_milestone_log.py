"""
The milestone-check log: writing an answer, and who may read it back.

Two things are pinned here and, like test_service_invite, they fail in opposite
directions:

  - The GATE must refuse. It is the only role-based check in the application and
    routes/milestone_log.py is explicit that it is a weak one, so the tests assert both
    that a non-BA gets a 403 and that the flag on /api/me agrees with the route. A tab
    that appears and then 403s is the specific failure worth preventing.

  - The LOG must keep what was said. The whole value of the feature is the reason
    somebody typed when a deadline moved, so the tests that matter are the ones proving
    a row survives the cases where the obvious implementation would drop it: a "not yet"
    with no milestone change, and an answer about a milestone that has since been
    deleted.
"""

import pytest

from app.db.queries import people as people_q, projects as projects_q, work as work_q


def _roster(email: str, roles: list) -> None:
    """Put somebody on the roster with the given roles."""
    people_q.create_person(
        email=email,
        name=email.split("@")[0],
        roles=roles,
        specialisations=[],
    )


def _milestone(done: bool = False) -> tuple:
    """A project with one milestone. Returns (project_id, milestone_id)."""
    project = projects_q.create_project(name="DocuTelligence", dri_email="dri@qwealth.com")
    milestone = projects_q.create_milestone(
        project["project_id"],
        {"name": "Pilot sign-off", "date": "2026-09-16", "done": done},
    )
    return project["project_id"], milestone["milestone_id"]


# --- the store ---------------------------------------------------------------


def test_an_answer_is_written_and_read_back(aws) -> None:
    work_q.create_milestone_check(
        {
            "project_id": "p1",
            "project_name": "DocuTelligence",
            "milestone_id": "m1",
            "milestone_name": "Pilot sign-off",
            "due": "2026-09-16",
            "asked_email": "dri@qwealth.com",
            "answer": "not_done",
            "reason": "Waiting on legal to come back.",
        }
    )
    rows = work_q.list_milestone_checks()
    assert len(rows) == 1
    assert rows[0]["reason"] == "Waiting on legal to come back."
    assert rows[0]["kind"] == "milestone-check"


def test_two_answers_to_one_question_are_both_kept(aws) -> None:
    """
    Not collapsed to the latest. "Not yet, waiting on legal" at 9am and "done" at 10am
    is a small story, and a conditional write would keep the first and drop the second.
    """
    for answer, reason in [("not_done", "waiting on legal"), ("done", None)]:
        work_q.create_milestone_check(
            {
                "project_id": "p1",
                "project_name": "D",
                "milestone_id": "m1",
                "milestone_name": "Sign-off",
                "due": "2026-09-16",
                "asked_email": "dri@qwealth.com",
                "answer": answer,
                "reason": reason,
            }
        )
    assert len(work_q.list_milestone_checks()) == 2


def test_the_log_records_the_milestone_as_asked_not_as_it_now_stands(aws) -> None:
    """
    The name and date are stored, not joined. A milestone renamed or rescheduled a
    fortnight later must not rewrite the record of a question already answered - and the
    entries most worth reading are exactly the ones that get rescheduled.
    """
    project_id, milestone_id = _milestone()
    work_q.create_milestone_check(
        {
            "project_id": project_id,
            "project_name": "DocuTelligence",
            "milestone_id": milestone_id,
            "milestone_name": "Pilot sign-off",
            "due": "2026-09-16",
            "asked_email": "dri@qwealth.com",
            "answer": "not_done",
            "reason": "slipped a week",
        }
    )
    projects_q.update_milestone(
        project_id, milestone_id, {"name": "Pilot sign-off (revised)", "date": "2026-09-23"}
    )

    row = work_q.list_milestone_checks()[0]
    assert row["milestone_name"] == "Pilot sign-off"
    assert row["due"] == "2026-09-16"


# --- the gate ----------------------------------------------------------------


def test_a_ba_may_read_the_log(client) -> None:
    _roster("tester@qwealth.com", ["ba"])
    assert client.get("/api/milestone-log").status_code == 200


def test_somebody_who_is_not_a_ba_is_refused(client) -> None:
    _roster("tester@qwealth.com", ["software-engineer"])
    response = client.get("/api/milestone-log")
    assert response.status_code == 403
    # The refusal names the role, because the fix is self-service and "forbidden" alone
    # sends people to ask an admin for something no admin can grant.
    assert "business analyst" in response.json()["detail"].lower()


def test_somebody_with_no_roster_row_is_refused(client) -> None:
    assert client.get("/api/milestone-log").status_code == 403


def test_a_ba_among_several_roles_still_counts(client) -> None:
    # Roles are additive. Somebody who is a BA and an engineer is a BA.
    _roster("tester@qwealth.com", ["software-engineer", "ba"])
    assert client.get("/api/milestone-log").status_code == 200


def test_an_admin_who_is_not_a_ba_is_refused(client, monkeypatch) -> None:
    """
    Deliberate rather than an oversight. The request was for BAs; admin is an
    authorisation tier rather than a job, and quietly widening a stated audience is not
    a thing to do by default. See routes/milestone_log.py.
    """
    from app import auth

    monkeypatch.setattr(auth, "DEV_ADMIN", True)
    _roster("tester@qwealth.com", ["leadership"])
    assert client.get("/api/milestone-log").status_code == 403


def test_the_identity_flag_agrees_with_the_route(client) -> None:
    """
    The one that stops a tab appearing over a route that will refuse it. Both come
    through routes/milestone_log.holds_ba, and this is what proves they still do.
    """
    _roster("tester@qwealth.com", ["software-engineer"])
    assert client.get("/api/me").json()["is_ba"] is False
    assert client.get("/api/milestone-log").status_code == 403

    people_q.update_person("tester@qwealth.com", {"roles": ["ba"]})
    assert client.get("/api/me").json()["is_ba"] is True
    assert client.get("/api/milestone-log").status_code == 200


# --- the service route -------------------------------------------------------


@pytest.fixture
def service_client(client, monkeypatch):
    """The same app, with the IAM door open. See test_service_invite for the allowlist."""
    from app import auth

    monkeypatch.setattr(auth, "require_service_caller", lambda request: "AardvarkTaskRole")
    from app.main import app
    from app.routes import service

    app.dependency_overrides[service.require_service_caller] = lambda: "AardvarkTaskRole"
    yield client
    app.dependency_overrides.clear()


def _answer(client, project_id: str, milestone_id: str, **overrides):
    body = {
        "actor_email": "dri@qwealth.com",
        "project_id": project_id,
        "milestone_id": milestone_id,
        "milestone_name": "Pilot sign-off",
        "project_name": "DocuTelligence",
        "due": "2026-09-16",
        "answer": "done",
    }
    body.update(overrides)
    return client.post("/api/service/milestones/answer", json=body)


def test_yes_ticks_the_milestone_and_logs_it(service_client) -> None:
    project_id, milestone_id = _milestone()
    response = _answer(service_client, project_id, milestone_id)

    assert response.status_code == 200
    assert response.json()["milestone_marked_done"] is True
    assert projects_q.get_milestone(project_id, milestone_id)["done"] is True
    assert len(work_q.list_milestone_checks()) == 1


def test_not_yet_logs_the_reason_and_leaves_the_milestone_alone(service_client) -> None:
    project_id, milestone_id = _milestone()
    response = _answer(
        service_client,
        project_id,
        milestone_id,
        answer="not_done",
        reason="Waiting on legal.",
    )

    assert response.status_code == 200
    assert response.json()["milestone_marked_done"] is False
    assert projects_q.get_milestone(project_id, milestone_id)["done"] is False
    assert work_q.list_milestone_checks()[0]["reason"] == "Waiting on legal."


def test_an_answer_about_a_deleted_milestone_is_still_logged(service_client) -> None:
    """
    The case the obvious implementation drops. "I was asked about this and it had
    already gone" is exactly what a reader of the log needs to see, and looking the
    milestone up first and bailing on a miss would throw it away.
    """
    project_id, milestone_id = _milestone()
    projects_q.delete_milestone(project_id, milestone_id)

    response = _answer(service_client, project_id, milestone_id)

    assert response.status_code == 200
    assert response.json() == {
        "actor_email": "dri@qwealth.com",
        "answer": "done",
        "milestone_marked_done": False,
        "logged": True,
    }
    assert len(work_q.list_milestone_checks()) == 1


def test_a_missing_reason_is_a_real_state(service_client) -> None:
    # A modal dismissed rather than submitted. Not an error, and not the same as "done".
    project_id, milestone_id = _milestone()
    _answer(service_client, project_id, milestone_id, answer="not_done", reason="   ")
    row = work_q.list_milestone_checks()[0]
    assert row["answer"] == "not_done"
    assert row["reason"] is None


def test_an_unknown_answer_is_refused(service_client) -> None:
    # A typo here would write a log row nothing can read back.
    project_id, milestone_id = _milestone()
    assert _answer(service_client, project_id, milestone_id, answer="maybe").status_code == 422


def test_the_answer_is_attributed_to_the_person(service_client) -> None:
    """
    Not to `service:<RoleName>`. This writes a sentence somebody typed about why their
    deadline moved, into a log other people read; an unsigned statement there is worse
    than an unattributed invite. See routes/service.py.
    """
    from app.db.queries import audit

    project_id, milestone_id = _milestone()
    _answer(service_client, project_id, milestone_id)

    entries = audit.history(milestone_id)
    assert entries
    assert entries[0]["user_email"] == "dri@qwealth.com"
