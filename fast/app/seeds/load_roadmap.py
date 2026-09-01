#!/usr/bin/env python3
"""
Load the extracted workbook into DynamoDB.

    python3 -m app.seeds.load_roadmap --roadmap roadmap.json --people people.json
    python3 -m app.seeds.load_roadmap --roadmap roadmap.json --people people.json --write

This is the far side of the one-way door. migrate/extract_workbook.py turns the
.xlsx into typed JSON and reports everything that will not survive the trip; this
takes that JSON and writes it. Dry run by default, for the same reason the extractor
is read-only by default: the interesting output is the list of things it will not do.

WHY A SEPARATE PEOPLE MAP
-------------------------
The workbook identifies owners by first name - "Joe", "Timan", "Ha" - because a
spreadsheet cell has nowhere else to put a person. The data model uses email as the
key, since that is what Cognito puts in a token and what makes "am I the DRI of this"
a comparison rather than a lookup.

There is no safe way to derive one from the other. first.lower() + "@qwealth.com" is
a guess, and a wrong guess here is not a visible error: it creates a person who
looks real, owns projects, and never receives anything. So the mapping is an
explicit file, and an unmapped name is a hard stop rather than a default. That is
the same rule the extractor follows, and for the same reason - a silently-defaulted
value is precisely the failure mode this migration exists to end.

people.json is:  {"Joe": "joe@qwealth.com", "Timan": "timan@qwealth.com", ...}
"""

import argparse
import json
import os
import sys
from typing import Any, Optional

# Run as a module from fast/, so the app package is importable either way.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from app.db.queries import people as people_q, projects as project_q  # noqa: E402


def resolve_people(
    roadmap: dict[str, Any], mapping: dict[str, str]
) -> tuple[dict[str, str], list[str]]:
    """
    Map every name the workbook mentions to an email. Report the ones that fail.

    Case- and whitespace-insensitive on the workbook side, because "Joe " and "joe"
    both appear in the sheet and neither is a different person.
    """
    lookup = {k.strip().lower(): v.strip().lower() for k, v in mapping.items()}

    mentioned: set[str] = set()
    for person in roadmap.get("people", []):
        if person.get("name"):
            mentioned.add(person["name"])
    for project in roadmap.get("projects", []):
        for key in ("dri", "support"):
            if project.get(key):
                mentioned.add(project[key])
        for phase in project.get("phases", []):
            if phase.get("owner"):
                mentioned.add(phase["owner"])

    resolved: dict[str, str] = {}
    unmapped: list[str] = []
    for name in sorted(mentioned):
        email = lookup.get(name.strip().lower())
        if email:
            resolved[name] = email
        else:
            unmapped.append(name)
    return resolved, unmapped


def plan(roadmap: dict[str, Any], resolved: dict[str, str]) -> dict[str, Any]:
    """Build exactly what would be written, without writing it."""
    people = []
    for person in roadmap.get("people", []):
        name = person.get("name")
        email = resolved.get(name)
        if not email:
            continue
        # No roles. The workbook records names, not disciplines, and deriving "Ha is a
        # BA" from a first name is precisely the plausible-looking invention this
        # loader refuses to make with email addresses. Seeded people come in with an
        # empty role list and fill it in themselves - see app/roles.py.
        people.append({"email": email, "name": name})

    projects = []
    for project in sorted(roadmap.get("projects", []), key=lambda p: p.get("order", 0)):
        phases = []
        for order, phase in enumerate(project.get("phases", [])):
            structural = phase.get("structural", False)
            phases.append({
                "name": phase["name"],
                "phase_order": order,
                "owner_email": resolved.get(phase.get("owner")) if phase.get("owner") else None,
                # Nulls pass straight through. The workbook's #REF!s, its 1900-era
                # serials and its blank cells all became None in the extractor, and
                # they stay None here - "unscheduled" is a state, not a gap to fill.
                "start": None if structural else phase.get("start"),
                "end": None if structural else phase.get("end"),
                "progress": None if structural else phase.get("progress"),
                "structural": structural,
            })
        projects.append({
            "name": project["name"],
            "lane_order": project.get("order", 0),
            "dri_email": resolved.get(project.get("dri")) if project.get("dri") else None,
            "support_email": (
                resolved.get(project.get("support")) if project.get("support") else None
            ),
            "phases": phases,
        })

    return {"people": people, "projects": projects}


