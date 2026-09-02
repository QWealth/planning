"""Request and response schemas for the roster."""

from typing import Any, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    field_validator,
    model_validator,
)

from app.roles import Role
from app.skills import MAX_STARS, MIN_STARS, Skill


class SkillOut(BaseModel):
    """One entry of the specialisation vocabulary, for the picker."""

    skill: str
    label: str
    description: str


class RoleOut(BaseModel):
    """One entry of the role vocabulary, for the picker."""

    role: str
    label: str
    description: str


def _dedupe_roles(values: list[Role]) -> list[Role]:
    """
    Reject a role listed twice, and refuse an empty list.

    Empty is refused here rather than with `min_length=1` so the message says what to
    do. It applies on create *and* on a patch that sends the field: "no roles" is not
    a state the API lets you reach deliberately, even though it is a state legacy rows
    are already in. Absence still means "leave it alone" - see PersonUpdate.changes().
    """
    if not values:
        raise ValueError("pick at least one role")
    seen: set[str] = set()
    for role in values:
        if role in seen:
            raise ValueError(f"{role.value} is listed more than once")
        seen.add(role)
    return values


class SpecialisationIn(BaseModel):
    """
    One skill somebody holds, or wants to, as accepted from a caller.

    Two fields rather than one four-valued level - see the module docstring in
    app/skills.py for why. `stars` is capability today; `wants_to_learn` is appetite,
    and neither implies the other.
    """

    # The one model in this file that refuses unknown fields, and the reason is the
    # field this one replaced. A browser left open on the pre-stars bundle still posts
    # `{"skill": ..., "level": "primary"}`; ignored, that stores the person at the
    # default two stars and silently demotes a rating they set themselves, with a 200
    # and a form that looks saved. Refused, they get an error, reload, and see the new
    # control. Reads still understand `level` - see PersonModel._specialisations - but
    # a write is the one moment the old shape can do damage.
    model_config = ConfigDict(extra="forbid")

    skill: Skill
    # Defaults to two, not three. Omitting the rating must not silently make somebody
    # the obvious person to ask - that is a claim about them they did not make, and it
    # is the one that gets acted on when work is being handed out.
    stars: int = Field(default=2, ge=MIN_STARS, le=MAX_STARS)
    wants_to_learn: bool = False

    @model_validator(mode="after")
    def must_say_something(self) -> "SpecialisationIn":
        """
        Refuse an entry that records neither ability nor interest.

        Zero stars and no appetite is the same statement as having no entry at all,
        and storing it would put a row on the person that reads as "asked, answered
        no" while the absence of a row reads as "never asked" - a distinction this
        app does not keep and should not appear to. The form clears the entry instead
        of sending this, so reaching it means a caller hand-rolled the request.
        """
        if self.stars == MIN_STARS and not self.wants_to_learn:
            raise ValueError(
                f"{self.skill.value}: give it at least one star, or tick wants to learn"
            )
        return self


class SpecialisationOut(BaseModel):
    """
    One skill somebody holds, as returned.

    `skill` is a plain string here, not the enum, for the same reason PersonOut.email
    is not EmailStr: a row written before a skill was renamed - or hand-edited in the
    console - must not take down the whole roster response. Enums validate on the way
    in, where a bad value can still be refused with a reason.

    `stars` is unbounded here for the same reason, and deliberately carries no ge/le.
    A hand-edited 7 should render as an odd-looking row, not 500 the endpoint;
    PersonModel._specialisations clamps it on the way through anyway, which is the
    right place because that is the layer that already knows about malformed items.
    """

    skill: str
    stars: int = 0
    wants_to_learn: bool = False


def _dedupe(values: list[SpecialisationIn]) -> list[SpecialisationIn]:
    """
    Reject a skill listed twice.

    Silently keeping the last would make "front-end primary, front-end secondary"
    depend on form field order, and the person would flip between being the obvious
    choice and merely able to cover depending on how the UI happened to serialise.
    """
    seen: set[str] = set()
    for entry in values:
        if entry.skill in seen:
            raise ValueError(f"{entry.skill.value} is listed more than once")
        seen.add(entry.skill)
    return values


