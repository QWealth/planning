"""
Request and response schemas for RFCs and tasks.

THE ABSENT/NULL DISTINCTION
---------------------------
Same as schemas/projects.py, and it matters more here rather than less. Every field
on the Update schemas is Optional and defaults to None, which would normally make
"detach this from its project" indistinguishable from "leave the project alone".
Pydantic v2 keeps the two apart in `model_fields_set`, so the routes call
`model_dump(exclude_unset=True)` and anything the caller did not mention is simply
absent from the dict.

Three fields here depend on it being right: `project_id`, `parent_id` and the dates.
Sending `parent_id: null` promotes a subtask to the top of the backlog and is an edit
somebody will make daily; not mentioning it must leave the task where it is. Get this
wrong and renaming a subtask silently rips it out of its ticket.

SEPARATE SCHEMAS PER KIND, ONE TABLE UNDERNEATH
-----------------------------------------------
An RFC and a task share a table because they share every access pattern, but they do
not share a status vocabulary or a field list, so they get their own models. A single
schema with everything optional would accept `parent_id` on an RFC and `decided_on`
on a task, and validation that permits nonsense is not validation.
"""

from datetime import date as ISODate
from typing import Any, Optional

from pydantic import BaseModel, Field

from app.work import RfcStatus, TaskStatus

# The date fields below are `decided_on` and `due`, never `date`, and the import
# above is aliased to ISODate for the same reason schemas/projects.py aliases it:
#
#     from datetime import date
#     class Thing(BaseModel):
#         date: Optional[date] = None      # <- field type is NoneType, not date
#
# Python binds the assignment before resolving the annotation, so the field accepts
# null and 422s every real date, with nothing failing at import to say so. This file
# avoids the word entirely, but the alias stays so a field added later cannot
# reintroduce it.

# Markdown bodies are capped rather than unbounded.
#
# A DynamoDB item is limited to 400KB in total, and `body` is the only field here
# that a user can grow without limit. Hitting the table's ceiling surfaces as a
# ClientError from boto3 - a 500 with a stack trace, on a save the author has every
# reason to think is reasonable. 100k characters is roughly 15,000 words, far past
# any RFC anybody will write, and it fails at the edge with a message that names the
# problem instead of failing in the driver.
MAX_BODY = 100_000


class RfcBase(BaseModel):
    """Fields common to creating and reading an RFC."""

    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=MAX_BODY)
    status: RfcStatus = RfcStatus.DRAFT
    # Nullable, and this is the point of the whole feature. "How we do code review"
    # is an RFC about no project in particular, and there is no honest project to
    # attach it to. See cdk/lib/dynamodb_stack.py for why that forced a new table.
    project_id: Optional[str] = None
    owner_email: Optional[str] = None
    decided_on: Optional[ISODate] = None


class RfcCreate(RfcBase):
    """Body for creating an RFC. item_id is generated server-side."""


class RfcUpdate(BaseModel):
    """Body for a partial RFC update."""

    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    body: Optional[str] = Field(default=None, max_length=MAX_BODY)
    status: Optional[RfcStatus] = None
    project_id: Optional[str] = None
    owner_email: Optional[str] = None
    decided_on: Optional[ISODate] = None

    def changes(self) -> dict[str, Any]:
        """Only the fields the caller actually sent. See the module docstring."""
        return self.model_dump(exclude_unset=True)


class RfcOut(BaseModel):
    """An RFC as returned by the API."""

    item_id: str
    kind: str
    title: str
    body: str = ""
    status: str
    project_id: Optional[str] = None
    owner_email: Optional[str] = None
    decided_on: Optional[ISODate] = None
    created_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class TaskBase(BaseModel):
    """
    Fields common to creating and reading a task.

    `parent_id` is the only thing separating what you would call a ticket from what
    you would call a subtask - a ticket is a task with children, a subtask is one
    with a parent, a loose to-do has neither. The one-level cap is enforced in
    db/queries/work.py rather than here, because it needs to read the proposed parent
    and this object cannot.
    """

    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=MAX_BODY)
    status: TaskStatus = TaskStatus.BACKLOG
    project_id: Optional[str] = None
    parent_id: Optional[str] = None
    owner_email: Optional[str] = None
    due: Optional[ISODate] = None
    # Defaults to 0, which sorts a new task to the TOP of the backlog above work
    # already there. The client computes and sends the next order, exactly as
    # nextLaneOrder does on the roadmap; see TaskModel for the full note.
    task_order: int = 0


class TaskCreate(TaskBase):
    """Body for creating a task. item_id is generated server-side."""


class TaskUpdate(BaseModel):
    """Body for a partial task update."""

    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    body: Optional[str] = Field(default=None, max_length=MAX_BODY)
    status: Optional[TaskStatus] = None
    project_id: Optional[str] = None
    parent_id: Optional[str] = None
    owner_email: Optional[str] = None
    due: Optional[ISODate] = None
    task_order: Optional[int] = None

    def changes(self) -> dict[str, Any]:
        """Only the fields the caller actually sent. See the module docstring."""
        return self.model_dump(exclude_unset=True)


class TaskOut(BaseModel):
    """
    A task as returned by the API.

    FLAT, with no `children` list. The board fetches every task in one call and groups
    them by parent_id on the client, so nesting them here would ship each subtask
    twice and give the two copies a chance to disagree. The one-level cap is what
    makes grouping on the client trivial enough to be the obviously right choice.
    """

    item_id: str
    kind: str
    title: str
    body: str = ""
    status: str
    project_id: Optional[str] = None
    parent_id: Optional[str] = None
    owner_email: Optional[str] = None
    due: Optional[ISODate] = None
    task_order: int = 0
    created_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class StatusOut(BaseModel):
    """
    One entry of a status vocabulary, as /api/rfcs/statuses serves it.

    `closed` means "no longer on anyone's plate" - accepted, rejected and withdrawn
    for an RFC; done and dropped for a task. It is served rather than inferred so the
    frontend does not have to keep its own copy of which values those are; see
    rfc_catalogue in app/work.py.
    """

    status: str
    label: str
    description: str
    closed: bool
