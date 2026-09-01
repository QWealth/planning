"""DynamoDB queries for the roster."""

import logging
from datetime import datetime
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from app import config
from app.db.models import PersonModel

logger = logging.getLogger(__name__)

dynamodb = boto3.resource("dynamodb", region_name=config.AWS_REGION)

PERSON_UPDATABLE = {"name", "roles", "active", "specialisations"}


def get_people_table():
    """Get the people table."""
    return dynamodb.Table(config.PEOPLE_TABLE_NAME)


def get_person(email: str) -> Optional[dict[str, Any]]:
    """One person by email, or None."""
    try:
        response = get_people_table().get_item(Key={"email": email.strip().lower()})
    except ClientError as e:
        logger.error("Error getting person %s: %s", email, e)
        raise
    item = response.get("Item")
    return PersonModel.from_item(item) if item else None


def list_people(include_inactive: bool = False) -> list[dict[str, Any]]:
    """Everyone on the roster, by name."""
    table = get_people_table()
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {}

    try:
        while True:
            response = table.scan(**kwargs)
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                break
            kwargs["ExclusiveStartKey"] = last_key
    except ClientError as e:
        logger.error("Error listing people: %s", e)
        raise

    people = [PersonModel.from_item(i) for i in items]
    if not include_inactive:
        people = [p for p in people if p["active"]]
    people.sort(key=lambda p: (p["name"] or "").lower())
    return people


def create_person(
    email: str,
    name: str,
    roles: Optional[list[str]] = None,
    active: bool = True,
    specialisations: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """
    Create a person, refusing to overwrite an existing one.

    The conditional matters because email is the key and the obvious mistake -
    re-adding somebody who is already on the roster - would otherwise silently reset
    their roles and skills and reactivate a deactivated account, with no trace beyond
    a new updated_at.
    """
    item = PersonModel.create_item(
        email=email,
        name=name,
        roles=roles,
        active=active,
        specialisations=specialisations,
    )
    try:
        get_people_table().put_item(
            Item=item, ConditionExpression="attribute_not_exists(email)"
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ValueError(f"{item['email']} is already on the roster") from e
        logger.error("Error creating person %s: %s", email, e)
        raise
    return PersonModel.from_item(item)


def update_person(email: str, changes: dict[str, Any]) -> Optional[dict[str, Any]]:
    """
    Update a person. `changes` holds only fields the caller actually sent.

    Every attribute goes through a #name alias: "name" is a DynamoDB reserved word,
    and aliasing all of them means a field added later cannot reintroduce the
    problem.
    """
    email = email.strip().lower()
    if not changes:
        return get_person(email)

    unknown = set(changes) - PERSON_UPDATABLE
    if unknown:
        raise ValueError(f"cannot update: {', '.join(sorted(unknown))}")

    parts = ["#updated_at = :updated_at"]
    names = {"#updated_at": "updated_at"}
    values: dict[str, Any] = {":updated_at": datetime.utcnow().isoformat()}

    for field, value in changes.items():
        parts.append(f"#{field} = :{field}")
        names[f"#{field}"] = field
        values[f":{field}"] = value

    try:
        response = get_people_table().update_item(
            Key={"email": email},
            UpdateExpression="SET " + ", ".join(parts),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_exists(email)",
            ReturnValues="ALL_NEW",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return None
        logger.error("Error updating person %s: %s", email, e)
        raise
    return PersonModel.from_item(response.get("Attributes", {}))


def deactivate_person(email: str) -> Optional[dict[str, Any]]:
    """
    Soft-delete: mark inactive, keeping the row.

    The gentler of the two removals, and still the right default for someone who has
    simply moved on: their assignments stay intact, so an old schedule remains
    readable and the record of who was responsible survives.

    Contrast delete_person below, which is for a row that should never have existed.
    """
    return update_person(email, {"active": False})


def delete_person(email: str) -> bool:
    """
    Hard-delete: remove the row entirely. True if there was one to remove.

    Only safe when paired with queries.projects.unassign_person, because projects and
    phases reference people by email rather than by foreign key - delete the row on
    its own and every assignment becomes a person-shaped string with nothing behind
    it, which is the "Liam -> AI Hire" failure the workbook was full of. The route
    does both, in that order, and nothing else should call this alone.

    The cost is real and is the caller's to accept: unlike deactivate_person, this
    loses the record of who was responsible. It exists for roster rows that are wrong
    rather than finished - a duplicate, a typo'd address, a placeholder - where
    leaving an inactive row behind preserves nothing worth keeping.
    """
    try:
        response = get_people_table().delete_item(
            Key={"email": email.strip().lower()}, ReturnValues="ALL_OLD"
        )
    except ClientError as e:
        logger.error("Error deleting person %s: %s", email, e)
        raise
    return bool(response.get("Attributes"))
