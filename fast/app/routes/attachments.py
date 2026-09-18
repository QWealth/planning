"""
Files on a task: signing the upload, listing what is there, handing back a download.

THREE CALLS TO ADD ONE FILE, AND WHY IT IS NOT ONE
---------------------------------------------------
    POST   /api/tasks/{id}/attachments            -> a row, and a presigned POST
    (the browser uploads to S3 itself)
    POST   /api/tasks/{id}/attachments/{aid}/done -> the row becomes visible

The middle step does not touch this API at all, which is the whole point - see
app/storage.py for why an attachment must not travel through a Lambda. The cost is that
"upload a file" is a three-step dance the client has to get right, and the benefit is
that the size limit is S3's rather than API Gateway's 6MB.

The third call is what makes an abandoned upload invisible rather than broken. A row is
written before the bytes move, so something has to say they arrived; until it does, the
row is pending and the list route hides it. And `done` verifies with S3 rather than
believing the browser: a row flipped on the client's say-so is a download link to
nothing.

WHO MAY DO ANY OF IT
--------------------
Anybody in the planning group, which is how the rest of the task API works - the board
is editable by everybody, and a file on a task is a smaller act than deleting the task.
The uploader's address is recorded on the row, so a file is attributable even though it
is not restricted.

DOWNLOADS ARE MINTED PER CLICK, NOT EMBEDDED IN THE LIST
---------------------------------------------------------
The list route returns metadata and no URLs. A presigned URL is a capability that works
for anybody holding it until it expires, so putting one in a list response would put a
working link into every browser cache and console log that ever saw the page. The
download route signs one for five minutes at the moment somebody asks.
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from app import config, storage
from app.auth import require_planning_group
from app.db.models import AuditLogModel
from app.db.queries import audit, work as q

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tasks", tags=["attachments"])


class AttachmentOut(BaseModel):
    """
    One attachment, as the browser sees it.

    NO storage_key and NO url. The key is an internal address and the URL is a
    capability - see the module docstring. What is here is what a list needs to draw a
    row: the name, how big it is, who put it there and when.
    """

    attachment_id: str
    filename: str
    content_type: str
    size: int
    uploaded_by: Optional[str] = None
    created_at: Optional[str] = None


class AttachmentStart(BaseModel):
    """What the browser says it is about to upload."""

    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(default="application/octet-stream", max_length=255)
    # Checked here so an oversized file is refused before anything is written, and
    # again by S3 through the presigned conditions so a caller that lied is refused by
    # the thing actually receiving the bytes.
    size: int = Field(ge=0, le=config.MAX_ATTACHMENT_BYTES)

    @field_validator("filename")
    @classmethod
    def _plain_name(cls, value: str) -> str:
        """
        A name, not a path.

        The filename never becomes a storage key - storage.storage_key uses a uuid, so
        a traversal attempt has nowhere to go - but it does become a
        Content-Disposition and a line on the page, and a name with a slash in it is
        either a mistake or an attempt. Taking the last segment is what a browser's own
        file picker would have sent.
        """
        cleaned = value.replace("\\", "/").split("/")[-1].strip()
        if not cleaned:
            raise ValueError("filename must not be empty")
        return cleaned


class AttachmentStarted(BaseModel):
    """The row, plus everything the browser needs to POST the file to S3."""

    attachment: AttachmentOut
    upload_url: str
    # The form fields S3 requires alongside the file, signature included. Opaque to the
    # client, which sends them back verbatim.
    fields: dict[str, str]


class DownloadOut(BaseModel):
    """A link that works for a few minutes. See config.DOWNLOAD_URL_TTL."""

    url: str
    expires_in: int


def _task_or_404(item_id: str) -> dict[str, Any]:
    task = q.get_task(item_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such task.")
    return task


def _configured_or_501() -> None:
    """
    Refuse rather than guess when there is no bucket.

    501 rather than 500: nothing is broken, the deployment simply does not have this
    feature switched on - which is the state of every local run and the demo. A 500
    would send somebody looking for a bug.
    """
    if not storage.configured():
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "Attachments are not configured for this deployment.",
        )


@router.get("/{item_id}/attachments", response_model=list[AttachmentOut])
async def list_attachments(
    item_id: str,
    _: str = Depends(require_planning_group),
) -> list[dict[str, Any]]:
    """
    What is attached to this task, oldest first.

    Answers with an empty list rather than a 501 when attachments are unconfigured: a
    task page that renders "no files" everywhere is correct, and an error banner on
    every task in a local run would be noise about a feature nobody asked for there.
    """
    _task_or_404(item_id)
    if not storage.configured():
        return []
    return q.list_attachments(item_id)


@router.post(
    "/{item_id}/attachments",
    response_model=AttachmentStarted,
    status_code=status.HTTP_201_CREATED,
)
async def start_attachment(
    item_id: str,
    body: AttachmentStart,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """Record an attachment and hand back a presigned POST for it."""
    _task_or_404(item_id)
    _configured_or_501()

    key = storage.storage_key(item_id)
    try:
        signed = storage.upload_url(key, body.content_type, body.size)
    except storage.StorageError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e

    row = q.create_attachment(
        item_id=item_id,
        filename=body.filename,
        content_type=body.content_type,
        size=body.size,
        storage_key=key,
        uploaded_by=user_email,
    )
    logger.info("Attachment %s started on %s by %s", row["attachment_id"], item_id, user_email)
    return {"attachment": row, "upload_url": signed["url"], "fields": signed["fields"]}


@router.post("/{item_id}/attachments/{attachment_id}/done", response_model=AttachmentOut)
async def finish_attachment(
    item_id: str,
    attachment_id: str,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Mark an upload complete, having checked with S3 that it actually is.

    The HEAD is the point. The browser reporting success is the browser's word for it,
    and a row flipped on that word alone is an attachment in the list that 404s on
    click - which is worse than the upload having visibly failed.
    """
    _task_or_404(item_id)
    _configured_or_501()

    row = q.get_attachment(item_id, attachment_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such attachment.")

    if storage.head(row["storage_key"]) is None:
        # The row stays pending, so it stays invisible, and the client can retry the
        # upload against the same URL until it expires.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "That file has not arrived in storage yet.",
        )

    updated = q.mark_attachment_uploaded(item_id, attachment_id)
    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such attachment.")

    audit.record(
        action="create",
        entity=AuditLogModel.ENTITY_TASK,
        entity_id=item_id,
        after={"attachment": updated["filename"], "attachment_id": attachment_id},
        user_email=user_email,
    )
    return updated


