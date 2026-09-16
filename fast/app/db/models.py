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

# The star scale and the read-time mapping off the old `level` string. Imported
# rather than restated so the bounds cannot drift from the ones the schema validates
# against; app/skills.py imports nothing from the app, so this cannot cycle.
from app.skills import LEGACY_DEFAULT_STARS, LEGACY_LEVEL_STARS, MAX_STARS, MIN_STARS

# The kind discriminator and the two status vocabularies for the work table.
# Imported for the same reason skills is: the defaults written here and the values
# the schema validates against must be one list, not two that can drift.
from app.work import Kind, RfcStatus, TaskStatus

# The digest's opt-in default, imported for the reason above: it is one
# decision and it must not be written down twice. app/digest.py imports
# nothing from the app, so this cannot cycle.
from app.digest import DEFAULT_DIGEST_ENABLED

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

# The work table's sort key, in the OTHER table (planning-roadmap-work), which is
# partitioned on item_id. Fixed for every row today: an RFC and a task are each one
# item, so there is nothing to sort within a partition yet.
#
# It exists anyway because a sort key cannot be added to a live DynamoDB table, only
# migrated to, and the first thing this table will want is comments on an RFC that is
# "In review" - which is a child row and needs somewhere to go. Punctuation-first for
# the same reason PROJECT_SK is, so that when children do arrive the item itself
# still sorts first and items[0] stays a safe assumption.
WORK_SK = "#ITEM"

