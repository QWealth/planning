"""
Showing somebody the digest they would receive, without sending it.

One endpoint, and it is deliberately not a dry run of the whole job. `run_weekly_digest`
composes a message for every opted-in person, and serving that to a browser would put
one colleague's reminders in another colleague's preview - which is a privacy decision
made by accident in a feature nobody thought of as holding private data. This composes
the CALLER's digest only, from the same functions the scheduled job uses.

It exists because the alternative way to find out what this sends is to switch it on
and wait until Monday. A setting whose effect cannot be seen before it takes effect is
one people leave off.
"""

from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app import config, digest
from app.auth import require_planning_group
from app.db.queries import people as people_q, projects as projects_q

router = APIRouter(prefix="/api/digest", tags=["digest"])


class DigestPreview(BaseModel):
    """The caller's Monday message, as it stands right now."""

    week: str
    enabled: bool
    days: int
    # Empty string means nothing would be sent, which is a real answer and not an
    # error - see digest.compose_digest on why a digest with nothing in it is silence.
    digest: str = ""
    unowned_report: str = ""
    # Whether this deployment delivers at all. Without it the settings page would
    # cheerfully confirm a subscription that the master switch is discarding.
    sending_enabled: bool = False


@router.get("/preview", response_model=DigestPreview)
async def preview_digest(
    days: Optional[int] = Query(default=None),
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    What the caller would receive if the digest ran today.

    `days` overrides the stored window so the settings page can show the effect of a
    choice before it is saved. Validated against the same tuple the schema uses -
    an arbitrary window here would preview a digest nobody could ever actually get.

    Reads nothing that the caller cannot already see: their own roster row, and the
    roadmap, which is open to everyone signed in.
    """
    if days is not None and days not in digest.DIGEST_WINDOWS:
        offered = ", ".join(str(w) for w in digest.DIGEST_WINDOWS)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Pick one of {offered} days.")

    # Lowercased here because the claim is whatever Cognito holds - "Thomas@QWealth.com"
    # signs in perfectly well - while dri_email is normalised on the way out of
    # due_within. Matching the two raw would silently preview an empty digest for
    # anyone whose address is capitalised in the pool.
    email = user_email.strip().lower()
    person = people_q.get_person(email) or {}
    enabled, stored_days = digest.digest_prefs(person)
    window = days if days is not None else stored_days

    today = date.today()
    owned, unowned = digest.group_by_dri(
        digest.due_within(projects_q.list_projects(), today, window)
    )

    return {
        "week": digest.week_start(today),
        "enabled": enabled,
        "days": window,
        "digest": digest.compose_digest(person.get("name"), owned.get(email, []), window),
        "unowned_report": (
            digest.compose_admin_report(unowned, window)
            if person.get("digest_admin_report")
            else ""
        ),
        "sending_enabled": config.DIGEST_ENABLED,
    }
