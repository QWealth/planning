#!/usr/bin/env python3
"""
Run the API locally against an in-process fake DynamoDB, seeded from the workbook.

    ./venv/bin/python demo.py            # http://localhost:8000/docs

Nothing here touches AWS. moto patches botocore inside this process, so the three
tables live in memory and vanish when you stop it. That is the point: there is no
deployed environment yet, and this is the fastest way to click through the API
against the real nine projects rather than a fixture.

THE EMAIL ADDRESSES ARE FAKE, AND OBVIOUSLY SO
----------------------------------------------
The workbook names owners by first name only. The data model keys on email. There
is no safe derivation - see the docstring in app/seeds/load_roadmap.py - so this
script does NOT guess at real addresses. It maps every name onto @example.invalid,
a TLD reserved by RFC 2606 precisely so that it can never resolve and can never
receive mail.

That is deliberate over the more convenient firstname@qwealth.com: a plausible-
looking wrong address is the failure this whole migration is about. If these were
real-looking, someone would eventually load them for real. These cannot be.

To load the real roster, write people.json by hand and use load_roadmap.py.
"""

import json
import os
import pathlib
import sys

import boto3
from moto import mock_aws

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))

REGION = "ca-central-1"
PROJECTS_TABLE = "demo-planning-projects"
PEOPLE_TABLE = "demo-planning-people"
AUDIT_TABLE = "demo-planning-audit"
AUDIT_INDEX = "entity-timestamp-index"

# Reserved by RFC 2606. Cannot resolve, cannot receive mail, cannot be mistaken for
# a real address by anyone reading the screen.
FAKE_DOMAIN = "@example.invalid"


def create_tables(ddb) -> None:
    """The three tables, with the same key schema slice 5's CDK will create."""
    ddb.create_table(
        TableName=PROJECTS_TABLE,
        KeySchema=[
            {"AttributeName": "project_id", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "project_id", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.create_table(
        TableName=PEOPLE_TABLE,
        KeySchema=[{"AttributeName": "email", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "email", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.create_table(
        TableName=AUDIT_TABLE,
        KeySchema=[
            {"AttributeName": "entity_id", "KeyType": "HASH"},
            {"AttributeName": "timestamp", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "entity_id", "AttributeType": "S"},
            {"AttributeName": "timestamp", "AttributeType": "S"},
            {"AttributeName": "entity", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": AUDIT_INDEX,
                "KeySchema": [
                    {"AttributeName": "entity", "KeyType": "HASH"},
                    {"AttributeName": "timestamp", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
        BillingMode="PAY_PER_REQUEST",
    )


def _fake_pool(group: str) -> str:
    """An in-memory user pool with the planning group already in it."""
    idp = boto3.client("cognito-idp", region_name=REGION)
    pool_id = idp.create_user_pool(PoolName="demo-planning-pool")["UserPool"]["Id"]
    idp.create_group(GroupName=group, UserPoolId=pool_id)
    return pool_id


def main() -> None:
    roadmap_path = HERE.parent / "roadmap.json"
    if not roadmap_path.exists():
        raise SystemExit(
            "no roadmap.json - run first:\n"
            "  python3 migrate/extract_workbook.py --write roadmap.json"
        )

    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        create_tables(ddb)

        from app import auth, cognito, config
        from app.db.queries import audit, people, projects
        from app.seeds.load_roadmap import load, plan, resolve_people

        config.PROJECTS_TABLE_NAME = PROJECTS_TABLE
        config.PEOPLE_TABLE_NAME = PEOPLE_TABLE
        config.AUDIT_TABLE_NAME = AUDIT_TABLE
        config.AUDIT_BY_ENTITY_INDEX = AUDIT_INDEX
        projects.dynamodb = ddb
        people.dynamodb = ddb
        audit.dynamodb = ddb

        # No API Gateway in front of uvicorn means no claims and no groups, so the
        # group check would 401 every request. Off here, and only here.
        config.ENFORCE_GROUP = False
        auth.DEV_AUTH_BYPASS = True

        # Who you are signed in as, overridable because the roster is now self-service
        # and "am I an admin, and is this row mine" is a thing to exercise locally:
        #
        #   DEV_USER_EMAIL=ha.nguyen@example.invalid ./venv/bin/python demo.py
        #   DEV_ADMIN=false ./venv/bin/python demo.py
        #
        # The default is deliberately NOT addable. `.invalid` is reserved by RFC 2606,
        # so EmailStr refuses it and POST /api/people 422s - which is confusing for
        # about a minute and then correct: this identity is a stand-in for a Cognito
        # account, and inventing roster rows for it would put a fictional person in
        # the seeded data. Point this at a seeded address to act as somebody real.
        auth.DEV_USER_EMAIL = os.environ.get("DEV_USER_EMAIL") or "demo@example.invalid"

        # A throwaway Cognito pool, so "Invite somebody" is clickable here.
        #
        # Worth the eight lines: the real endpoint writes to the pool SHARED with the
        # marketing compliance tool, and a wrong first attempt there does not fail
        # quietly - it creates an account a colleague gets an email about. This gives
        # the whole flow somewhere to be wrong for free.
        config.COGNITO_USER_POOL_ID = _fake_pool(config.REQUIRED_GROUP)
        cognito.cognito = boto3.client("cognito-idp", region_name=REGION)

        with open(roadmap_path) as fh:
            roadmap = json.load(fh)

        names = sorted({p["name"] for p in roadmap.get("people", []) if p.get("name")})
        mapping = {name: name.lower().replace(" ", ".") + FAKE_DOMAIN for name in names}

        resolved, unmapped = resolve_people(roadmap, mapping)
        load(plan(roadmap, resolved))

        print()
        print("=" * 68)
        print("  Planning Roadmap API - LOCAL DEMO, in-memory, nothing deployed")
        print("=" * 68)
        print("  docs        http://localhost:8000/docs")
        print("  roadmap     http://localhost:8000/api/roadmap")
        print("  gaps        http://localhost:8000/api/roadmap/gaps")
        print("  workload    http://localhost:8000/api/people/workload")
        print()
        print("  Owner emails are FAKE (%s, RFC 2606 reserved)." % FAKE_DOMAIN)
        print("  Real addresses need people.json written by hand.")
        print("  Data is in memory and is lost when this stops.")
        print("=" * 68)
        print()

        import uvicorn

        from app.main import app

        uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")


if __name__ == "__main__":
    main()