# The child row the note above predicted. "C" (0x43) sorts after "#" (0x23), so the
# item itself is still items[0] and every read that assumed so keeps working.
#
# Unlike PHASE_SK_PREFIX, the timestamp goes IN the key: `COMMENT#<created_at>#<id>`.
# A phase has no natural order within its project, but a thread does, and putting the
# time in the sort key means DynamoDB returns a discussion already in reading order -
# no client-side sort that a second caller can forget to apply.
#
# The cost of that choice is that a comment's key cannot be derived from its id alone,
# so editing or deleting one has to find the row first. That cost is zero in practice:
# both operations must read the comment anyway to check who wrote it before allowing
# the change.
COMMENT_SK_PREFIX = "COMMENT#"


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
        category: Optional[str] = None,
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
            # What kind of work this lane is - "App", "Data", "QC". FREE TEXT, and
            # deliberately not a closed list, which is the opposite of what roles.py
            # and skills.py argue for.
            #
            # Those lists are closed because the vocabulary was known: somebody could
            # write down the seven roles and be right. Nobody can write down this one
            # from here. Inventing "App / Data / QC / Reporting" by reading nine
            # project names would be exactly the plausible-looking guess at an org
            # chart that roles.py refuses to make when it declines to split
            # outside-engineering into four.
            #
            # So the team authors it by using it, and the editor offers every value
            # already in use so the second project reuses the first's spelling rather
            # than retyping it. That is what keeps "Data" from becoming "data" and
            # "DATA" - a datalist rather than an enum, because the enum would have to
            # be guessed first. Null is a real state and means nobody has filed it.
            "category": category,
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
            # Empty string reads as None. Every project predates this field, so absent
            # has to mean "not filed" rather than an error - the same rule roles and
            # specialisations already follow.
            "category": item.get("category") or None,
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

    `phase_id` IS NULLABLE, AND THE NULL IS THE COMMON CASE
    -------------------------------------------------------
    A milestone may name the phase it belongs to - "Infra hardening signed off"
    sits under Infra - or it may name none, because plenty of them belong to the
    project as a whole. "Regulatory deadline" is not a step inside any one stage of
    the work; it is a date the entire lane answers to. Requiring an attachment would
    force one of those two shapes to be filed under the other, and the phase it got
    filed under would then appear to own a commitment it does not control.

    Stored as a plain string with no foreign key, like every other reference in this
    table, so the invariant is the writers' job: create_milestone and update_milestone
    both check the phase belongs to the SAME project, and delete_phase detaches its
    milestones rather than leaving them behind. A phase_id pointing at a phase that
    is gone is a milestone filed under a heading nothing draws - present in the table,
    absent from the chart, which is the one failure mode this app exists to end.
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
        phase_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Build a milestone item. `date` is an ISO day string, or None.

        `phase_id` is last and defaults to None so that every existing caller - the
        batch inside create_project, the tests, demo.py - keeps meaning what it did:
        a milestone belonging to the project rather than to any stage of it.
        """
        now = _now()
        return {
            "project_id": project_id,
            "sk": MilestoneModel.sk(milestone_id),
            "milestone_id": milestone_id,
            "name": name,
            "date": date,
            "note": note or None,
            "done": done,
            # Normalised to a real null, not "". An empty string is what a form sends
            # for "not tied to a phase", and left alone it is a phase id that passes a
            # truthy check and matches no phase.
            "phase_id": phase_id or None,
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> dict[str, Any]:
        """
        Convert a DynamoDB item to a schema-compatible dict.

        `phase_id` uses .get with no default on purpose: every milestone written
        before this field existed simply has no attribute, and "absent" and "attached
        to nothing" are the same fact here - unlike `date`, where they would not be.
        """
        return {
            "project_id": item.get("project_id"),
            "milestone_id": item.get("milestone_id"),
            "name": item.get("name"),
            "date": item.get("date") or None,
            "note": item.get("note") or None,
            "done": item.get("done", False),
            "phase_id": item.get("phase_id") or None,
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
            # When this person last opened each RFC: {item_id: ISO timestamp}.
            #
            # A timestamp rather than a set of ids, because it costs the same and
            # answers a second question the ids cannot: whether the document has
            # been edited since they read it. Only "never opened" is drawn today.
            #
            # Defaults to {} rather than None so every caller can index it without
            # a guard - a person who has read nothing and a person created before
            # this existed are the same thing, unlike the absent-vs-null cases
            # elsewhere in this file.
            "rfcs_read": item.get("rfcs_read") or {},
            # The Monday digest settings. The DEFAULT IS IMPORTED, not restated, and
            # that is a bug fix rather than tidiness: this line used to hardcode False
            # while app/digest.py held its own DEFAULT_DIGEST_ENABLED, so there were
            # two defaults for one decision - and because from_item runs first, the
            # one here silently won. Turning the other one on changed nothing at all,
            # which a dry run caught and reading either file alone would not have.
            #
            # Same argument as the skills and status imports at the top of this file:
            # a value that has to agree in two places will eventually not.
            #
            # The window is clamped in app/digest.py rather than here, because the
            # rule about which windows exist belongs with the code that uses it.
            "digest_enabled": bool(item.get("digest_enabled", DEFAULT_DIGEST_ENABLED)),
            "digest_days": PersonModel._digest_days(item),
            "digest_admin_report": bool(item.get("digest_admin_report", False)),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }

    @staticmethod
    def _digest_days(item: dict[str, Any]) -> int:
        """
        The lookahead window, as an int, for anything the table might hold.

        DynamoDB returns numbers as Decimal, which the response model would reject as
        a non-int, and a hand-edited string here must not 500 the roster for everybody
        - the same rule as _stars above.
        """
        try:
            return int(item.get("digest_days", 14))
        except (TypeError, ValueError):
            return 14

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

        THIS IS ALSO THE MIGRATION, AND THERE IS NO OTHER ONE.

        Entries written before the star scale carry a `level` string instead of
        `stars`, and are converted here rather than by a backfill script: primary ->
        3, secondary -> 2, learning -> 0 stars with wants_to_learn set. Doing it on
        read means no downtime, no one-off job to run against production, and no
        window in which half the table is in each shape. Writes use the new fields, so
        rows convert for real as people edit their own entries - and until they do,
        both shapes read back identically.

        Do not delete this once the table looks converted. "Looks converted" is a
        statement about the rows somebody happened to check, and the cost of keeping
        it is one dict lookup per skill.
        """
        raw = item.get("specialisations") or []
        if not isinstance(raw, list):
            return []
        out: list[dict[str, Any]] = []
        for entry in raw:
            if not isinstance(entry, dict) or not entry.get("skill"):
                continue
            out.append(
                {
                    "skill": str(entry["skill"]),
                    "stars": PersonModel._stars(entry),
                    # Either the stored flag, or the old `learning` level, which is
                    # exactly what that value always meant.
                    "wants_to_learn": bool(entry.get("wants_to_learn"))
                    or str(entry.get("level") or "") == "learning",
                }
            )
        return out

    @staticmethod
    def _stars(entry: dict[str, Any]) -> int:
        """
        The star rating for one entry, from either shape, clamped to the scale.

        Clamped rather than validated, because this is a read: a 7 in the table is
        somebody's console edit and should show as three stars, not raise. The int()
        is guarded too - DynamoDB hands numbers back as Decimal, which int() is happy
        with, but a string or a nested map where a number belongs would otherwise be
        an uncaught TypeError on the roster endpoint, which is the exact failure the
        rest of this method exists to prevent.
        """
        if "stars" in entry:
            try:
                stars = int(entry["stars"])
            except (TypeError, ValueError):
                stars = LEGACY_DEFAULT_STARS
        else:
            stars = LEGACY_LEVEL_STARS.get(
                str(entry.get("level") or ""), LEGACY_DEFAULT_STARS
            )
        return max(MIN_STARS, min(MAX_STARS, stars))


