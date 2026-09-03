"""Request and response schemas for projects and phases.

THE ABSENT/NULL DISTINCTION
---------------------------
Every field on the Update schemas is Optional and defaults to None, which would
normally make "clear this date" indistinguishable from "leave this date alone".
Pydantic v2 keeps the two apart in `model_fields_set`, so the routes call
`model_dump(exclude_unset=True)` and anything the caller did not mention simply is
not in the dict. A field present with value None means "set to null", which for a
date means "unscheduled" and is a real edit someone will make.

Getting this wrong would be quiet and bad: PATCHing a phase's name would stamp the
start and end dates back to null, and the roadmap would lose schedule data every
time somebody fixed a typo.
"""

from datetime import date as ISODate
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

# Imported under an alias because a milestone's field is itself called `date`, and
# the obvious spelling of that field is a trap:
#
#     from datetime import date
#     class MilestoneBase(BaseModel):
#         date: Optional[date] = None      # <- NOT what it looks like
#
# Python evaluates the assignment before the annotation, so `date` is already bound
# to None in the class namespace by the time the annotation is resolved. The field
# type becomes Optional[None], i.e. NoneType, and pydantic builds a field that
# accepts null and rejects every real date. Nothing fails at import; the first sign
# is a 422 on an obviously valid request. The alias makes the shadowing impossible.


class PhaseBase(BaseModel):
    """Fields common to creating and reading a phase."""

    name: str = Field(min_length=1, max_length=200)
    phase_order: int = 0
    owner_email: Optional[str] = None
    start: Optional[ISODate] = None
    end: Optional[ISODate] = None
    progress: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    structural: bool = False

    @model_validator(mode="after")
    def check_dates(self) -> "PhaseBase":
        """
        Reject a phase that ends before it starts, and dates on a structural band.

        A half-scheduled phase (a start with no end, or the reverse) is allowed
        through deliberately. It is a normal state - you know when something begins
        before you know when it finishes - and refusing it would push people back
        towards inventing an end date, which is how the workbook filled up with
        numbers nobody believed.
        """
        if self.start and self.end and self.end < self.start:
            raise ValueError(
                f"end ({self.end.isoformat()}) is before start ({self.start.isoformat()})"
            )
        if self.structural and (self.start or self.end or self.progress is not None):
            raise ValueError(
                "a structural phase marks ongoing support, not scheduled work, so it "
                "cannot carry dates or progress"
            )
        return self


class PhaseCreate(PhaseBase):
    """Body for creating a phase. phase_id is generated server-side."""