@router.get(
    "/{item_id}/attachments/{attachment_id}/download", response_model=DownloadOut
)
async def download_attachment(
    item_id: str,
    attachment_id: str,
    _: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    A link to one file, good for a few minutes.

    A JSON link rather than a 302, so the client decides what to do with it - and so
    that a redirect chain does not carry the signed URL into a Referer header on the
    way. Forced to download rather than render; see app/storage.py.
    """
    _task_or_404(item_id)
    _configured_or_501()

    row = q.get_attachment(item_id, attachment_id)
    if row is None or not row["uploaded"]:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such attachment.")

    try:
        url = storage.download_url(row["storage_key"], row["filename"], row["content_type"])
    except storage.StorageError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    return {"url": url, "expires_in": config.DOWNLOAD_URL_TTL}


@router.delete(
    "/{item_id}/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_attachment(
    item_id: str,
    attachment_id: str,
    user_email: str = Depends(require_planning_group),
) -> None:
    """
    Remove an attachment: the row first, then the object.

    That order is deliberate - see q.delete_attachment. The bucket is versioned, so the
    file itself is recoverable by somebody with console access for a year; the row is
    not, which is why the audit entry records the filename.
    """
    _task_or_404(item_id)

    row = q.delete_attachment(item_id, attachment_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such attachment.")

    storage.delete_object(row["storage_key"])
    audit.record(
        action="delete",
        entity=AuditLogModel.ENTITY_TASK,
        entity_id=item_id,
        before={"attachment": row["filename"], "attachment_id": attachment_id},
        user_email=user_email,
    )
    logger.info("Attachment %s deleted from %s by %s", attachment_id, item_id, user_email)