class RfcModel:
    """
    A written proposal, with or without a project attached.

    `project_id` IS NULLABLE and that is the whole reason this lives in its own
    table. In the projects table project_id is the partition key, so "an RFC about
    how we do code review, which is not about any one project" could only be stored
    by inventing a fake project to hang it on. Here it is an ordinary attribute and
    the honest answer is null - the same rule that lets a phase have no dates.

    `body` is markdown and is NOT nullable; it defaults to "". This looks like an
    exception to the absent-vs-null rule and is not one. That rule exists because an
    unscheduled date and a date of zero are genuinely different facts. Prose has a
    real empty value: an RFC nobody has written yet and an RFC written as the empty
    string are the same document, so a second way to say "no text" would be a
    distinction with nothing behind it.

    `decided_on`, never `date`. Naming a pydantic field after its own type cost this
    codebase a debugging round once - see MilestoneModel and the Milestone section of
    CLAUDE.md - because the assignment binds before the annotation resolves and the
    field silently becomes NoneType, rejecting every real date with a 422. The word
    is avoided here rather than worked around.
    """

    @staticmethod
    def create_item(
        item_id: str,
        title: str,
        body: str = "",
        status: str = RfcStatus.DRAFT.value,
        project_id: Optional[str] = None,
        owner_email: Optional[str] = None,
        decided_on: Optional[str] = None,
        created_by: Optional[str] = None,
        skills: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Build an RFC item. `decided_on` is an ISO day string, or None."""
        now = _now()
        return {
            "item_id": item_id,
            "sk": WORK_SK,
            "kind": Kind.RFC.value,
            "title": title,
            "body": body or "",
            "status": status,
            "project_id": project_id,
            "owner_email": owner_email,
            "decided_on": decided_on,
            "created_by": created_by,
            # Who this proposal wants in the room, by capability rather than by name.
            # Names go stale as people move around; "this is a back-end decision" does
            # not, and the roster already records who holds what.
            "skills": skills or [],
            # When it became open for comment, which is when chasing starts counting
            # from. Stored rather than derived from the audit trail: audit writes are
            # best-effort and swallow their own errors, so a missing row would make the
            # chase either never start or never stop, with nothing to show why.
            "review_since": now if status == RfcStatus.REVIEW.value else None,
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> dict[str, Any]:
        """Convert a DynamoDB item to a schema-compatible dict."""
        return {
            "item_id": item.get("item_id"),
            "kind": Kind.RFC.value,
            "title": item.get("title"),
            "body": item.get("body") or "",
            "status": item.get("status") or RfcStatus.DRAFT.value,
            "project_id": item.get("project_id") or None,
            "owner_email": item.get("owner_email") or None,
            "decided_on": item.get("decided_on") or None,
            "created_by": item.get("created_by") or None,
            # [] rather than None for the same reason `body` defaults to "": there is no
            # useful difference between "tagged with nothing" and "nobody has tagged it".
            "skills": item.get("skills") or [],
            "review_since": item.get("review_since") or None,
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }


class MilestoneCheckModel:
    """
    One answer to one "did this land?" question, written once and never edited.

    A LOG, NOT A VIEW OF CURRENT STATE
    -----------------------------------
    Every field is a snapshot of how things stood when the question was asked and
    answered: the milestone's name, its due date, who was asked. None of them is looked
    up again on read, and none is updatable.

    That is the whole design and it is worth being explicit about, because the obvious
    alternative - storing milestone_id and joining on read - is wrong here in a way it
    is not wrong for, say, a comment. The point of this log is "what did we commit to,
    did it happen, and what was said about it". A milestone that is renamed, moved to a
    new date or deleted a fortnight later must not retroactively change the record of a
    question somebody already answered. Joining on read would do exactly that, and the
    entries most worth reading - the ones about deadlines that slipped and were then
    rescheduled - are precisely the ones the join would rewrite.

    `reason` IS NULLABLE AND MEANS TWO THINGS
    ------------------------------------------
    Null against a `done` answer is "there was nothing to explain". Null against a
    `not_done` answer is "they were asked and did not say" - a modal dismissed rather
    than submitted. Both are real states and neither is an error, which is why the
    reason is not required and why the reader distinguishes them by the answer rather
    than by the presence of text.

    The answer vocabulary lives in app/milestone_check.py, imported rather than
    restated so the stored values cannot drift from the ones that get written.
    """

    @staticmethod
    def create_item(
        item_id: str,
        project_id: str,
        project_name: str,
        milestone_id: str,
        milestone_name: str,
        due: str,
        asked_email: str,
        answer: str,
        reason: Optional[str] = None,
    ) -> dict[str, Any]:
        """Build a log row. `due` is an ISO day string; `answer` is one of ANSWERS."""
        now = _now()
        return {
            "item_id": item_id,
            "sk": WORK_SK,
            "kind": Kind.MILESTONE_CHECK.value,
            "project_id": project_id,
            "project_name": project_name,
            "milestone_id": milestone_id,
            "milestone_name": milestone_name,
            "due": due,
            "asked_email": asked_email,
            "answer": answer,
            "reason": (reason or None),
            "created_at": now,
            # Written and never moved. Present because the kind GSI sorts on it, so a
            # row without one would be invisible to every list query - which is the
            # quietest possible way for a log to lose entries.
            "updated_at": now,
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> dict[str, Any]:
        """Convert a DynamoDB item to a schema-compatible dict."""
        return {
            "item_id": item.get("item_id"),
            "kind": Kind.MILESTONE_CHECK.value,
            "project_id": item.get("project_id"),
            "project_name": item.get("project_name") or "Untitled project",
            "milestone_id": item.get("milestone_id"),
            "milestone_name": item.get("milestone_name") or "Untitled milestone",
            "due": item.get("due"),
            "asked_email": item.get("asked_email"),
            "answer": item.get("answer"),
            "reason": item.get("reason") or None,
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }


class CommentModel:
    """
    One remark on a work item, stored as a child row of the item it is about.

    WHY THE AUTHOR IS A STORED FIELD AND NOT A LOOKUP
    -------------------------------------------------
    `author_email` is written once, at creation, from the caller's token. It is not
    re-derived on read and it is never updatable - see COMMENT_UPDATABLE. A comment is
    a thing somebody said, so the name against it has to be the name of whoever said
    it, fixed at the moment they said it. Recomputing it later from anything - the
    item's owner, the roster, a session - is how a remark ends up attributed to the
    wrong person after an unrelated change.

    WHY `updated_at` RATHER THAN AN `edited` FLAG
    ---------------------------------------------
    A boolean would have to be set by the one code path that edits, and would silently
    stay false for any future path that forgets. `updated_at != created_at` cannot be
    forgotten, because both are written by this module and any edit moves one of them.
    The reader decides how to present that; the row just records the two times.

    There is deliberately no `deleted` or `hidden` field. A comment is removed by
    deleting the row, for the same reason an RFC is hard-deleted: a tombstone in a
    discussion is worse than an absence, and the audit trail keeps the record.
    """

    @staticmethod
    def sort_key(created_at: str, comment_id: str) -> str:
        """
        The child row's sort key. See COMMENT_SK_PREFIX for why the time is in it.

        The id is appended rather than trusted to be unique on its own within a
        timestamp: `_now()` has microsecond resolution, so a collision needs two
        comments on the same item in the same microsecond, but "needs" is not "cannot"
        and losing a comment to a silently overwritten key is not a failure worth
        risking to save twelve characters.
        """
        return f"{COMMENT_SK_PREFIX}{created_at}#{comment_id}"

    @staticmethod
    def create_item(
        item_id: str,
        comment_id: str,
        author_email: str,
        body: str,
    ) -> dict[str, Any]:
        """Build a comment row. `created_at` is computed once and used in the key."""
        now = _now()
        return {
            "item_id": item_id,
            "sk": CommentModel.sort_key(now, comment_id),
            "comment_id": comment_id,
            "author_email": author_email,
            "body": body,
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> dict[str, Any]:
        """Convert a DynamoDB comment row to a schema-compatible dict."""
        return {
            "comment_id": item.get("comment_id"),
            "item_id": item.get("item_id"),
            "author_email": item.get("author_email"),
            "body": item.get("body") or "",
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }


class TaskModel:
    """
    A piece of work that is not a phase on the chart.

    THERE IS NO SEPARATE TICKET. A ticket is a task that has children, a subtask is a
    task that has a parent, and a loose to-do has neither - `parent_id` is the entire
    difference between them. Two entities would have meant duplicating title, status,
    body, owner, project link, ordering and timestamps to gain one boolean's worth of
    information.

    Nesting is capped at ONE level, enforced in queries/work.py in both directions.
    See app/work.py for why: at one level cycles are impossible by construction
    rather than by a check that has to stay correct, and nothing that renders a board
    can recurse without bound.

    A parent's status is NOT derived from its children, deliberately. Same argument
    as MilestoneModel.done being independent of the date: the state worth surfacing
    is the one where the two disagree, and "every subtask done, ticket still open"
    is a real situation that a derived parent would erase.

    `task_order` exists now although nothing sorts by it yet, because adding an
    ordering column later means backfilling every row. It follows the same rule as
    lane_order and phase_order and carries the same trap: it defaults to 0 here, so a
    task created without one sorts to the TOP of the backlog above work already
    there. The client computes and sends the next order, exactly as nextLaneOrder
    does on the roadmap.
    """

    @staticmethod
    def create_item(
        item_id: str,
        title: str,
        body: str = "",
        status: str = TaskStatus.BACKLOG.value,
        project_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        owner_email: Optional[str] = None,
        due: Optional[str] = None,
        task_order: int = 0,
        created_by: Optional[str] = None,
    ) -> dict[str, Any]:
        """Build a task item. `due` is an ISO day string, or None."""
        now = _now()
        return {
            "item_id": item_id,
            "sk": WORK_SK,
            "kind": Kind.TASK.value,
            "title": title,
            "body": body or "",
            "status": status,
            "project_id": project_id,
            "parent_id": parent_id,
            "owner_email": owner_email,
            "due": due,
            "task_order": task_order,
            "created_by": created_by,
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> dict[str, Any]:
        """Convert a DynamoDB item to a schema-compatible dict."""
        return {
            "item_id": item.get("item_id"),
            "kind": Kind.TASK.value,
            "title": item.get("title"),
            "body": item.get("body") or "",
            "status": item.get("status") or TaskStatus.BACKLOG.value,
            "project_id": item.get("project_id") or None,
            "parent_id": item.get("parent_id") or None,
            "owner_email": item.get("owner_email") or None,
            "due": item.get("due") or None,
            "task_order": from_decimal(item.get("task_order", 0)),
            "created_by": item.get("created_by") or None,
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }


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
    # RFCs and tasks audit separately even though they share a table. The entity is
    # what /history filters on, and "show me every decision that was withdrawn" and
    # "show me every task that got reassigned" are different questions asked by
    # different screens - a single "work" entity would make each of them read the
    # other's rows and throw most of them away.
    ENTITY_RFC = "rfc"
    ENTITY_TASK = "task"
    # A comment audits under its own entity, keyed by comment_id rather than by the
    # item it hangs on. Filing it under the RFC would be tempting - it is the RFC's
    # /history screen a reader is looking at - but entity_id is what `history` queries,
    # so a deleted comment would then be interleaved with edits to the proposal itself
    # and there would be no way to ask "what happened to this remark" on its own.
    #
    # Auditing deletes at all is the point. A comment row is hard-deleted like the RFC
    # it sits under, so the before-snapshot here is the only remaining copy of what
    # somebody actually said.
    ENTITY_COMMENT = "comment"
    # Not a mutation, and the only entity here that nobody performed. It records that
    # the Monday digest was sent to one person for one week, and it is what stops a
    # retried schedule sending a second copy - see queries/audit.py:claim_once.
    #
    # It lives in this table rather than a new one because the shape already fits
    # exactly: entity_id + timestamp is a natural composite key for "this recipient,
    # that week", the conditional write is free, and the rows are a readable history of
    # what the job actually did. It stays out of every existing query on its own: the
    # /history route reads one entity_id (always a project or a person, never a
    # digest#), and `recent` filters on this constant via the GSI partition.
    ENTITY_NOTIFICATION = "notification"

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