class PhaseUpdate(BaseModel):
    """
    Body for a partial phase update.

    No model_validator comparing start to end here: a PATCH may legitimately carry
    only one of the two, and the other one is in DynamoDB, not in this object. The
    ordering check therefore happens in the query layer, against the merged result.
    Validating here would either miss the case or reject valid edits.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    phase_order: Optional[int] = None
    owner_email: Optional[str] = None
    start: Optional[ISODate] = None
    end: Optional[ISODate] = None
    progress: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    structural: Optional[bool] = None

    def changes(self) -> dict[str, Any]:
        """Only the fields the caller actually sent. See the module docstring."""
        return self.model_dump(exclude_unset=True)


class PhaseOut(BaseModel):
    """A phase as returned by the API."""

    project_id: str
    phase_id: str
    name: str
    phase_order: int = 0
    owner_email: Optional[str] = None
    start: Optional[ISODate] = None
    end: Optional[ISODate] = None
    progress: Optional[float] = None
    structural: bool = False
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class MilestoneBase(BaseModel):
    """
    Fields common to creating and reading a milestone.

    `date` is Optional for the same reason a phase's dates are: "we know there has
    to be a beta launch, nobody has committed to when" is a real state, and refusing
    to store it pushes people into inventing a date. Undated milestones are not drawn
    on the chart - there is nowhere honest to put them on a time axis - so the lane's
    tooltip is what names them. /api/roadmap/gaps used to report them too, and has
    been removed.

    `phase_id` is Optional as well, for a reason of its own rather than the same one.
    A milestone may sit under a phase ("Infra hardening signed off") or under the
    project as a whole ("Regulatory deadline"), and both are ordinary - so the field
    is optional in the sense of "genuinely may be nothing", not "we will fill it in
    later". It is deliberately NOT validated here: whether that phase exists and
    whether it belongs to THIS project are questions about other rows in the table,
    and every cross-row rule in this app is enforced in db/queries/projects.py where
    the rows can actually be read.
    """

    name: str = Field(min_length=1, max_length=200)
    date: Optional[ISODate] = None
    note: Optional[str] = Field(default=None, max_length=500)
    done: bool = False
    phase_id: Optional[str] = Field(default=None, max_length=64)

    @field_validator("phase_id")
    @classmethod
    def normalise_phase_id(cls, value: Optional[str]) -> Optional[str]:
        """
        Trim, and turn an empty string into a real null.

        `""` is what a `<select>` submits for its "Not tied to a phase" option. Left
        alone it is a phase id that passes a truthy check, matches no phase, and gets
        rejected downstream as a dangling reference - a 400 for what the person
        correctly answered as "none". Same argument as normalise_email below.
        """
        if value is None:
            return None
        return value.strip() or None


class MilestoneCreate(MilestoneBase):
    """Body for creating a milestone. milestone_id is generated server-side."""


class MilestoneUpdate(BaseModel):
    """
    Body for a partial milestone update. Same absent/null rule as PhaseUpdate.

    `"phase_id": null` is a real edit meaning "detach this from its phase - it
    belongs to the project", and is a different request from omitting the field,
    which leaves the attachment alone. That distinction is the whole reason this
    model exists rather than reusing MilestoneBase, and it is exactly the case a
    naive `if changes.get("phase_id")` in the queries layer would drop.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    date: Optional[ISODate] = None
    note: Optional[str] = Field(default=None, max_length=500)
    done: Optional[bool] = None
    phase_id: Optional[str] = Field(default=None, max_length=64)

    @field_validator("phase_id")
    @classmethod
    def normalise_phase_id(cls, value: Optional[str]) -> Optional[str]:
        """Empty string means detach, same as an explicit null. See MilestoneBase."""
        if value is None:
            return None
        return value.strip() or None

    def changes(self) -> dict[str, Any]:
        """Only the fields the caller actually sent. See the module docstring."""
        return self.model_dump(exclude_unset=True)


class MilestoneOut(BaseModel):
    """A milestone as returned by the API."""

    project_id: str
    milestone_id: str
    name: str
    date: Optional[ISODate] = None
    note: Optional[str] = None
    done: bool = False
    # null when it belongs to the project rather than to one of its phases.
    phase_id: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ProjectBase(BaseModel):
    """Fields common to creating and reading a project."""

    name: str = Field(min_length=1, max_length=200)
    lane_order: int = 0
    dri_email: Optional[str] = None
    support_email: Optional[str] = None
    active: bool = True

    @field_validator("dri_email", "support_email")
    @classmethod
    def normalise_email(cls, value: Optional[str]) -> Optional[str]:
        """
        Lowercase and trim, and turn an empty string into a real null.

        An empty string is what an HTML form sends for "nobody selected", and left
        alone it becomes an owner whose name is "" - present enough to pass a truthy
        check, useless to look up. Four of the nine migrated projects have no DRI, so
        this path is the common one, not the edge case.
        """
        if value is None:
            return None
        cleaned = value.strip().lower()
        return cleaned or None


class ProjectCreate(ProjectBase):
    """Body for creating a project, optionally with its phases in one call."""

    phases: list[PhaseCreate] = Field(default_factory=list)
    milestones: list[MilestoneCreate] = Field(default_factory=list)


class ProjectUpdate(BaseModel):
    """Body for a partial project update."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    lane_order: Optional[int] = None
    dri_email: Optional[str] = None
    support_email: Optional[str] = None
    active: Optional[bool] = None

    @field_validator("dri_email", "support_email")
    @classmethod
    def normalise_email(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip().lower()
        return cleaned or None

    def changes(self) -> dict[str, Any]:
        """Only the fields the caller actually sent."""
        return self.model_dump(exclude_unset=True)


class ProjectOut(ProjectBase):
    """A project as returned by the API, without its phases."""

    project_id: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ProjectDetail(ProjectOut):
    """A project with its phases in phase_order, and its milestones by date."""

    phases: list[PhaseOut] = Field(default_factory=list)
    milestones: list[MilestoneOut] = Field(default_factory=list)


class AuditOut(BaseModel):
    """One audit row."""

    entity_id: str
    timestamp: str
    action: str
    entity: str
    before: Optional[dict[str, Any]] = None
    after: Optional[dict[str, Any]] = None
    user_email: str
