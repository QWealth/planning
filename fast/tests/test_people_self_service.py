"""
Who may act on whom: the two-tier rule on the roster.

Anyone signed in may add and edit THEMSELVES. Only an admin may touch anybody else,
or deactivate or delete at all. The roadmap itself - projects, phases, milestones -
is deliberately outside this and stays open to everyone, so nothing here should be
read as "non-admins are read-only".

The cases worth having are the ones where the boundary is crossed sideways rather
than head-on: a self-edit that smuggles in `active`, an address that differs only by
case, and a caller with no identity at all. A frontal `DELETE /someone-else` is the
easy one and it is also the one least likely to regress.
"""

import pytest
from fastapi import HTTPException, Request

from app import auth, config

ME = "thomas@qwealth.com"
SOMEBODY_ELSE = "piper@qwealth.com"


def _request(email, groups):
    """A Request carrying the claims the authorizer would have attached."""
    return Request(
        {
            "type": "http",
            "headers": [],
            "aws.event": {
                "requestContext": {
                    "authorizer": {
                        "claims": {"email": email, "cognito:groups": groups}
                    }
                }
            },
        }
    )


def _member(email=ME):
    return _request(email, [config.REQUIRED_GROUP])


def _admin(email=ME):
    return _request(email, [config.REQUIRED_GROUP, config.ADMIN_GROUP])


# ------------------------------------------------------------------- is_admin
def test_admin_group_membership_is_what_makes_an_admin():
    assert auth.is_admin(_admin()) is True
    assert auth.is_admin(_member()) is False


def test_admin_group_is_recognised_in_the_rest_authorizer_string_shape():
    """
    The REST authorizer flattens its context to "[planning, admin]". If the admin
    check only understood real lists it would silently make everybody a non-admin in
    the deployed environment, and the roster would be read-only for the whole team
    with nothing in the logs to say why.
    """
    assert auth.is_admin(_request(ME, "[planning, admin]")) is True


def test_nobody_is_an_admin_without_claims(monkeypatch):
    """Fails closed: no authorizer means no admin, never all-admin."""
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    empty = Request({"type": "http", "headers": [], "aws.event": {}})
    assert auth.is_admin(empty) is False


def test_require_admin_refuses_a_plain_member():
    with pytest.raises(HTTPException) as refused:
        auth.require_admin(_member())
    assert refused.value.status_code == 403
    assert config.ADMIN_GROUP in refused.value.detail


def test_require_admin_returns_the_email_for_an_admin():
    assert auth.require_admin(_admin()) == ME


# ---------------------------------------------------------------- same_person
@pytest.mark.parametrize(
    "a,b,expected",
    [
        (ME, ME, True),
        # The case that silently locks somebody out of their own record. Cognito will
        # happily hand back a differently-cased address from the one that was stored.
        ("Thomas@QWealth.com", ME, True),
        ("  thomas@qwealth.com  ", ME, True),
        (ME, SOMEBODY_ELSE, False),
        # Two unknowns are not the same person; returning True here would turn
        # "edit yourself" into "edit the row with no address".
        (None, None, False),
        (None, ME, False),
        (ME, None, False),
        ("", ME, False),
    ],
)
def test_same_person_matches_the_way_the_roster_stores_addresses(a, b, expected):
    assert auth.same_person(a, b) is expected


# ------------------------------------------------------- the rule, over HTTP
def _client(monkeypatch, aws, request_obj):
    """A TestClient whose every request carries the given identity."""
    from fastapi.testclient import TestClient

    from app.main import app

    claims = request_obj.scope["aws.event"]["requestContext"]["authorizer"]["claims"]

    def _claims(_request):
        return claims

    monkeypatch.setattr(auth, "_authorizer_claims", _claims)
    return TestClient(app)


def _new(email: str, name: str) -> dict[str, object]:
    """
    A minimal valid create body.

    `roles` is required (see app/roles.py) and every test below is about *who may act
    on whose record*, not about what anybody does, so it is filled in once here rather
    than repeated at nine call sites where it would read as noise.

    It has to be valid, not merely present: FastAPI validates the body before the
    endpoint function runs, so an incomplete body would 422 before the permission
    check was ever reached. The refusal tests would then still fail - just for the
    wrong reason, and they would keep passing if the permission check were deleted.
    """
    return {"email": email, "name": name, "roles": ["software-engineer"]}


def test_a_member_can_add_themselves(monkeypatch, aws):
    client = _client(monkeypatch, aws, _member())
    made = client.post("/api/people", json=_new(ME, "Thomas"))
    assert made.status_code == 201, made.text
    assert made.json()["email"] == ME


