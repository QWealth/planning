"""DynamoDB item shapes for projects, phases, people and the audit log.

Static methods over boto3 rather than an ORM, following
marketing_compliance_review/fast/app/db/models.py. `from_item` supplies defaults
for every field so an item written before a field existed still validates, instead
of failing the whole list response.

THE ONE RULE THIS FILE EXISTS TO ENFORCE
----------------------------------------
A missing date is null, and null survives the round trip.

That is the entire reason we left the workbook. Excel had no way to say "this phase
is not scheduled yet", so people typed 0, or left a #REF! in place, or wrote a
relative day offset - and Excel drew a bar in January 1900 and reported nothing. So
here `start`, `end` and `progress` are genuinely nullable, "unscheduled" is a state
the UI renders as such, and nothing in this layer is allowed to invent a default.
See UNSET below for the update-path half of the same rule.
"""

import json
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Any, Optional

# Sort-key prefixes. Projects and phases share a partition so that one Query
# returns a project and all of its phases.
#
# "#PROJECT" is deliberately punctuation-first: "#" (0x23) sorts before "P" (0x50),
# so the project row always comes back as the first item of the page. With the
# obvious "PROJECT" the phases would sort first ("PHASE#" < "PROJECT"), and any
# caller that reasonably assumed items[0] was the project would be wrong in a way
# that only shows up once a project has phases.
# "MILESTONE#" sorts between the two ("M" 0x4D < "P" 0x50), which changes nothing
# that matters: the project row is still items[0] because "#" beats both.
PROJECT_SK = "#PROJECT"
PHASE_SK_PREFIX = "PHASE#"
MILESTONE_SK_PREFIX = "MILESTONE#"


class Role(str, Enum):
    """Who owns a project, in which capacity."""

    DRI = "DRI"
    SUPPORT = "SUPPORT"


class UnsetType:
    """
    Sentinel meaning "the caller did not mention this field".

    Needed because None is a real, meaningful value here and cannot double as
    "absent". The marketing tool's update_rule skips any field that is None, which
    is fine when None only ever means "not supplied" - but in this app None means
    "unscheduled", so that idiom would make it impossible to clear a date once set.
    Un-scheduling a phase is a first-class operation, not an edge case: it is what
    you do when a project slips and nobody has re-planned it yet, and forcing a
    stale date to stay put would recreate the exact Excel failure of a bar on the
    chart that nobody believes.
    """

    _instance: Optional["UnsetType"] = None

    def __new__(cls) -> "UnsetType":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __bool__(self) -> bool:
        return False

    def __repr__(self) -> str:
        return "UNSET"


UNSET = UnsetType()


def to_decimal(value: Any) -> Any:
    """
    Convert a float to Decimal for DynamoDB, passing everything else through.

    boto3 refuses floats outright ("Float types are not supported"), so this is not
    a nicety. Via str() rather than Decimal(float) because Decimal(0.85) is
    0.8500000000000000888..., which stores fine and then comes back as a progress
    value that renders as 85.00000000000001%.
    """
    if isinstance(value, float):
        return Decimal(str(value))
    return value


