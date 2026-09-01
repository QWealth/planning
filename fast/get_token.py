#!/usr/bin/env python3
"""
Print a Cognito ID token for the deployed API.

    ./venv/bin/python get_token.py                       # prints the token
    export TOKEN=$(./venv/bin/python get_token.py -q)    # for curl
    curl -H "Authorization: Bearer $TOKEN" "$API/api/roadmap"

WHY THIS EXISTS
---------------
There is no frontend yet, and the API is behind an API Gateway Cognito authorizer,
so a browser gets 401 on everything except /health. Until slice 4 ships a login
screen, this is how a human gets a token.

WHY NOT THE AWS CLI
-------------------
`aws cognito-idp initiate-auth --auth-flow USER_SRP_AUTH` does not work: the CLI
does not implement the SRP maths, so it can send the first message and nothing else.
The alternative would be enabling USER_PASSWORD_AUTH on the app client, which sends
the password itself to Cognito instead of a zero-knowledge proof of it - a real
weakening of the deployed configuration in exchange for a shell one-liner. pycognito
does SRP properly, so the client stays SRP-only. It is a dev dependency
(requirements-dev.txt) and is not in the Lambda image.

The password is read from a TTY prompt, never from a flag: an --password argument
lands in shell history and in the process table where any other local process can
read it.
"""

import argparse
import getpass
import os
import sys

import boto3
from pycognito.aws_srp import AWSSRP

REGION = os.environ.get("AWS_REGION", "ca-central-1")
USER_POOL_ID = os.environ.get("COGNITO_USER_POOL_ID", "ca-central-1_P8orSDvVO")
CLIENT_ID = os.environ.get("COGNITO_CLIENT_ID", "pciat37670n002pk5ji276k27")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--username", default=os.environ.get("COGNITO_USERNAME", ""))
    ap.add_argument(
        "-q",
        "--quiet",
        action="store_true",
        help="print only the token, for $(...) capture",
    )
    args = ap.parse_args()

    username = args.username or input("email: ").strip()
    password = getpass.getpass("password: ")

    client = boto3.client("cognito-idp", region_name=REGION)
    srp = AWSSRP(
        username=username,
        password=password,
        pool_id=USER_POOL_ID,
        client_id=CLIENT_ID,
        client=client,
    )

    try:
        tokens = srp.authenticate_user()
    except client.exceptions.NotAuthorizedException:
        # prevent_user_existence_errors is on for this client, so Cognito answers
        # identically for a wrong password and an address with no account. That is
        # the point of the setting; this message must not undo it by guessing which.
        raise SystemExit("Cognito refused those credentials.")

    challenge = tokens.get("ChallengeName")
    if challenge == "SOFTWARE_TOKEN_MFA":
        # MFA is OPTIONAL on this pool, so this branch fires only for accounts that
        # enrolled TOTP. Handled rather than left to crash, because the people most
        # likely to run this are the ones who did enrol.
        code = input("MFA code: ").strip()
        tokens = client.respond_to_auth_challenge(
            ClientId=CLIENT_ID,
            ChallengeName="SOFTWARE_TOKEN_MFA",
            Session=tokens["Session"],
            ChallengeResponses={
                "USERNAME": username,
                "SOFTWARE_TOKEN_MFA_CODE": code,
            },
        )
    elif challenge == "NEW_PASSWORD_REQUIRED":
        raise SystemExit(
            "This account still has its invite password. Set a real one by signing "
            "in to the compliance tool first - it shares this user pool."
        )
    elif challenge:
        raise SystemExit(f"Unhandled Cognito challenge: {challenge}")

    id_token = tokens["AuthenticationResult"]["IdToken"]

    if args.quiet:
        print(id_token)
        return

    print(id_token)
    print(file=sys.stderr)
    print(
        "The ID token, not the access token: the API Gateway authorizer is "
        "configured for ID tokens, and only the ID token carries cognito:groups, "
        "which is what app/auth.py checks.",
        file=sys.stderr,
    )
    print("Valid for 1 hour.", file=sys.stderr)


if __name__ == "__main__":
    main()