class PersonBase(BaseModel):
    """Fields common to creating and reading a person."""

    email: EmailStr
    name: str = Field(min_length=1, max_length=120)
    # No default. Required, so adding yourself without saying what you do is a 422 and
    # not a blank cell somebody has to chase later - which is how the workbook's Team
    # sheet ended up unreadable. See app/roles.py.
    roles: list[Role]
    active: bool = True
    specialisations: list[SpecialisationIn] = Field(default_factory=list)

    @field_validator("specialisations")
    @classmethod
    def no_duplicate_skills(cls, value: list[SpecialisationIn]) -> list[SpecialisationIn]:
        return _dedupe(value)

    @field_validator("roles")
    @classmethod
    def check_roles(cls, value: list[Role]) -> list[Role]:
        return _dedupe_roles(value)

    @field_validator("email")
    @classmethod
    def normalise(cls, value: Optional[str]) -> Optional[str]:
        """
        Lowercase, because this is a partition key.

        DynamoDB keys are case-sensitive and Cognito is not, so "Joe@qwealth.com"
        from a form and "joe@qwealth.com" from a token would be two different people
        with the same mailbox - and only one of them would ever match the logged-in
        user. Normalising at the edge is the only place this can be fixed once.
        """
        return value.strip().lower() if value else None


class PersonCreate(PersonBase):
    """Body for creating a person."""


class InviteIn(BaseModel):
    """
    Body for inviting someone: an address, and nothing else.

    Pointedly not a PersonCreate. An invite grants a login; it does not put anyone on
    the roster, so there is no name to type and no roles to guess at. The invited
    person supplies both themselves at onboarding, which is the only way those fields
    are ever accurate - PersonBase requires roles precisely so nobody ends up as a
    blank row somebody else has to chase.
    """

    email: EmailStr

    # Who to DM the instructions to, when the address came from the Slack picker.
    #
    # Optional, and the address is still the identity: this is only a delivery route.
    # It is a Slack user id rather than a second address precisely so the two cannot
    # disagree - the picker supplies both from ONE chosen person, and anything else
    # (a typed address, an import) simply leaves this empty and gets the copy-paste
    # message back instead. See app/invites.py.
    slack_user_id: Optional[str] = Field(default=None, max_length=32)

    @field_validator("email")
    @classmethod
    def normalise(cls, value: str) -> str:
        """Lowercased, for the same reason PersonBase does it - and for Cognito."""
        return value.strip().lower()

    @field_validator("slack_user_id")
    @classmethod
    def blank_is_absent(cls, value: Optional[str]) -> Optional[str]:
        """
        "" means "no Slack user", not "a Slack user whose id is empty".

        A form that clears the picker sends an empty string rather than omitting the
        field, and without this the DM would be attempted against an empty channel and
        fail with Slack's unhelpful `channel_not_found`.
        """
        value = (value or "").strip()
        return value or None


class InviteOut(BaseModel):
    """
    What an invite actually did.

    Two booleans rather than a 201/200 distinction, because there are three outcomes
    worth telling the admin apart and HTTP has no status that says "they already had
    an account, and now they can use this app too":

        created + group   - a brand new colleague; Cognito has emailed them.
        group only        - they had a compliance-tool login already, which is the
                            usual case, and no email goes out. Somebody has to tell
                            them, so the UI has to know.
        neither           - nothing to do. They already had access.

    `onboarded` is whether they already have a roster row, so the UI can say whether
    to expect them to appear on the Team page now or only once they have signed in.

    `message` is the text to actually send them, composed server-side so the Team page
    and the Slack bot cannot drift into two differently-worded invitations - see
    app/invites.py for why that matters more than it looks. Callers render it; they do
    not build their own.

    `dm_sent` says whether we already delivered that text over Slack. It is the
    difference between "done" and "now go and tell them", and the UI must show the
    message when it is False - an account nobody was told about is worse than no
    account, because it silently consumes an invitation email that reads like
    phishing. `dm_error` carries why, when we tried and could not.
    """

    email: str
    account_created: bool
    group_added: bool
    onboarded: bool
    message: str
    dm_sent: bool = False
    dm_error: Optional[str] = None


