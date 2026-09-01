"""Audit log writes and reads.

Every mutation writes a row here. The workbook had no answer at all to "who moved
this date" - it was a single file on a share, edited by whoever had it open - and
that gap is a large part of why it is being retired.
"""

import logging
from typing import Any, Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from app import config
from app.db.models import AuditLogModel

logger = logging.getLogger(__name__)

dynamodb = boto3.resource("dynamodb", region_name=config.AWS_REGION)


def get_audit_table():
    """Get the audit table."""
    return dynamodb.Table(config.AUDIT_TABLE_NAME)


def record(
    action: str,
    entity: str,
    entity_id: str,
    before: Optional[dict[str, Any]] = None,
    after: Optional[dict[str, Any]] = None,
    user_email: Optional[str] = None,
) -> None:
    """
    Write one audit row.

    Swallows its own errors, and that is a deliberate and arguable choice. The
    alternative - letting a failed audit write fail the request - means a transient
    DynamoDB error on the audit table blocks people from editing the roadmap, which
    for an internal planning tool is a worse outcome than a gap in the history. The
    compensating control is that the failure is logged at error with the payload
    intact, so it is recoverable from CloudWatch rather than lost.

    This trade would be the wrong way round for the compliance tool, where the audit
    trail is the artefact a regulator is shown and a silent gap in it is the failure.
    Worth re-deciding if this app ever grows a similar obligation.
    """
    entry = AuditLogModel.create_entry(
        action=action,
        entity=entity,
        entity_id=entity_id,
        before=before,
        after=after,
        user_email=user_email,
    )
    try:
        get_audit_table().put_item(Item=entry)
    except ClientError as e:
        logger.error(
            "Audit write failed for %s %s (%s) by %s: %s | entry=%s",
            entity,
            entity_id,
            action,
            user_email,
            e,
            entry,
        )


def history(entity_id: str, limit: int = 100) -> list[dict[str, Any]]:
    """
    Every recorded change to one entity, newest first.

    One Query against one partition, which is the whole reason the table is keyed
    this way. ScanIndexForward=False walks the sort key (timestamp) backwards.
    """
    try:
        response = get_audit_table().query(
            KeyConditionExpression=Key("entity_id").eq(entity_id),
            ScanIndexForward=False,
            Limit=limit,
        )
        return [AuditLogModel.from_item(item) for item in response.get("Items", [])]
    except ClientError as e:
        logger.error("Error reading history for %s: %s", entity_id, e)
        raise


def recent(entity: str, limit: int = 100) -> list[dict[str, Any]]:
    """
    The latest changes across all entities of one kind, newest first.

    Uses the entity+timestamp GSI. This is a small partition set by design - there
    are only four entity kinds - which would be a hot-partition problem at volume.
    It is not one here: nine projects, ~54 phases and ten people generate a handful
    of writes a day, and the alternative (sharding the key) would buy nothing but
    complexity. Revisit if this ever ingests machine-generated events.
    """
    try:
        response = get_audit_table().query(
            IndexName=config.AUDIT_BY_ENTITY_INDEX,
            KeyConditionExpression=Key("entity").eq(entity),
            ScanIndexForward=False,
            Limit=limit,
        )
        return [AuditLogModel.from_item(item) for item in response.get("Items", [])]
    except ClientError as e:
        logger.error("Error reading recent %s activity: %s", entity, e)
        raise
