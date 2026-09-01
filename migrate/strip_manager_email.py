#!/usr/bin/env python3
"""
Remove the `manager_email` attribute from every person in the roster.

    ./fast/venv/bin/python migrate/strip_manager_email.py                 # dry run
    ./fast/venv/bin/python migrate/strip_manager_email.py --write         # do it
    ./fast/venv/bin/python migrate/strip_manager_email.py --write --table planning-roadmap-people-dev

WHY THIS EXISTS AT ALL
----------------------
Removing the field from the code makes the API stop reading and writing it. It does
NOT remove it from DynamoDB, which is schemaless: the attribute simply sits there on
every existing item, invisible to the application and to anybody reading the UI, but
still present in exports, still in the console, and still the workbook's reporting
lines (Timan -> Joe, Meherzad -> Joe).

Leaving it would be the worse outcome of the two. A field that no code reads is a
field nobody maintains, so within a month it is stale data that still *looks*
authoritative to anyone who opens the table or an export. If we are not keeping
reporting lines, they should be gone rather than quietly wrong.

That is a one-way door. Hence the dry run by default, and hence the printed list of
exactly which people are about to lose which manager - so the last chance to say "no,
actually" comes with the data in front of you rather than after.

WHY REMOVE AND NOT SET NULL
---------------------------
`REMOVE` deletes the attribute; setting it to None would leave `manager_email: null`
on every item, which is the same clutter with an extra step and reads as "we checked
and they have no manager" rather than "we no longer track this".

The UpdateExpression is conditioned on the attribute existing, so re-running this is
free: items already done are skipped rather than rewritten, and nothing else on the
item is touched. There is no PutItem here for exactly that reason - a read-modify-
write would race with somebody editing their skills in the app at the same moment and
silently discard their change.
"""

import argparse
import os
import sys

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "ca-central-1")
DEFAULT_TABLE = os.environ.get("PEOPLE_TABLE_NAME", "planning-roadmap-people")

ATTRIBUTE = "manager_email"


def scan_people(table) -> list[dict]:
    """Every item in the table. Paginated, because a Scan truncates at 1 MB."""
    items: list[dict] = []
    kwargs: dict = {}
    while True:
        response = table.scan(**kwargs)
        items.extend(response.get("Items", []))
        last = response.get("LastEvaluatedKey")
        if not last:
            return items
        kwargs["ExclusiveStartKey"] = last


def strip(table, email: str) -> bool:
    """
    Remove the attribute from one person. True if it was there to remove.

    Conditioned rather than unconditional so the count at the end reports what this
    run actually changed, instead of reporting the whole table every time.
    """
    try:
        table.update_item(
            Key={"email": email},
            UpdateExpression="REMOVE #a",
            ExpressionAttributeNames={"#a": ATTRIBUTE},
            ConditionExpression="attribute_exists(#a)",
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument(
        "--write",
        action="store_true",
        help="actually remove it. Without this, only report what would change.",
    )
    parser.add_argument("--table", default=DEFAULT_TABLE, help="people table name")
    parser.add_argument("--region", default=REGION)
    args = parser.parse_args()

    table = boto3.resource("dynamodb", region_name=args.region).Table(args.table)

    try:
        people = scan_people(table)
    except ClientError as e:
        print("could not read %s in %s: %s" % (args.table, args.region, e))
        return 2

    holders = [p for p in people if p.get(ATTRIBUTE)]

    print("table   %s (%s)" % (args.table, args.region))
    print("people  %d" % len(people))
    print("with %s: %d" % (ATTRIBUTE, len(holders)))
    print()

    if not holders:
        print("nothing to do.")
        return 0

    # Printed in full, not counted. This is the last point at which the reporting
    # lines still exist anywhere, so they go on screen before they go away.
    for person in sorted(holders, key=lambda p: str(p.get("name") or p["email"])):
        print("  %-28s %-28s -> %s" % (
            person.get("name") or "?", person["email"], person[ATTRIBUTE]
        ))
    print()

    if not args.write:
        print("DRY RUN - nothing written. Re-run with --write to remove.")
        return 0

    removed = sum(1 for person in holders if strip(table, person["email"]))
    print("removed %s from %d of %d." % (ATTRIBUTE, removed, len(holders)))
    if removed != len(holders):
        # Not an error: somebody else may have run this, or the row may have been
        # edited between the scan and the update. Worth saying out loud either way.
        print("(%d were already clear by the time we got to them.)"
              % (len(holders) - removed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
