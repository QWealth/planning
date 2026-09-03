"""Shared pytest fixtures.

Tables are created against moto's in-process DynamoDB rather than stubbed. That is
the whole point of the suite: DynamoDB rejects "name", "end" and "active" as bare
attribute names in an update expression, and a dict-based fake would happily accept
them and pass. Both bugs are ones this codebase is actively exposed to, since every
one of those three is a real field here.
"""

import os
import sys

import boto3
import pytest
from moto import mock_aws

# The app is imported as "app.*", so the package's parent (fast/) has to be on the
# path however pytest is invoked.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PROJECTS_TABLE = "test-planning-projects"
PEOPLE_TABLE = "test-planning-people"
AUDIT_TABLE = "test-planning-audit"
AUDIT_INDEX = "entity-timestamp-index"
WORK_TABLE = "test-planning-work"
WORK_INDEX = "kind-updated-index"


@pytest.fixture(autouse=True)
def _no_real_aws(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Keep tests away from real credentials.

    Bogus values rather than nothing: boto3 falls back to the ambient profile when
    the environment is empty, and a test suite that quietly wrote to the real
    ca-central-1 tables would be indistinguishable from a passing run until someone
    opened the roadmap.
    """
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "ca-central-1")
    monkeypatch.setenv("AWS_REGION", "ca-central-1")


@pytest.fixture
def aws(_no_real_aws):
    """Mock AWS, with the four tables created and the query modules re-pointed."""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="ca-central-1")

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
        # The work table carries the same GSI as the real one, and it matters that
        # it is here rather than faked: list_rfcs and list_tasks Query the index
        # rather than the table, so a suite without it would exercise a code path
        # the deployed app never takes.
        ddb.create_table(
            TableName=WORK_TABLE,
            KeySchema=[
                {"AttributeName": "item_id", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "item_id", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
                {"AttributeName": "kind", "AttributeType": "S"},
                {"AttributeName": "updated_at", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": WORK_INDEX,
                    "KeySchema": [
                        {"AttributeName": "kind", "KeyType": "HASH"},
                        {"AttributeName": "updated_at", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
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

        # The query modules bind `dynamodb` at import time, so the mock has to be
        # patched onto the already-imported modules rather than set via env vars.
        from app import config
        from app.db.queries import audit, people, projects, work

        config.PROJECTS_TABLE_NAME = PROJECTS_TABLE
        config.PEOPLE_TABLE_NAME = PEOPLE_TABLE
        config.AUDIT_TABLE_NAME = AUDIT_TABLE
        config.AUDIT_BY_ENTITY_INDEX = AUDIT_INDEX
        config.WORK_TABLE_NAME = WORK_TABLE
        config.WORK_BY_KIND_INDEX = WORK_INDEX

        projects.dynamodb = ddb
        people.dynamodb = ddb
        audit.dynamodb = ddb
        work.dynamodb = ddb

        yield ddb


@pytest.fixture
def client(aws, monkeypatch):
    """
    A TestClient with the group check satisfied.

    DEV_AUTH_BYPASS is set on the auth module directly rather than via the
    environment, because the module reads it at import time and the app has already
    been imported by the time this fixture runs.
    """
    from fastapi.testclient import TestClient

    from app import auth, config
    from app.main import app

    monkeypatch.setattr(auth, "DEV_AUTH_BYPASS", True)
    monkeypatch.setattr(auth, "DEV_USER_EMAIL", "tester@qwealth.com")
    monkeypatch.setattr(config, "ENFORCE_GROUP", True)
    monkeypatch.setattr(config, "REQUIRED_GROUP", "planning")

    return TestClient(app)
