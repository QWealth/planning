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

# Imported rather than restated, so the two answers a modal can send and the two a log
# row can hold are one list. app/milestone_check.py imports nothing from the app, so
# this cannot cycle - the same arrangement skills.py and work.py already have.
from app.milestone_check import ANSWERS

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


# ------------------------------------------------ the machine-to-machine progress write
#
# Used only by /api/service/phases/progress, which the Aardvark Aap Slack bot calls when
# somebody submits the progress modal. See routes/service.py for why that door exists at
# all and what it is allowed to do.


class ServiceProgressItem(BaseModel):
    """One phase's new progress."""

    project_id: str = Field(min_length=1)
    phase_id: str = Field(min_length=1)
    # Nullable on purpose, and the same 0..1 range the human PATCH uses. Null means
    # "back to not recorded", which has to stay expressible: somebody who set 40% by
    # mistake needs a way to say nobody actually knows, and 0% is a different claim.
    progress: Optional[float] = Field(default=None, ge=0.0, le=1.0)


class ServiceProgressIn(BaseModel):
    """
    A batch of progress updates, made on one person's behalf.

    `actor_email` is who the audit trail will name, and the API takes the caller's word
    for it - which is a real widening of what the service door does. /api/service/invite
    deliberately attributes to `service:<RoleName>` because it genuinely cannot know
    which Slack admin typed the command. Here the caller CAN know: the nudge is a DM to
    one person and Slack's payload names them, so recording `service:` instead would be
    throwing away a fact we hold. The trade is that a compromised bot could attribute an
    edit to anybody; the mitigation is that reaching this route at all needs both the
    IAM grant and the role allowlist.
    """

    actor_email: str = Field(min_length=3, max_length=254)
    # Capped rather than unbounded: this is one person's open phases, and the largest
    # holder on the current board has thirteen. A request carrying hundreds is a bug or
    # an abuse, and either way is better refused at the edge than written.
    updates: list[ServiceProgressItem] = Field(min_length=1, max_length=50)

    @field_validator("actor_email")
    @classmethod
    def _normalise(cls, value: str) -> str:
        """Lowercased, like every other address this API stores or compares."""
        cleaned = value.strip().lower()
        if "@" not in cleaned:
            raise ValueError("actor_email must be an email address")
        return cleaned


class ServiceProgressOut(BaseModel):
    """What actually happened, per phase rather than in aggregate."""

    actor_email: str
    updated: int
    # Named, not counted. A phase that could not be written - deleted between the DM and
    # the submit, most likely - is something the person should be told about by name,
    # because their answer to that question has just been lost.
    missing: list[str] = []


class ServiceMilestoneAnswerIn(BaseModel):
    """
    One person's answer to one day-of milestone question.

    Singular, unlike ServiceProgressIn's batch, because the message asks one question
    per milestone and each button press is one answer - see blocks.compose_milestone_check
    for why those are not batched behind a single "update all" control.

    `actor_email` is taken on the caller's word for exactly the reasons ServiceProgressIn
    sets out, and here the stakes are slightly higher: this writes somebody's NAME
    against a stated reason a deadline slipped. The mitigation is the same and is the
    only one available - reaching this route needs both the execute-api grant in
    aardvarkaap and the role allowlist in cdk.json.
    """

    actor_email: str = Field(min_length=3, max_length=254)
    project_id: str = Field(min_length=1)
    milestone_id: str = Field(min_length=1)
    # Carried from the button rather than re-read, so the log records the milestone as
    # it stood when the question was asked. See db/models.py MilestoneCheckModel.
    milestone_name: str = Field(default="", max_length=300)
    project_name: str = Field(default="", max_length=300)
    due: str = Field(min_length=10, max_length=10)
    answer: str
    # Long enough for a paragraph, capped so a paste of an entire email thread is
    # refused at the edge rather than stored. Null is a real answer - see the model.
    reason: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("actor_email")
    @classmethod
    def _normalise_actor(cls, value: str) -> str:
        """Lowercased, like every other address this API stores or compares."""
        cleaned = value.strip().lower()
        if "@" not in cleaned:
            raise ValueError("actor_email must be an email address")
        return cleaned

    @field_validator("answer")
    @classmethod
    def _known_answer(cls, value: str) -> str:
        """One of the two. A typo here would write a log row nothing can read back."""
        cleaned = value.strip().lower()
        if cleaned not in ANSWERS:
            raise ValueError(f"answer must be one of {', '.join(ANSWERS)}")
        return cleaned

    @field_validator("reason")
    @classmethod
    def _tidy_reason(cls, value: Optional[str]) -> Optional[str]:
        """Whitespace-only is nothing said, which is the same state as not answering."""
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class ServiceMilestoneAnswerOut(BaseModel):
    """What was recorded, and whether the milestone itself moved."""

    actor_email: str
    answer: str
    # False when the answer was "not yet", and also when the milestone had been deleted
    # between the DM and the button press. The log row is written either way, because
    # what somebody said is worth keeping even when there is no longer a milestone to
    # tick - which is exactly the case a reader of the log wants to see.
    milestone_marked_done: bool = False
    logged: bool = True
