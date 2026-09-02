"""Creating a login on the shared Cognito pool.

The one place in this codebase that WRITES to Cognito. Everything else about identity
is read-only - auth.py reads claims the authorizer already verified, and never calls
the service at all - so this module is deliberately small and deliberately separate.

WHY IT IS NOT A 409 WHEN THE ACCOUNT ALREADY EXISTS
---------------------------------------------------
The pool is shared with the marketing compliance tool, and the login screen says so:
"Same account as the marketing compliance tool. Access to the roadmap also requires
membership of the planning group." So the COMMON case for inviting a colleague is
that they already have an account and simply are not in the planning group - most of
QWealth is already in this pool. Refusing that as a conflict would make the normal
path an error and leave the admin with no way at all to grant access, which is the
entire thing they were trying to do.

So an invite is idempotent and says what it did: it ensures a login exists, ensures
that login is in the planning group, and reports which of the two it had to create.
Running it twice is harmless.

WHAT AN INVITE DOES NOT DO
--------------------------
It does not add anyone to the roster. A login and a roster row are different things -
routes/people.py says so at create_person - and the roster row carries roles and
specialisations that the admin doing the inviting has no business guessing. The
invited person writes their own on first sign-in. Until they do they can log in and
see the onboarding form, and nothing else.
"""

import logging
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from app import config

logger = logging.getLogger(__name__)

# Module-level like the DynamoDB resources in db/queries/*, and patched the same way
# in tests. Constructing a boto3 client performs no I/O, so this costs nothing in a
# process that never invites anybody - and in Lambda it is built once per container
# rather than once per request.
cognito = boto3.client("cognito-idp", region_name=config.AWS_REGION)


class InviteError(Exception):
    """Cognito refused the invite, with a reason worth showing the admin."""


def _client() -> Any:
    """Indirection so tests can repoint the module attribute. See db/queries."""
    return cognito


def invite_user(email: str) -> dict[str, Any]:
    """
    Ensure `email` has a login and is in the planning group.

    Returns what it had to do:
        account_created - True if there was no such account until now.
        group_added     - True if they were not in the planning group until now.

    Both False means the invite was a no-op: they already had access. That is a
    perfectly good outcome to report and not an error - see the module docstring.

    The address is lowercased, matching the roster's partition key and PersonBase's
    normaliser. Cognito usernames are case-sensitive unless the pool is configured
    otherwise, so inviting "Joe@qwealth.com" without this creates a second account
    that can sign in but whose email never matches the roster row Joe writes later.
    """
    email = email.strip().lower()
    client = _client()

    account_created = False
    try:
        client.admin_create_user(
            UserPoolId=config.COGNITO_USER_POOL_ID,
            Username=email,
            UserAttributes=[
                {"Name": "email", "Value": email},
                # Marked verified because the invitation itself is delivered to this
                # address - receiving it IS the proof. Without this the account lands
                # in a state where the first sign-in demands a code from an email that
                # was never sent, which reads as the invitation being broken.
                {"Name": "email_verified", "Value": "true"},
            ],
            DesiredDeliveryMediums=["EMAIL"],
        )
        account_created = True
    except client.exceptions.UsernameExistsException:
        # The expected case for most colleagues. Fall through to the group.
        logger.info("Invite for %s: account already existed, granting group only", email)
    except ClientError as e:
        logger.error("admin_create_user failed for %s: %s", email, e)
        raise InviteError(_explain(e)) from e

    group_added = _ensure_group(client, email)
    return {"email": email, "account_created": account_created, "group_added": group_added}


def _ensure_group(client: Any, email: str) -> bool:
    """
    Put `email` in the planning group, and say whether that changed anything.

    AdminAddUserToGroup is idempotent, so the membership check is only here to make
    the return value honest - the UI's message to the admin turns on it. Doing the
    read first also means an already-correct account costs one call rather than a
    write, which matters not at all for throughput and quite a lot for the audit row.
    """
    try:
        existing = client.admin_list_groups_for_user(
            UserPoolId=config.COGNITO_USER_POOL_ID, Username=email
        )
        held = {g.get("GroupName") for g in existing.get("Groups", [])}
        if config.REQUIRED_GROUP in held:
            return False

        client.admin_add_user_to_group(
            UserPoolId=config.COGNITO_USER_POOL_ID,
            Username=email,
            GroupName=config.REQUIRED_GROUP,
        )
        return True
    except ClientError as e:
        # An account with no group is worse than no account: they can sign in to the
        # pool and get a 403 from every endpoint, with a login screen that cannot tell
        # them why. So this failure is surfaced rather than swallowed, even though it
        # may leave a freshly created account behind - which the next invite fixes,
        # because this whole function is re-runnable.
        logger.error("Could not add %s to group '%s': %s", email, config.REQUIRED_GROUP, e)
        raise InviteError(_explain(e)) from e


def _explain(error: ClientError) -> str:
    """
    Turn a botocore error into something an admin can act on.

    Three of these are configuration rather than user error, and saying so saves
    somebody reading CloudWatch to discover the IAM policy is missing a permission.
    """
    code = error.response.get("Error", {}).get("Code", "")
    known: dict[str, str] = {
        "AccessDeniedException": (
            "This API is not permitted to manage the Cognito pool. The Lambda role "
            "needs AdminCreateUser and AdminAddUserToGroup."
        ),
        "ResourceNotFoundException": (
            f"The pool or the '{config.REQUIRED_GROUP}' group does not exist. "
            "Check the CDK deployment."
        ),
        "InvalidParameterException": "Cognito rejected that address.",
        "UserLambdaValidationException": (
            "A Cognito trigger refused the invitation. Check the pool's Lambda triggers."
        ),
    }
    return known.get(code, "Could not create the login. The error is in the logs.")


def find_user(email: str) -> Optional[dict[str, Any]]:
    """
    Look somebody up in the pool, or None. Used by tests and by nothing else yet.

    Kept because "does this person already have a login" is the question an admin
    asks immediately after an invite fails, and having the call already written and
    exercised is cheaper than adding it under pressure.
    """
    try:
        return _client().admin_get_user(
            UserPoolId=config.COGNITO_USER_POOL_ID, Username=email.strip().lower()
        )
    except _client().exceptions.UserNotFoundException:
        return None
