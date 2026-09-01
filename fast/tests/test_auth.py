"""Group enforcement, which is what makes sharing the Cognito pool safe.

The pool (ca-central-1_P8orSDvVO) is shared with the marketing compliance tool, and
an API Gateway Cognito authorizer accepts any token that pool issued regardless of
which app client minted it. So the authorizer alone does not keep compliance-tool
accounts out of the roadmap; require_planning_group does, and only if it actually
refuses. These tests are the reason to believe it does.
"""

import pytest
from fastapi import HTTPException, Request

from app import auth, config


def _request(claims=None, has_context=True):
    """A Request carrying whatever the authorizer would have put in the event."""
    event = {}
    if has_context:
        event = {"requestContext": {"authorizer": {"claims": claims or {}}}}
    return Request({"type": "http", "headers": [], "aws.event": event})


def _rest_request(claims):
    """A REST-API-shaped event: claims nested directly under `authorizer`."""
    return _request(claims)


def _http_request(claims):
    """An HTTP-API-shaped event: claims under `authorizer.jwt`."""
    return Request(
        {
            "type": "http",
            "headers": [],
            "aws.event": {"requestContext": {"authorizer": {"jwt": {"claims": claims}}}},
        }
    )


# ------------------------------------------------------------------ group shapes
@pytest.mark.parametrize(
    "raw,expected",
    [
        # A decoded JWT gives a real list.
        (["planning", "admin"], ["planning", "admin"]),
        # An API Gateway REST authorizer flattens the context to strings and renders
        # the list the way Java prints one - brackets, comma, space.
        ("[planning, admin]", ["planning", "admin"]),
        ("[planning]", ["planning"]),
        # Space-separated, which is what a raw cognito:groups string can look like.
        ("planning admin", ["planning admin"]),
        ("planning,admin", ["planning", "admin"]),
        (None, []),
        ("", []),
        # Duplicates collapse, order preserved.
        (["planning", "planning"], ["planning"]),
        # A group genuinely named with brackets is not mangled by a half-match.
        ("[odd", ["[odd"]),
    ],
)
def test_parse_groups_shapes(raw, expected):
    """
    All three shapes are handled because which one applies is an infrastructure
    decision. Getting it wrong empties everyone's groups, which with enforcement on
    means locking the entire team out of the roadmap.
    """
    assert auth._parse_groups(raw) == expected


def test_groups_read_from_both_authorizer_shapes(monkeypatch):
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    claims = {"email": "a@qwealth.com", "cognito:groups": ["planning"]}

    assert auth.get_user_groups(_rest_request(claims)) == ["planning"]
    assert auth.get_user_groups(_http_request(claims)) == ["planning"]


# ------------------------------------------------------------------ enforcement
def test_planning_member_is_allowed(monkeypatch):
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(config, "ENFORCE_GROUP", True)

    request = _rest_request(
        {"email": "thomas@qwealth.com", "cognito:groups": ["planning"]}
    )
    assert auth.require_planning_group(request) == "thomas@qwealth.com"


def test_compliance_account_is_refused(monkeypatch):
    """
    The case the shared pool creates.

    This user holds a perfectly valid token from the right pool. The authorizer
    would have let them through. Only this check stops them editing the roadmap.
    """
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(config, "ENFORCE_GROUP", True)

    request = _rest_request(
        {"email": "someone@qwealth.com", "cognito:groups": ["compliance", "marketing"]}
    )
    with pytest.raises(HTTPException) as excinfo:
        auth.require_planning_group(request)

    assert excinfo.value.status_code == 403


def test_groupless_member_is_refused(monkeypatch):
    """Every account that existed before groups did is in this state."""
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(config, "ENFORCE_GROUP", True)

    with pytest.raises(HTTPException) as excinfo:
        auth.require_planning_group(_rest_request({"email": "nobody@qwealth.com"}))

    assert excinfo.value.status_code == 403