def from_decimal(value: Any) -> Any:
    """Convert a Decimal back to int or float on the way out to JSON."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


def json_default(value: Any) -> Any:
    """JSON encoder fallback for types boto3 returns that json cannot handle."""
    if isinstance(value, Decimal):
        return from_decimal(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _now() -> str:
    return datetime.utcnow().isoformat()


class ProjectModel:
    """A lane on the roadmap."""

    @staticmethod
    def create_item(
        project_id: str,
        name: str,
        lane_order: int,
        dri_email: Optional[str] = None,
        support_email: Optional[str] = None,
        active: bool = True,
    ) -> dict[str, Any]:
        """
        Build a project item.

        dri_email and support_email are nullable and are foreign keys into the
        people table, not free text. The workbook had "Liam -> AI Hire" typed into a
        DRI cell, which is unqueryable and un-renamable; four of the nine projects
        had the cell blank entirely. Both facts survive here as an honest null plus
        a reference, rather than as prose.
        """
        now = _now()
        return {
            "project_id": project_id,
            "sk": PROJECT_SK,
            "name": name,
            "lane_order": lane_order,
            "dri_email": dri_email,
            "support_email": support_email,
            "active": active,
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> dict[str, Any]:
        """Convert a DynamoDB item to a schema-compatible dict."""
        return {
            "project_id": item.get("project_id"),
            "name": item.get("name"),
            "lane_order": from_decimal(item.get("lane_order", 0)),
            "dri_email": item.get("dri_email") or None,
            "support_email": item.get("support_email") or None,
            "active": item.get("active", True),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }


class PhaseModel:
    """A band of work within a project."""

    @staticmethod
    def sk(phase_id: str) -> str:
        return f"{PHASE_SK_PREFIX}{phase_id}"

    @staticmethod
    def create_item(
        project_id: str,
        phase_id: str,
        name: str,
        phase_order: int,
        owner_email: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
        progress: Optional[float] = None,
        structural: bool = False,
    ) -> dict[str, Any]:
        """
        Build a phase item.

        start and end are ISO dates (YYYY-MM-DD), not Excel serials and not
        datetimes. A phase is scheduled to a day; storing a timestamp would invite a
        timezone to change which day a deadline falls on for a reader in another
        office, which is a bug with no upside.

        `structural` marks the Maintenance band: ongoing support rather than
        scheduled work. It legitimately has no dates and no progress, so it must not
        be drawn as a bar and must not be counted as a data-quality gap. Without
        this flag the nine Maintenance rows contributed 14 spurious "missing date"
        issues to the migration report, burying the ~20 that need a real decision.
        """
        now = _now()
        return {
            "project_id": project_id,
            "sk": PhaseModel.sk(phase_id),
            "phase_id": phase_id,
            "name": name,
            "phase_order": phase_order,
            "owner_email": owner_email,
            "start": start,
            "end": end,
            "progress": to_decimal(progress),
            "structural": structural,
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> dict[str, Any]:
        """
        Convert a DynamoDB item to a schema-compatible dict.

        `progress` uses an explicit `is None` test rather than `or None`. A truthy
        test would map a real, meaningful 0.0 ("started, nothing done") onto null
        ("nobody has said"), silently merging two states the whole design is trying
        to keep apart.
        """
        progress = item.get("progress")
        return {
            "project_id": item.get("project_id"),
            "phase_id": item.get("phase_id"),
            "name": item.get("name"),
            "phase_order": from_decimal(item.get("phase_order", 0)),
            "owner_email": item.get("owner_email") or None,
            "start": item.get("start") or None,
            "end": item.get("end") or None,
            "progress": from_decimal(progress) if progress is not None else None,
            "structural": item.get("structural", False),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }


class MilestoneModel:
    """
    A dated point on a lane: "Beta launch", "Regulatory deadline", "Client demo".

    A milestone is NOT a zero-length phase, and the distinction is worth keeping.
    A phase is work with a duration that somebody owns and that has progress; a
    milestone is a moment something is due, owned by the calendar. Modelling one as
    the other would mean either phases that cannot have an owner or milestones that
    report as 0% complete forever, and both show up on the chart as a lie.

    `date` IS NULLABLE, deliberately, and this is the same argument as everywhere
    else in this file. "We need a beta launch and nobody has committed to when" is a
    real and common state, and the alternative to storing it honestly is somebody
    typing a date they do not believe - which is precisely the workbook behaviour
    this app exists to end. An undated milestone is reported as a gap and is not
    drawn, exactly like an undated phase.

    `done` is separate from "the date has passed", because those are different facts
    and the gap between them is the interesting one. A milestone dated last month
    with done=False is a missed deadline and the report says so; deriving doneness
    from the date alone would quietly mark every slipped commitment as achieved.
    """

    @staticmethod
    def sk(milestone_id: str) -> str:
        return f"{MILESTONE_SK_PREFIX}{milestone_id}"

    @staticmethod
    def create_item(
        project_id: str,
        milestone_id: str,
        name: str,
        date: Optional[str] = None,
        note: Optional[str] = None,
        done: bool = False,
    ) -> dict[str, Any]:
        """Build a milestone item. `date` is an ISO day string, or None."""
        now = _now()
        return {
            "project_id": project_id,
            "sk": MilestoneModel.sk(milestone_id),
            "milestone_id": milestone_id,
            "name": name,
            "date": date,
            "note": note or None,
            "done": done,
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> dict[str, Any]:
        """Convert a DynamoDB item to a schema-compatible dict."""
        return {
            "project_id": item.get("project_id"),
            "milestone_id": item.get("milestone_id"),
            "name": item.get("name"),
            "date": item.get("date") or None,
            "note": item.get("note") or None,
            "done": item.get("done", False),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }


class PersonModel:
    """Someone on the roster, keyed by email."""

    @staticmethod
    def create_item(
        email: str,
        name: str,
        roles: Optional[list[str]] = None,
        active: bool = True,
        specialisations: Optional[list[dict[str, Any]]] = None,
    ) -> dict[str, Any]:
        """
        Build a person item.

        Keyed on email rather than a generated id: it is the natural key, it is what
        Cognito puts in the token, and it is what makes "is the logged-in user the
        DRI of this project" a comparison rather than a lookup.

        `roles` is optional *here* while being required at the API edge, and the split
        is deliberate: the schema is where a human filling in a form is told to pick
        one, and this layer also serves the workbook seed, which has no roles to give.
        """
        now = _now()
        return {
            "email": email.strip().lower(),
            "name": name,
            "roles": roles or [],
            "active": active,
            "specialisations": specialisations or [],
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> dict[str, Any]:
        """Convert a DynamoDB item to a schema-compatible dict."""
        return {
            "email": item.get("email"),
            "name": item.get("name"),
            # Both of the next two default to empty for the same reason, and it is not
            # a theoretical guard: everyone already on the roster predates both fields,
            # so without the defaults the existing roster fails response validation on
            # the very first read.
            "roles": PersonModel._roles(item),
            "active": item.get("active", True),
            "specialisations": PersonModel._specialisations(item),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }

    @staticmethod
    def _roles(item: dict[str, Any]) -> list[str]:
        """
        Read the role list defensively, dropping anything that is not a string.

        Same rule as _specialisations below. A DynamoDB list can hold anything, and a
        number or a nested map where a role belongs must cost one odd-looking row
        rather than 500 the whole roster. Values are NOT checked against the Role enum
        here: a role retired from the vocabulary later should still display on the
        people who have it, not vanish silently from their row.
        """
        raw = item.get("roles") or []
        if not isinstance(raw, list):
            return []
        return [str(r) for r in raw if isinstance(r, str) and r]

    @staticmethod
    def _specialisations(item: dict[str, Any]) -> list[dict[str, Any]]:
        """
        Read the skill list defensively, dropping anything malformed.

        Same rule as the plain-str email on PersonOut: one bad record should cost one
        odd-looking row, never the whole endpoint. A hand-edited item with a string
        where an object belongs would otherwise 500 GET /api/people for everybody.
        """
        raw = item.get("specialisations") or []
        if not isinstance(raw, list):
            return []
        out: list[dict[str, Any]] = []
        for entry in raw:
            if isinstance(entry, dict) and entry.get("skill"):
                out.append(
                    {
                        "skill": str(entry["skill"]),
                        "level": str(entry.get("level") or "secondary"),
                    }
                )
        return out


class AuditLogModel:
    """
    One row per mutation: what changed, from what, to what, and by whom.

    Keyed entity_id (partition) + timestamp (sort), so "who moved this date" is a
    single Query against one partition. The marketing tool's audit table partitions
    on timestamp alone, which its own config.py flags as a mistake - every item in
    its own partition, no key to query by, and answering any question means scanning
    the whole table forever.
    """

    ENTITY_PROJECT = "project"
    ENTITY_PHASE = "phase"
    ENTITY_MILESTONE = "milestone"
    ENTITY_PERSON = "person"
    ENTITY_ASSIGNMENT = "assignment"

    @staticmethod
    def create_entry(
        action: str,
        entity: str,
        entity_id: str,
        before: Optional[dict[str, Any]] = None,
        after: Optional[dict[str, Any]] = None,
        user_email: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Build an audit entry.

        before/after are JSON strings rather than nested maps, matching the
        compliance audit table. That keeps DynamoDB from imposing its type system on
        a snapshot whose shape will drift as the schema does - and a null date
        stored as a JSON null stays a null, where a DynamoDB map would need a
        NULL-typed attribute to say the same thing.
        """
        return {
            "entity_id": entity_id,
            "timestamp": _now(),
            "action": action,
            "entity": entity,
            "before": json.dumps(before, default=json_default) if before else None,
            "after": json.dumps(after, default=json_default) if after else None,
            "user_email": user_email or "system",
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> dict[str, Any]:
        """Convert a DynamoDB item to a schema-compatible dict."""
        return {
            "entity_id": item.get("entity_id"),
            "timestamp": item.get("timestamp"),
            "action": item.get("action"),
            "entity": item.get("entity"),
            "before": json.loads(item["before"]) if item.get("before") else None,
            "after": json.loads(item["after"]) if item.get("after") else None,
            "user_email": item.get("user_email", "system"),
        }
