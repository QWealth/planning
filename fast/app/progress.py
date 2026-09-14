"""
Choosing who gets asked about which phase, for the Monday/Wednesday progress nudge.

Pure, like digest.py next door and for the same reason: deciding who is asked about
what is the interesting part and it should be testable with three dicts rather than
two mocked AWS services. Sending lives in notifications.py; drawing lives in blocks.py.

WHY THIS IS PHASES AND NOT PROJECTS
-----------------------------------
"Update the progress on your projects" is how everybody says it, and there is no field
to write it into. `progress` lives on the PHASE. A project's number is a mean that
laneVerdict computes on the fly and deliberately refuses to compute when phases have no
progress recorded - so a project-level percentage would be a second, disagreeing source
of truth the moment anybody stored one. The message therefore groups BY project and
asks ABOUT phases, which is also the number people actually track: "Coding 45%" is a
thing somebody knows, "DocuTelligence 62%" is an average nobody can act on.

WHO GETS ASKED: THE OWNER, ELSE THE DRI
---------------------------------------
A fallback, not a union. Asking the phase's owner is the right question - they are
doing the work - but `owner_email` is recorded on fewer than half the phases, and
owner-only scoping measured against the live board leaves 30 of 58 open phases with
nobody asked at all. That is the failure that matters here: the nudge would run twice a
week, skip most of the board, and leave the numbers looking maintained because SOME of
them were being updated.

So where nobody owns a phase, its project's DRI is asked instead. Measured on the same
board that reaches 54 of 58. A union would reach the same phases and ask two people
about several of them, which invites two answers to one question.

A phase with neither an owner nor a project DRI is asked about by nobody, and that is
correct rather than a gap to paper over - there is no honest person to send it to. The
Thursday report names them so the omission is visible.

WHAT COUNTS AS OPEN
-------------------
Not structural, and progress is not exactly 1. Both halves matter:

  * Structural phases are Maintenance bands: ongoing support with no dates and no end.
    Asking "how far through Maintenance are you" is a question with no answer, and it
    would appear in every message forever.
  * `progress is None` IS open. "Nobody has recorded this" is precisely the state the
    nudge exists to fix, so treating unknown as done would skip exactly the phases most
    in need of an answer. from_item keeps 0.0 and None apart for this reason; so does
    this module.
"""

from typing import Any, Iterable, Optional

# What a phase must reach to stop being asked about. Exact, not >= 0.999: progress is
# stored as a Decimal from a fixed set of steps, so there is no float drift to absorb,
# and a phase at 99% is one somebody should still be asked to finish.
COMPLETE = 1.0


def _clean(value: Any) -> Optional[str]:
    """An address, lowercased and trimmed, or None. Emails compare case-insensitively."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip().lower()
    return cleaned or None


def is_open(phase: dict[str, Any]) -> bool:
    """Whether this phase is something to ask about. See the module docstring."""
    if phase.get("structural"):
        return False
    return phase.get("progress") != COMPLETE


def asker_for(phase: dict[str, Any], project: dict[str, Any]) -> tuple[Optional[str], str]:
    """
    Who to ask about this phase, and on what grounds.

    Returns (address, basis) where basis is "owner", "dri" or "nobody". The basis is
    returned rather than inferred by the caller because the message says it out loud -
    somebody asked about a phase they do not own deserves to know it reached them
    because they are DRI of the lane.
    """
    owner = _clean(phase.get("owner_email"))
    if owner:
        return owner, "owner"
    dri = _clean(project.get("dri_email"))
    if dri:
        return dri, "dri"
    return None, "nobody"


def open_phases(projects: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Every open phase across the roadmap, flattened, with its asker resolved.

    Takes the projects whole, exactly as due_within does: list_projects already returns
    each project with its phases nested, so this needs no second read and no per-project
    fan-out.

    Inactive projects are skipped. A lane somebody retired is not work anybody should be
    chased about, and it is off the roadmap they would check.
    """
    rows: list[dict[str, Any]] = []

    for project in projects:
        if project.get("active") is False:
            continue
        for phase in project.get("phases") or []:
            if not is_open(phase):
                continue
            asker, basis = asker_for(phase, project)
            rows.append(
                {
                    "project_id": project.get("project_id"),
                    "project_name": project.get("name") or "Untitled project",
                    "phase_id": phase.get("phase_id"),
                    "phase_name": phase.get("name") or "Untitled phase",
                    "progress": phase.get("progress"),
                    "asker": asker,
                    "basis": basis,
                }
            )

    return rows


def group_by_asker(rows: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """
    Rows -> {address: {"projects": {project_name: [rows]}, "count": n}}.

    Grouped two levels deep because the message is: one section per project, the
    person's phases listed under it. Doing that grouping here rather than in blocks.py
    keeps the drawing code free of decisions and means the shape can be asserted in a
    test without parsing Block Kit JSON.

    Insertion order is preserved at both levels, so the roadmap's own project order
    survives into the message rather than being alphabetised by a dict rebuild.
    """
    out: dict[str, dict[str, Any]] = {}

    for row in rows:
        asker = row.get("asker")
        if not asker:
            continue
        person = out.setdefault(asker, {"projects": {}, "count": 0})
        person["projects"].setdefault(row["project_name"], []).append(row)
        person["count"] += 1

    return out


def unasked(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Open phases nobody will be asked about: no owner, and no DRI on the project.

    Surfaced rather than dropped. These are the phases the nudge cannot reach, so a run
    that quietly skipped them would report a healthy-looking "asked everybody" while
    part of the board went unchased - which is the same silence the admin unowned-report
    exists to break for milestones.
    """
    return [row for row in rows if not row.get("asker")]