def test_no_claims_is_401_not_403(monkeypatch):
    """
    A missing authorizer and a wrong group are different failures.

    401 means the gateway is misconfigured; 403 means the person is. Collapsing them
    would send someone hunting through Cognito group membership for what is actually
    a broken API Gateway integration.
    """
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(config, "ENFORCE_GROUP", True)

    with pytest.raises(HTTPException) as excinfo:
        auth.require_planning_group(_request(has_context=False))

    assert excinfo.value.status_code == 401


def test_dev_bypass_keys_off_claims_not_groups(monkeypatch):
    """
    The bypass must not top up a real authenticated user's groups.

    If it keyed off empty groups instead of absent claims, a deployed environment
    with DEV_AUTH_BYPASS left set would hand the planning group to every pool member
    who has not been assigned one - which is most of them, and is the exact opposite
    of what a roleless account should get.
    """
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", True)
    monkeypatch.setattr(auth, "DEV_ADMIN", False)
    monkeypatch.setattr(config, "REQUIRED_GROUP", "planning")

    # No claims at all -> the bypass applies.
    assert auth.get_user_groups(_request(has_context=False)) == ["planning"]

    # Real claims, no groups -> the bypass must NOT apply.
    assert auth.get_user_groups(_rest_request({"email": "real@qwealth.com"})) == []


def test_dev_admin_grants_admin_only_through_the_bypass(monkeypatch):
    """
    DEV_ADMIN is a local convenience and must stay one.

    It is read only on the no-claims path, so an environment with both it and
    DEV_AUTH_BYPASS left set cannot promote a real authenticated caller. The failure
    it guards against is handing roster deletion to every account in a shared pool.
    """
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", True)
    monkeypatch.setattr(auth, "DEV_ADMIN", True)
    monkeypatch.setattr(config, "REQUIRED_GROUP", "planning")
    monkeypatch.setattr(config, "ADMIN_GROUP", "admin")

    # No claims -> bypass identity is an admin, so local runs can click everything.
    assert auth.get_user_groups(_request(has_context=False)) == ["planning", "admin"]

    # Real claims without the admin group -> still not an admin, bypass or not.
    assert auth.is_admin(_rest_request({"email": "real@qwealth.com"})) is False


def test_dev_admin_can_be_turned_off_to_exercise_the_non_admin_paths(monkeypatch):
    """
    The half that is easy to ship broken: an admin never sees the button they are not
    allowed to press, so the refusals need a way to be reached locally.
    """
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", True)
    monkeypatch.setattr(auth, "DEV_ADMIN", False)
    monkeypatch.setattr(config, "REQUIRED_GROUP", "planning")

    assert auth.is_admin(_request(has_context=False)) is False


def test_refusal_does_not_echo_the_callers_groups(monkeypatch, caplog):
    """
    The 403 body must not list what the caller is in.

    Not a secret-keeping exercise about the required group - /api/me returns that
    name to anyone who asks, deliberately, so a refused user can find out what they
    need. What must not go in the response is the caller's *other* memberships,
    because that turns a failed request into a probe for which apps exist in the
    shared pool. It goes to the log instead, where it is useful for support.
    """
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(config, "ENFORCE_GROUP", True)

    with pytest.raises(HTTPException) as excinfo:
        auth.require_planning_group(
            _rest_request({"email": "x@qwealth.com", "cognito:groups": ["compliance"]})
        )

    assert "compliance" not in excinfo.value.detail
    assert any("compliance" in r.getMessage() for r in caplog.records)


# ----------------------------------------------------------------------- routes
def test_routes_are_behind_the_check(aws, monkeypatch):
    """Not a unit test of the dependency - a check that the routes actually use it."""
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(config, "ENFORCE_GROUP", True)
    unauthenticated = TestClient(app)

    for path in ("/api/projects", "/api/people", "/api/roadmap", "/api/roles"):
        assert unauthenticated.get(path).status_code == 401, path

    # health and /me stay open: a monitor holds no token, and a refused user still
    # needs to be able to find out why.
    assert unauthenticated.get("/health").status_code == 200
    body = unauthenticated.get("/api/me").json()
    assert body["authorised"] is False
    assert body["required_group"] == "planning"
