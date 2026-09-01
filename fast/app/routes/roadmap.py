"""The whole roadmap in one request.

There used to be a `/gaps` endpoint here - a live data-quality report listing every
undecided field, which the UI showed in a "Still to decide" side panel. Both were
removed as clutter. The same analysis still exists in migrate/extract_workbook.py,
which runs it once against the .xlsx rather than on every request against live data.

Worth knowing if it is ever wanted back: the reason it existed is that Excel rendered
a missing date, a #REF! and a relative day offset identically - as either nothing or a
bar in January 1900 - so the sheet could be wrong in ways nobody could see. That
argument was about the workbook, and this app does not have the problem: unscheduled
is a state the chart renders as such rather than an absence it has to infer.
"""

from typing import Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.auth import require_planning_group
from app.db.queries import people as people_q, projects as project_q
from app.schemas.people import PersonOut
from app.schemas.projects import ProjectDetail

router = APIRouter(prefix="/api/roadmap", tags=["roadmap"])


class RoadmapOut(BaseModel):
    """Everything the roadmap screen needs to draw itself."""

    projects: list[ProjectDetail] = Field(default_factory=list)
    people: list[PersonOut] = Field(default_factory=list)
    # The overall span, or None when nothing at all is scheduled. None rather than
    # today's date: an empty roadmap should render as empty, not as a one-day chart
    # centred on now, which looks like data.
    span_start: Optional[str] = None
    span_end: Optional[str] = None


@router.get("", response_model=RoadmapOut)
async def get_roadmap(
    include_inactive: bool = False,
    user_email: str = Depends(require_planning_group),
) -> dict[str, Any]:
    """
    Projects, phases and the roster in one round trip.

    One request rather than three because the roadmap cannot be drawn from any
    subset of them: the lanes need the projects, the bars need the phases, and every
    owner cell needs the roster to turn an email into a name. Fetching them
    separately would make the screen render in three stages, with owner names
    appearing last and the timeline reflowing as each arrives.
    """
    projects = project_q.list_projects(include_inactive=include_inactive)
    roster = people_q.list_people(include_inactive=True)

    # Inactive people are included on purpose: a departed person may still be the
    # recorded owner of a past phase, and dropping them would render that owner as
    # a bare email address, or blank.

    # Milestone dates widen the span as well as phase dates. A regulatory deadline
    # three months past the last phase is exactly the thing that must not fall off
    # the right-hand edge of the chart - it is the reason it was recorded.
    dates = [
        value
        for project in projects
        for phase in project["phases"]
        for value in (phase["start"], phase["end"])
        if value
    ] + [
        milestone["date"]
        for project in projects
        for milestone in project["milestones"]
        if milestone["date"]
    ]

    return {
        "projects": projects,
        "people": roster,
        "span_start": min(dates) if dates else None,
        "span_end": max(dates) if dates else None,
    }

