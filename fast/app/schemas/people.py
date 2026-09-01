"""Request and response schemas for the roster."""

from typing import Any, Optional

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.roles import Role
from app.skills import Skill, SkillLevel


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
    """One skill somebody holds, as accepted from a caller."""

    skill: Skill
    level: SkillLevel = SkillLevel.SECONDARY


class SpecialisationOut(BaseModel):
    """
    One skill somebody holds, as returned.

    `skill` and `level` are plain strings here, not the enums, for the same reason
    PersonOut.email is not EmailStr: a row written before a skill was renamed - or
    hand-edited in the console - must not take down the whole roster response. Enums
    validate on the way in, where a bad value can still be refused with a reason.
    """

    skill: str
    level: str = SkillLevel.SECONDARY.value


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
