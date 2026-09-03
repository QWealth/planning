"""
The write helper both query modules share, and the error they both raise.

Extracted from queries/projects.py when queries/work.py needed the identical thing.
It is genuinely generic: the only differences between updating a phase and updating
an RFC are which table the item is in and which attribute proves it still exists, so
both are arguments rather than a second copy of the function.

Nothing here opens a table. Callers pass the boto3 Table object they already hold,
which is what keeps `projects.dynamodb = ddb` and `work.dynamodb = ddb` working as
monkeypatch points in demo.py and the tests - resolving the resource in here instead
would quietly bypass both.
"""

import logging
from datetime import date, datetime
from typing import Any

from botocore.exceptions import ClientError

from app.db.models import to_decimal

logger = logging.getLogger(__name__)


class ValidationError(Exception):
    """A write the data model refuses. Routes turn this into a 400."""


def iso(value: Any) -> Any:
    """Dates go to DynamoDB as ISO strings; everything else passes through."""
    if isinstance(value, date) and not isinstance(value, datetime):
        return value.isoformat()
    return value


def apply_update(
    table: Any,
    key: dict[str, Any],
    changes: dict[str, Any],
    allowed: set[str],
    exists_attr: str,
) -> dict[str, Any]:
    """
    SET every field in `changes`, including the ones whose value is None.

    This is the counterpart to UNSET in db/models.py, and the difference from the
    marketing tool's update_rule is the point of the function. That one skips a
    field whose value is None, treating None as "not supplied". Here the caller has
    already separated the two - `changes` holds only fields the request actually
    mentioned - so a None that reaches this point is an explicit instruction to
    store null. Clearing a phase's dates is how you say "this slipped and has not
    been re-planned", and it has to be expressible. So is detaching an RFC from a
    project by sending project_id: null.

    `allowed` is an allowlist rather than "whatever is in the dict". The change dicts
    arrive from Pydantic models today, but this function is one careless caller away
    from being handed a raw request body, and an unfiltered SET would let that body
    overwrite a key attribute or created_at.

    `exists_attr` names an attribute that every stored row of this kind has - the
    partition key, in practice. The condition refuses to resurrect a deleted row as a
    stub: without it, updating a phase another user has just removed silently
    recreates it holding only the fields in this request, which renders as a blank
    band nobody can account for.

    Every attribute goes through a #name alias. "name", "end" and "status" are all
    DynamoDB reserved words, and rather than special-case them, aliasing everything
    means a field added later cannot reintroduce the problem.
    """
    unknown = set(changes) - allowed
    if unknown:
        raise ValidationError(f"cannot update: {', '.join(sorted(unknown))}")

    parts = ["#updated_at = :updated_at"]
    names = {"#updated_at": "updated_at"}
    values: dict[str, Any] = {":updated_at": datetime.utcnow().isoformat()}

    for field, value in changes.items():
        parts.append(f"#{field} = :{field}")
        names[f"#{field}"] = field
        values[f":{field}"] = to_decimal(iso(value))

    try:
        response = table.update_item(
            Key=key,
            UpdateExpression="SET " + ", ".join(parts),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression=f"attribute_exists({exists_attr})",
            ReturnValues="ALL_NEW",
        )
        return response.get("Attributes", {})
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ValidationError("no such record") from e
        logger.error("Error updating %s: %s", key, e)
        raise
