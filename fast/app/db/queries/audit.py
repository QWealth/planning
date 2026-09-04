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


def claim_once(entity_id: str, timestamp: str, detail: Optional[str] = None) -> bool:
    """
    Reserve one (recipient, week) slot. True if this call won it, False if it was taken.

    The deduplication behind the Monday digest, and it is a conditional write rather
    than a read-then-write because those are not the same thing. Two Lambdas started by
    a retried EventBridge event both read "not sent yet" and both send; only one of them
    can win an `attribute_not_exists` on the key. Getting a duplicate DM is a small
    failure, but it is the kind that erodes trust in the whole feature, and the fix
    costs one condition expression.

    UNLIKE `record`, THIS DOES NOT SWALLOW ITS ERRORS - it returns False. A digest is
    not worth sending if we cannot tell whether it was already sent, and the direction
    to fail is "stay quiet": a missed week is recoverable by anybody looking at the
    roadmap, where a duplicate is not recoverable at all once it is in someone's DMs.
    """
    entry = {
        "entity_id": entity_id,
        "timestamp": timestamp,
        "action": "sent",
        "entity": AuditLogModel.ENTITY_NOTIFICATION,
        "before": None,
        "after": detail,
        "user_email": "system",
    }
    try:
        get_audit_table().put_item(
            Item=entry,
            ConditionExpression="attribute_not_exists(entity_id) "
            "AND attribute_not_exists(#ts)",
            ExpressionAttributeNames={"#ts": "timestamp"},
        )
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            logger.info("Digest already claimed for %s at %s", entity_id, timestamp)
        else:
            logger.error("Could not claim %s at %s: %s", entity_id, timestamp, e)
        return False


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