class PersonUpdate(BaseModel):
    """Body for a partial person update. email is the key and cannot change here."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    roles: Optional[list[Role]] = None
    active: Optional[bool] = None
    specialisations: Optional[list[SpecialisationIn]] = None

    @field_validator("roles")
    @classmethod
    def check_roles(cls, value: Optional[list[Role]]) -> Optional[list[Role]]:
        return _dedupe_roles(value) if value is not None else None

    @field_validator("specialisations")
    @classmethod
    def no_duplicate_skills(
        cls, value: Optional[list[SpecialisationIn]]
    ) -> Optional[list[SpecialisationIn]]:
        return _dedupe(value) if value is not None else None

    def changes(self) -> dict[str, Any]:
        """
        Only the fields the caller actually sent. See schemas/projects.py.

        `mode="json"` matters: specialisations holds Skill/SkillLevel enum members and
        roles holds Role members, and boto3 cannot serialise an Enum. Without it a
        skill edit fails deep in botocore with a type error naming neither the field
        nor the person.

        Both lists are replaced, not merged. They are sets, and a PATCH that merged
        them could only ever add - removing one would need a second verb the API does
        not have, so "I no longer do UX" would be unexpressible.
        """
        return self.model_dump(exclude_unset=True, mode="json")


class PersonOut(BaseModel):
    """
    A person as returned by the API.

    email is a plain str here, NOT EmailStr, and that asymmetry is deliberate.

    Validation belongs on the way in, where a bad address can still be rejected and
    the caller told why. On the way out it is actively harmful: EmailStr on a
    response model means one malformed row in the table - a hand-edited item, a
    migration that predates the check, an address in a form nobody anticipated -
    raises ResponseValidationError and takes down the *entire* list response. The
    whole roadmap goes 500 because of one person.

    Found the hard way: seeding the local demo with @example.invalid addresses (an
    RFC 2606 reserved TLD that email-validator refuses) made GET /api/roadmap return
    "Internal server error" with nine perfectly good projects in the table.

    Same reasoning as the from_item defaults in db/models.py: one bad record should
    degrade to one odd-looking row, never to a dead endpoint.
    """

    email: str
    name: str
    # Plain str, not Role, and defaulting to empty - both for the reason above. Every
    # person seeded from the workbook has no roles recorded and must still render.
    roles: list[str] = Field(default_factory=list)
    active: bool = True
    specialisations: list[SpecialisationOut] = Field(default_factory=list)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class PersonWorkload(PersonOut):
    """
    A person plus what they own.

    Exists because the first question asked of the workbook's Team sheet was "who is
    overloaded", and answering it meant reading nine lanes by eye. Four people on the
    roster (Ha, Janine, Artem, Meherzad) currently own nothing at all, which is only
    visible when ownership is aggregated per person rather than per project.
    """

    dri_project_ids: list[str] = Field(default_factory=list)
    support_project_ids: list[str] = Field(default_factory=list)
    owned_phase_count: int = 0


class UnassignedProject(BaseModel):
    """One lane a deleted person was named on."""

    project_id: str
    project_name: str


class UnassignedPhase(UnassignedProject):
    """One phase a deleted person owned. Carries the lane so it can be found again."""

    phase_id: str
    phase_name: str


class Unassigned(BaseModel):
    """
    What a delete cleared, split by the role it was cleared from.

    Three lists rather than one, because the three mean different things to whoever
    has to repair the schedule: a lane with no DRI is unowned, a lane with no Support
    has a bus factor of one, and an unowned phase is work nobody is doing. Flattening
    them to a count would say "cleared 7 assignments" and leave the reader no better
    off than before they asked.
    """

    dri: list[UnassignedProject] = Field(default_factory=list)
    support: list[UnassignedProject] = Field(default_factory=list)
    phases: list[UnassignedPhase] = Field(default_factory=list)


class PersonDeleted(BaseModel):
    """
    The receipt for a hard delete.

    Name as well as email because the caller is about to show this to a human, and by
    the time it arrives there is no row left to look the name up in.
    """

    email: str
    name: str
    unassigned: Unassigned