def summarise(written: dict[str, Any]) -> None:
    """Print what is about to happen, gaps and all."""
    people, projects = written["people"], written["projects"]
    phases = [ph for p in projects for ph in p["phases"]]
    real = [ph for ph in phases if not ph["structural"]]
    complete = [
        ph for ph in real
        if ph["start"] and ph["end"] and ph["progress"] is not None
    ]

    print("people %d   projects %d   phases %d (%d real, %d structural)"
          % (len(people), len(projects), len(phases), len(real), len(phases) - len(real)))
    print("fully populated phases: %d of %d (%.0f%%)"
          % (len(complete), len(real), 100.0 * len(complete) / len(real) if real else 0))
    print()

    print("%-26s %-22s %-22s %s" % ("PROJECT", "DRI", "SUPPORT", "PHASES"))
    for project in projects:
        print("%-26s %-22s %-22s %d" % (
            project["name"][:26],
            project["dri_email"] or "-- none --",
            project["support_email"] or "-- none --",
            len(project["phases"]),
        ))

    idle = [p["name"] for p in people
            if not any(pr["dri_email"] == p["email"] or pr["support_email"] == p["email"]
                       for pr in projects)]
    if idle:
        print("\non the roster, owning nothing: %s" % ", ".join(sorted(idle)))


def load(written: dict[str, Any]) -> None:
    """Write it. People first, so project owner references resolve to real rows."""
    for person in written["people"]:
        try:
            people_q.create_person(
                email=person["email"],
                name=person["name"],
            )
            print("  + person %s" % person["email"])
        except ValueError:
            # Already on the roster. Left exactly as it is rather than overwritten - a
            # re-run of the seed must not reset a name, a role or a skill that somebody
            # has since filled in through the app.
            print("  = person %s (exists, untouched)" % person["email"])

    for project in written["projects"]:
        created = project_q.create_project(
            name=project["name"],
            lane_order=project["lane_order"],
            dri_email=project["dri_email"],
            support_email=project["support_email"],
            phases=project["phases"],
        )
        print("  + project %s (%s) with %d phases"
              % (created["name"], created["project_id"], len(created["phases"])))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--roadmap", required=True, help="roadmap.json from extract_workbook.py")
    ap.add_argument("--people", required=True, help='{"Joe": "joe@qwealth.com", ...}')
    ap.add_argument("--write", action="store_true", help="actually write to DynamoDB")
    ap.add_argument(
        "--allow-unmapped",
        action="store_true",
        help="store an unmapped owner as null instead of stopping",
    )
    args = ap.parse_args()

    with open(args.roadmap) as fh:
        roadmap = json.load(fh)
    with open(args.people) as fh:
        mapping = json.load(fh)

    resolved, unmapped = resolve_people(roadmap, mapping)

    if unmapped and not args.allow_unmapped:
        raise SystemExit(
            "no email for: %s\n"
            "Add them to %s, or pass --allow-unmapped to store these owners as null.\n"
            "Not guessing: an invented address creates a person who looks real, owns "
            "projects, and never receives anything."
            % (", ".join(unmapped), args.people)
        )
    if unmapped:
        print("unmapped, storing as null: %s\n" % ", ".join(unmapped))

    written = plan(roadmap, resolved)
    summarise(written)

    if not args.write:
        print("\n(dry run -- pass --write to load into DynamoDB)")
        return

    # Refuse to seed on top of existing data. create_project always mints a new id,
    # so a second run would not update the first one - it would silently double every
    # lane on the roadmap, and the only way back is deleting rows by hand.
    existing = project_q.list_projects(include_inactive=True)
    if existing:
        raise SystemExit(
            "refusing to seed: %d project(s) already present. This loader creates, it "
            "does not merge, so running it again would duplicate every lane."
            % len(existing)
        )

    print()
    load(written)
    print("\nloaded.")


if __name__ == "__main__":
    main()
