"""The machine-to-machine door, and the invitation text both doors hand out.

Two things are pinned here and they fail in opposite directions:

  - `require_service_caller` must refuse. It is the only way into this API that is
    not a signed-in human, and it reaches a Cognito pool SHARED with the marketing
    compliance tool, so the interesting tests are the ones asserting a 403.

  - `compose_message` must keep saying a specific sentence. It is the only thing
    telling an invited colleague that the "QWealth Marketing Compliance Review" email
    they are about to receive is legitimate. Delete that sentence and nothing breaks,
    no test goes red, and the most security-conscious people on the team quietly bin
    their invitation - which is why there is a test for a string.
"""

import pytest

from app import auth, config, invites

# The shape API Gateway actually puts in requestContext.identity.userArn for an ECS
# task: sts, assumed-role, and a session suffix that is different on every task.
AARDVARK_ROLE = "arn:aws:iam::778983355679:role/AardvarkTaskRole"
AARDVARK_SESSION = "arn:aws:sts::778983355679:assumed-role/AardvarkTaskRole/a1b2c3d4"
STRANGER = "arn:aws:sts::778983355679:assumed-role/SomeOtherRole/z9y8x7"


# --- the allowlist ------------------------------------------------------------


@pytest.mark.parametrize(
    "arn,expected",
    [
        (AARDVARK_SESSION, "AardvarkTaskRole"),
        (AARDVARK_ROLE, "AardvarkTaskRole"),
        # Unrecognised shapes come back whole rather than raising, so they are
        # compared verbatim and refused by the allowlist instead of 500ing the route.
        ("arn:aws:iam::778983355679:user/david", "arn:aws:iam::778983355679:user/david"),
        ("nonsense", "nonsense"),
    ],
)
def test_role_name_survives_every_arn_shape(arn: str, expected: str) -> None:
    assert auth._role_name(arn) == expected


def test_a_session_matches_an_allowlisted_role(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    The session suffix must be ignored, and this is the test that matters most.

    ECS mints a new suffix on every task, so an exact string comparison would work on
    the day it was configured and start refusing the moment the service was next
    redeployed - with nothing in the diff to connect the failure to the deploy.
    """
    monkeypatch.setattr(config, "SERVICE_CALLER_ARNS", [AARDVARK_ROLE])
    assert auth._arn_is_allowed(AARDVARK_SESSION)


def test_an_allowlist_written_as_a_session_arn_still_works(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both ends are reduced to the role, so neither spelling is a silent misconfig."""
    monkeypatch.setattr(config, "SERVICE_CALLER_ARNS", [AARDVARK_SESSION])
    assert auth._arn_is_allowed(AARDVARK_ROLE)


def test_another_role_in_the_same_account_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Being inside the AWS account is not the check. Being named is."""
    monkeypatch.setattr(config, "SERVICE_CALLER_ARNS", [AARDVARK_ROLE])
    assert not auth._arn_is_allowed(STRANGER)


def test_an_empty_allowlist_refuses_everybody(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Fails CLOSED. An unset SERVICE_CALLER_ARNS costs the Slack command; it must never
    mean "no restrictions", which is the direction this kind of check usually rots in.
    """
    monkeypatch.setattr(config, "SERVICE_CALLER_ARNS", [])
    assert not auth._arn_is_allowed(AARDVARK_SESSION)
    assert not auth._arn_is_allowed(AARDVARK_ROLE)


# --- the invitation text ------------------------------------------------------


def test_a_new_account_is_warned_about_the_compliance_branding() -> None:
    """
    The whole reason the message exists. Cognito's email is branded for the OTHER
    tool sharing the pool, and an unexplained credentials email is shaped exactly
    like phishing - so the invitation has to say the odd subject line is expected.
    """
    message = invites.compose_message(account_created=True)
    assert "QWealth Marketing Compliance Review" in message
    assert "temporary password" in message


def test_somebody_who_already_had_an_account_is_not_promised_an_email() -> None:
    """
    No account was created, so Cognito sends nothing. Telling them to wait for a
    password that will never arrive turns a working invite into a support thread.
    """
    message = invites.compose_message(account_created=False)
    assert "temporary password" not in message
    assert "existing QWealth account" in message


def test_the_message_carries_the_link() -> None:
    """
    Cognito's own email has no URL in it at all, so if this drops the link there is
    no other copy of it anywhere in the flow.
    """
    assert config.APP_URL in invites.compose_message(account_created=True)


def test_a_trailing_slash_does_not_become_a_double_slash() -> None:
    assert "qwealth.test/\n" not in invites.compose_message(
        account_created=True, app_url="https://qwealth.test/"
    )


# --- the endpoint -------------------------------------------------------------


@pytest.fixture
def service_client(client, monkeypatch: pytest.MonkeyPatch):
    """
    The normal test client, but arriving as a signed AWS principal.

    `_iam_caller_arn` is patched rather than forging a Lambda event, because the
    thing under test is the allowlist decision, not Mangum's event parsing - and a
    hand-built event that drifts from the real shape would make this pass while the
    deployed route refused everybody.
    """
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(auth, "_iam_caller_arn", lambda request: AARDVARK_SESSION)
    monkeypatch.setattr(config, "SERVICE_CALLER_ARNS", [AARDVARK_ROLE])
    return client


def test_an_unsigned_caller_gets_401(client, monkeypatch: pytest.MonkeyPatch) -> None:
    """No signature and no dev bypass: the route is not open to the internet."""
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(auth, "_iam_caller_arn", lambda request: None)
    monkeypatch.setattr(config, "SERVICE_CALLER_ARNS", [AARDVARK_ROLE])

    refused = client.post("/api/service/invite", json={"email": "joe@qwealth.com"})
    assert refused.status_code == 401


def test_a_signed_but_unlisted_caller_gets_403(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    A valid AWS principal that nobody allowlisted. This is the case that separates
    "is in our AWS account" from "may create logins on the shared pool".
    """
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(auth, "_iam_caller_arn", lambda request: STRANGER)
    monkeypatch.setattr(config, "SERVICE_CALLER_ARNS", [AARDVARK_ROLE])

    refused = client.post("/api/service/invite", json={"email": "joe@qwealth.com"})
    assert refused.status_code == 403


def test_a_bad_address_is_still_refused_before_cognito(service_client) -> None:
    """
    Being a trusted service does not buy looser validation. An allowlisted caller
    sending rubbish gets the same 422 a browser would - the schema is the schema.
    """
    refused = service_client.post("/api/service/invite", json={"email": "not-an-email"})
    assert refused.status_code == 422


def test_the_service_route_is_not_reachable_with_a_cognito_login(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    An admin's browser session must NOT be able to call the service door.

    Not because it would do damage - the same person can invite from the Team page -
    but because the two doors having genuinely separate keys is the property that
    makes the delegation to Aardvark's Slack admin list a bounded decision.
    """
    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", False)
    monkeypatch.setattr(auth, "_iam_caller_arn", lambda request: None)
    monkeypatch.setattr(config, "SERVICE_CALLER_ARNS", [AARDVARK_ROLE])

    refused = client.post("/api/service/invite", json={"email": "joe@qwealth.com"})
    assert refused.status_code == 401
