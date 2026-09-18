"""
Presigned URLs for task attachments. The only module that talks to S3.

NOTHING IS UPLOADED OR DOWNLOADED THROUGH THIS API
---------------------------------------------------
The browser talks to S3 directly, with a URL this module signs. Two reasons, and the
second is the one that decided it:

  1. A Lambda behind API Gateway has a 6MB request and response limit, so an upload
     through the API is capped at 6MB no matter what the bucket allows, and a download
     through it reads the whole object into memory to hand it straight back out.
  2. Signing is cheap and streaming is not. An attachment moving through Lambda is
     billed Lambda time to be a pipe, at a concurrency limit shared with every other
     request the roadmap serves.

WHAT A PRESIGNED URL ACTUALLY IS
--------------------------------
The signer's own permissions, in a link, for a fixed window. That is worth stating
plainly because it sets the whole security model for this feature: the URL is the
capability, so anybody holding it has it, whether or not they can sign in. Hence short
expiries (config.UPLOAD_URL_TTL, DOWNLOAD_URL_TTL), one object per URL, and a download
URL that is minted on the click rather than embedded in a list and forwarded.

It also means the Lambda role must genuinely hold what the URL grants - a role that
cannot PUT signs URLs that 403 on use, with an error that says nothing about roles.

EVERY DOWNLOAD IS AN ATTACHMENT, NEVER INLINE
----------------------------------------------
`download_url` forces Content-Disposition: attachment. Without it, an uploaded .html or
.svg opens as a page in the viewer's browser with whatever script it contains. The
bucket is on its own amazonaws.com origin so that is not our cookies at risk, but it is
still our roadmap handing somebody a page that runs, and "it was only internal" is how
that becomes an incident. The type is preserved for the filename and nothing else.
"""

import logging
import uuid
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from app import config

logger = logging.getLogger(__name__)

_client = None


class StorageError(RuntimeError):
    """S3 refused, or is not configured for this deployment."""


def _s3():
    """
    The client, built once.

    Signature v4 explicitly: the default in some regions is still v2, and a v2 URL
    against a bucket created with SSE and enforce_ssl fails with SignatureDoesNotMatch,
    which reads as a credentials problem and is not.
    """
    global _client
    if _client is None:
        from botocore.client import Config as BotoConfig

        _client = boto3.client(
            "s3",
            region_name=config.AWS_REGION,
            config=BotoConfig(signature_version="s3v4"),
        )
    return _client


def configured() -> bool:
    """Whether this deployment has a bucket at all. False locally and in the demo."""
    return bool(config.ATTACHMENTS_BUCKET)


def _require_bucket() -> str:
    if not configured():
        raise StorageError(
            "Attachments are not configured for this deployment: no ATTACHMENTS_BUCKET."
        )
    return config.ATTACHMENTS_BUCKET


def storage_key(item_id: str) -> str:
    """
    Where an object lives: `work/<item_id>/<uuid>`.

    A uuid rather than the filename, because two people uploading `notes.pdf` to the
    same task must not collide, and because a filename is caller-controlled text that
    would otherwise become a key - `../` and all. The real name is on the metadata row
    and is put back on the way out, in the Content-Disposition.

    Prefixed by the item so that everything belonging to one task shares a prefix, which
    is what makes a future "delete the task, delete its files" a prefix delete rather
    than a scan.
    """
    return f"work/{item_id}/{uuid.uuid4().hex}"


def upload_url(key: str, content_type: str, size: int) -> dict[str, Any]:
    """
    A presigned POST the browser can upload one object with.

    POST rather than PUT, and the difference matters: a presigned POST carries
    CONDITIONS that S3 enforces, so the size limit is checked by S3 on arrival. A PUT
    URL cannot express that - the caller could send a gigabyte to a URL signed for a
    kilobyte and S3 would take it.

    The exact content type is pinned too, so the URL cannot be reused to upload
    something else to the same key.
    """
    bucket = _require_bucket()
    try:
        return _s3().generate_presigned_post(
            Bucket=bucket,
            Key=key,
            Fields={"Content-Type": content_type},
            Conditions=[
                {"Content-Type": content_type},
                # Nought to the cap, inclusive. Stated as a range rather than a maximum
                # because S3 requires both ends.
                ["content-length-range", 0, config.MAX_ATTACHMENT_BYTES],
            ],
            ExpiresIn=config.UPLOAD_URL_TTL,
        )
    except ClientError as e:
        logger.error("Could not sign an upload for %s: %s", key, e)
        raise StorageError("Could not prepare the upload.") from e


def download_url(key: str, filename: str, content_type: str) -> str:
    """
    A short-lived link to one object, forced to download rather than render.

    See the module docstring for why Content-Disposition is not optional here.
    """
    bucket = _require_bucket()
    # Quotes and backslashes would end the header value early; a filename is
    # caller-supplied text and this is the one place it reaches a header.
    safe = filename.replace('"', "").replace("\\", "")
    try:
        return _s3().generate_presigned_url(
            "get_object",
            Params={
                "Bucket": bucket,
                "Key": key,
                "ResponseContentDisposition": f'attachment; filename="{safe}"',
                "ResponseContentType": content_type,
            },
            ExpiresIn=config.DOWNLOAD_URL_TTL,
        )
    except ClientError as e:
        logger.error("Could not sign a download for %s: %s", key, e)
        raise StorageError("Could not prepare the download.") from e


def delete_object(key: str) -> None:
    """
    Remove one object. Swallows a miss.

    Called after the metadata row is already gone, so raising here would report a
    failure for a delete the reader has already seen succeed - and the object it could
    not remove is now unreferenced, which the bucket's lifecycle rules are there for.
    """
    if not configured():
        return
    try:
        _s3().delete_object(Bucket=config.ATTACHMENTS_BUCKET, Key=key)
    except ClientError as e:
        logger.error("Could not delete %s, leaving it orphaned: %s", key, e)


def head(key: str) -> Optional[dict[str, Any]]:
    """
    What S3 actually has at this key, or None.

    Used to confirm an upload really landed before the row is marked uploaded - the
    browser saying it finished is the browser's word for it, and a row flipped on that
    word alone is a download link to nothing.
    """
    if not configured():
        return None
    try:
        return _s3().head_object(Bucket=config.ATTACHMENTS_BUCKET, Key=key)
    except ClientError:
        return None