def test_a_member_cannot_add_somebody_else(monkeypatch, aws):
    client = _client(monkeypatch, aws, _member())
    refused = client.post("/api/people", json=_new(SOMEBODY_ELSE, "Piper"))
    assert refused.status_code == 403
    # The address they ARE allowed to use is named, so a typo is self-correcting.
    assert ME in refused.json()["detail"]


def test_an_admin_can_add_somebody_else(monkeypatch, aws):
    client = _client(monkeypatch, aws, _admin())
    made = client.post("/api/people", json=_new(SOMEBODY_ELSE, "Piper"))
    assert made.status_code == 201, made.text


def test_adding_yourself_is_case_insensitive(monkeypatch, aws):
    """Signing in as Thomas@QWealth.com must not refuse you your own row."""
    client = _client(monkeypatch, aws, _member("Thomas@QWealth.com"))
    made = client.post("/api/people", json=_new(ME, "Thomas"))
    assert made.status_code == 201, made.text


def test_a_member_can_edit_their_own_specialisations(monkeypatch, aws):
    client = _client(monkeypatch, aws, _member())
    client.post("/api/people", json=_new(ME, "Thomas"))

    edited = client.patch(
        f"/api/people/{ME}",
        json={"specialisations": [{"skill": "front-end", "level": "learning"}]},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["specialisations"] == [
        {"skill": "front-end", "level": "learning"}
    ]


def test_a_member_cannot_edit_somebody_else(monkeypatch, aws):
    admin = _client(monkeypatch, aws, _admin())
    admin.post("/api/people", json=_new(SOMEBODY_ELSE, "Piper"))

    client = _client(monkeypatch, aws, _member())
    refused = client.patch(f"/api/people/{SOMEBODY_ELSE}", json={"name": "Renamed"})
    assert refused.status_code == 403


def test_a_member_cannot_reactivate_themselves(monkeypatch, aws):
    """
    The hole this closes. `active` is on PersonUpdate, so without an explicit refusal
    a deactivated person could PATCH themselves back on and the admin-only
    deactivation would mean nothing.
    """
    admin = _client(monkeypatch, aws, _admin())
    admin.post("/api/people", json=_new(ME, "Thomas"))
    assert admin.post(f"/api/people/{ME}/deactivate").status_code == 200

    client = _client(monkeypatch, aws, _member())
    refused = client.patch(f"/api/people/{ME}", json={"active": True})
    assert refused.status_code == 403
    assert "admin" in refused.json()["detail"].lower()


def test_a_self_edit_that_never_mentions_active_still_works_while_deactivated(
    monkeypatch, aws
):
    """
    The flip side, and the reason the check reads `changes()` rather than comparing
    against the stored row: absent must stay different from sent. Somebody who has
    been deactivated can still correct their own name.
    """
    admin = _client(monkeypatch, aws, _admin())
    admin.post("/api/people", json=_new(ME, "Thomas"))
    admin.post(f"/api/people/{ME}/deactivate")

    client = _client(monkeypatch, aws, _member())
    edited = client.patch(f"/api/people/{ME}", json={"name": "Thomas R"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["name"] == "Thomas R"
    assert edited.json()["active"] is False


def test_deactivate_and_delete_are_admin_only_even_on_your_own_record(monkeypatch, aws):
    admin = _client(monkeypatch, aws, _admin())
    admin.post("/api/people", json=_new(ME, "Thomas"))

    client = _client(monkeypatch, aws, _member())
    assert client.post(f"/api/people/{ME}/deactivate").status_code == 403
    assert client.delete(f"/api/people/{ME}").status_code == 403


def test_an_admin_can_delete(monkeypatch, aws):
    client = _client(monkeypatch, aws, _admin())
    client.post("/api/people", json=_new(SOMEBODY_ELSE, "Piper"))
    gone = client.delete(f"/api/people/{SOMEBODY_ELSE}")
    assert gone.status_code == 200, gone.text
    assert gone.json()["email"] == SOMEBODY_ELSE


def test_me_reports_admin_state_so_the_ui_can_hide_what_it_cannot_do(monkeypatch, aws):
    assert _client(monkeypatch, aws, _admin()).get("/api/me").json()["is_admin"] is True
    assert _client(monkeypatch, aws, _member()).get("/api/me").json()["is_admin"] is False


def test_editing_the_roadmap_is_not_admin_only(monkeypatch, aws):
    """
    The scope boundary, stated as a test because it is the thing most likely to be
    "tidied" into admin-only later. The team schedules its own work; putting one
    person in the path of every date change is exactly what the workbook did.
    """
    client = _client(monkeypatch, aws, _member())
    made = client.post("/api/projects", json={"name": "Tax", "lane_order": 10})
    assert made.status_code == 201, made.text
