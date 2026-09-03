#!/usr/bin/env python3
"""
Load a Jira export onto the board.

    python3 -m app.seeds.load_jira_tasks --export jira_export.json
    python3 -m app.seeds.load_jira_tasks --export jira_export.json --write

Same shape as load_roadmap.py and for the same reasons: dry run by default, a plan()
that builds exactly what would be written, and a hard stop instead of a guess when a
person cannot be resolved. The interesting output is the list of things it will not do.

WHY AN EXPORT FILE RATHER THAN A JIRA CLIENT
--------------------------------------------
This loader does not talk to Jira. The export is produced separately and handed over
as JSON, which keeps a one-time migration from acquiring a long-lived Jira credential
that would then live in the repo, in an env var, or in somebody's shell history. It
also makes the import reviewable: the file can be read before anything is written, and
the same file reproduces the same result.

EPICS ARE NOT TASKS
-------------------
Jira nests Epic -> Story -> Sub-task. The board caps nesting at ONE level, so the three
tiers cannot survive the trip intact and something has to give. Epics give.

For the QCCT lanes the epic IS the lane - "Net of Fees" the epic becomes "Net Of Fees"
the project - so importing it again as a ticket inside itself would be nonsense. For
QCON, where the lane is QWAPP and the epics are feature areas (Login, Security,
QVault), the epic name is written into the body as a breadcrumb instead. Standard
issues become tickets, sub-tasks become subtasks, and the parent/child that people
actually use is the one that survives.

The alternative - epic as ticket, story as subtask, sub-task promoted or dropped -
loses the story/sub-task link, which is the one carrying real work breakdown. This way
loses the feature-area grouping, which is recoverable from the body text.

A SUB-TASK CAN OUTLIVE ITS PARENT
---------------------------------
The export holds only work that is not Done, so an open sub-task whose story has
already shipped arrives with a parent_key that is not in the import. Those are
PROMOTED to top-level and counted in the summary. Dropping them would lose real open
work; attaching them to a parent that was never created would fail the write. Neither
is silent - the summary names them, because a ticket appearing at the top of the
backlog with no explanation is the bug this project already fixed once in delete_task.

WHY THE JIRA KEY GOES IN THE BODY
---------------------------------
There is no jira_key column, deliberately: this is a one-time port, and a field that
exists only to support a sync that was explicitly not built is a field that will be
wrong within a month. But a task with no trace of where it came from is unauditable,
so every imported body ends with the key, the URL and the original Jira status.

That last part matters more than it looks. Collapsing Jira's status vocabulary onto
five columns by statusCategory is lossy on purpose - "Blocked/Hold", "Code Review",
"Testing" and "Architecting" all land on `in-progress` - so the original name is kept
in the text. The board stays readable and the detail is still there for whoever asks
"why is this in progress".
"""

import argparse
import json
import os
import sys
from typing import Any, Optional

# Run as a module from fast/, so the app package is importable either way.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from app.work import TaskStatus  # noqa: E402
from app.seeds.atlassian import clean_adf, footer  # noqa: E402
from app.db.queries import projects as project_q, work as work_q  # noqa: E402

# Jira's statusCategory keys, which are stable across projects and workflows. The
# per-project status NAMES are not - every board renames them - so the category is the
# only thing worth mapping on. `done` is here for completeness; the export is filtered
# to open work, so a row carrying it means the filter did not hold and the summary
# should say so rather than quietly file it under Done.
CATEGORY_TO_STATUS: dict[str, str] = {
    "new": TaskStatus.BACKLOG.value,
    "indeterminate": TaskStatus.IN_PROGRESS.value,
    "done": TaskStatus.DONE.value,
}

IMPORT_ACTOR = "jira-import"


def resolve_projects(lanes: list[dict[str, Any]]) -> tuple[dict[str, str], list[str]]:
    """
    Map each lane's app_project NAME to a live project_id.

    By name, not by id, because the ids in the export would be meaningless here: every
    environment minted its own when the workbook was loaded, so a dev id written into
    a prod row points at nothing. The name is the thing a human agreed on.
    """
    live = {p["name"]: p["project_id"] for p in project_q.list_projects(include_inactive=True)}

    resolved: dict[str, str] = {}
    missing: list[str] = []
    for lane in lanes:
        name = lane["app_project"]
        if name in live:
            resolved[name] = live[name]
        else:
            missing.append(name)
    return resolved, missing


def provenance(issue: dict[str, Any], site: str) -> str:
    """
    The footer every imported body carries. See the module docstring.

    The whitespace is load-bearing and not obviously so. `text\\n---` is a setext H2 in
    markdown, not a paragraph followed by a rule, so a footer opening with a single
    newline renders the last sentence of the description as a heading and swallows the
    separator. Hence the blank line, and hence FOOTER_RULE being shared with the
    Confluence loader rather than typed twice.

    The facts are a bullet list for a related reason: consecutive lines are one
    paragraph in markdown, so as plain lines the whole footer ran together into a
    single unreadable sentence. Both measured against a real react-markdown render.
    """
    facts = ["Imported from Jira %s (%s)" % (issue["key"], issue["url"])]
    if issue.get("status"):
        facts.append("Jira status at import: %s" % issue["status"])
    if issue.get("epic_name"):
        facts.append("Jira epic: %s (%s)" % (issue["epic_name"], issue.get("epic_key") or "?"))
    if issue.get("assignee_name") and not issue.get("assignee_email"):
        # Recorded rather than dropped: the name is the only handle on who owns this,
        # and owner_email is being left null because guessing an address is worse.
        facts.append("Jira assignee (unmapped): %s" % issue["assignee_name"])
    return footer(facts)


def plan(export: dict[str, Any], resolved: dict[str, str]) -> dict[str, Any]:
    """Build exactly what would be written, without writing it."""
    site = export.get("site", "jira")
    top_level: list[dict[str, Any]] = []
    subtasks: list[dict[str, Any]] = []
    skipped_epics: list[str] = []
    promoted: list[str] = []
    unexpected_done: list[str] = []
    unmapped_owners: dict[str, list[str]] = {}

    for lane in export["lanes"]:
        project_id = resolved[lane["app_project"]]
        issues = lane["issues"]

        # An epic is the lane or a breadcrumb, never a row. Collected first so the
        # keys are known before anything is attached to one.
        epics = {i["key"] for i in issues if i["issuetype"] == "Epic"}
        skipped_epics.extend(sorted(epics))

        importable = [i for i in issues if i["issuetype"] != "Epic"]
        keys = {i["key"] for i in importable}

        for order, issue in enumerate(importable):
            status = CATEGORY_TO_STATUS.get(issue["status_category"])
            if status is None:
                raise SystemExit(
                    "unknown statusCategory %r on %s. Expected one of %s."
                    % (issue["status_category"], issue["key"], sorted(CATEGORY_TO_STATUS))
                )
            if issue["status_category"] == "done":
                unexpected_done.append(issue["key"])

            if issue.get("assignee_name") and not issue.get("assignee_email"):
                unmapped_owners.setdefault(issue["assignee_name"], []).append(issue["key"])

            body = clean_adf(issue.get("description") or "").rstrip()
            row = {
                "jira_key": issue["key"],
                "title": issue["summary"].strip(),
                "body": body + provenance(issue, site),
                "status": status,
                "project_id": project_id,
                "owner_email": issue.get("assignee_email"),
                "due": issue.get("duedate"),
                "task_order": order,
                "lane": lane["app_project"],
                "parent_key": None,
            }

            parent_key = issue.get("parent_key")
            # A sub-task whose parent is an epic is really a top-level ticket: the epic
            # is not being imported, so there is nothing above it.
            is_child = bool(issue["is_subtask"]) and parent_key is not None
            if is_child and parent_key in epics:
                is_child = False
            if is_child and parent_key not in keys:
                # Parent already Done, so absent from the export. Promote, and say so.
                promoted.append("%s (parent %s)" % (issue["key"], parent_key))
                is_child = False

            if is_child:
                row["parent_key"] = parent_key
                subtasks.append(row)
            else:
                top_level.append(row)

    return {
        "top_level": top_level,
        "subtasks": subtasks,
        "skipped_epics": skipped_epics,
        "promoted": promoted,
        "unexpected_done": unexpected_done,
        "unmapped_owners": unmapped_owners,
    }


def summarise(written: dict[str, Any]) -> None:
    """Print what is about to happen, gaps and all."""
    rows = written["top_level"] + written["subtasks"]
    print("tickets %d   subtasks %d   total %d   (epics skipped: %d)" % (
        len(written["top_level"]), len(written["subtasks"]), len(rows),
        len(written["skipped_epics"]),
    ))
    print()

    print("%-24s %8s %9s %9s %8s" % ("LANE", "TICKETS", "SUBTASKS", "BACKLOG", "ACTIVE"))
    for lane in sorted({r["lane"] for r in rows}):
        in_lane = [r for r in rows if r["lane"] == lane]
        print("%-24s %8d %9d %9d %8d" % (
            lane[:24],
            len([r for r in in_lane if r["parent_key"] is None]),
            len([r for r in in_lane if r["parent_key"] is not None]),
            len([r for r in in_lane if r["status"] == TaskStatus.BACKLOG.value]),
            len([r for r in in_lane if r["status"] == TaskStatus.IN_PROGRESS.value]),
        ))

    owned = len([r for r in rows if r["owner_email"]])
    dated = len([r for r in rows if r["due"]])
    print("\nwith an owner: %d of %d      with a due date: %d of %d"
          % (owned, len(rows), dated, len(rows)))

    if written["promoted"]:
        print("\npromoted to top-level, parent already closed and so not in the export:")
        for line in written["promoted"]:
            print("  %s" % line)

    if written["unexpected_done"]:
        print("\nCLOSED work in an export that should hold only open work (%d): %s"
              % (len(written["unexpected_done"]), ", ".join(written["unexpected_done"][:10])))

    if written["unmapped_owners"]:
        print("\nno email from Jira for these assignees:")
        for name in sorted(written["unmapped_owners"]):
            keys = written["unmapped_owners"][name]
            print("  %-24s %d issue(s): %s" % (name, len(keys), ", ".join(keys[:6])))


def load(written: dict[str, Any]) -> None:
    """
    Write it. Tickets first, so a subtask has a real parent_id to point at.

    create_task refuses a parent that is itself a subtask, which is exactly the check
    that makes this order mandatory rather than merely tidy.
    """
    ids: dict[str, str] = {}

    for row in written["top_level"]:
        created = work_q.create_task({
            "title": row["title"],
            "body": row["body"],
            "status": row["status"],
            "project_id": row["project_id"],
            "parent_id": None,
            "owner_email": row["owner_email"],
            "due": row["due"],
            "task_order": row["task_order"],
            "created_by": IMPORT_ACTOR,
        })
        ids[row["jira_key"]] = created["item_id"]
        print("  + %-12s %s" % (row["jira_key"], created["item_id"]))

    for row in written["subtasks"]:
        parent_id = ids.get(row["parent_key"])
        if parent_id is None:
            # Unreachable if plan() did its job; loud rather than skipped, because a
            # silently dropped subtask is invisible open work.
            raise SystemExit(
                "no imported parent for %s (wanted %s). Nothing further written."
                % (row["jira_key"], row["parent_key"])
            )
        created = work_q.create_task({
            "title": row["title"],
            "body": row["body"],
            "status": row["status"],
            "project_id": row["project_id"],
            "parent_id": parent_id,
            "owner_email": row["owner_email"],
            "due": row["due"],
            "task_order": row["task_order"],
            "created_by": IMPORT_ACTOR,
        })
        ids[row["jira_key"]] = created["item_id"]
        print("  + %-12s %s  under %s" % (row["jira_key"], created["item_id"], row["parent_key"]))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", required=True, help="jira_export.json")
    ap.add_argument("--write", action="store_true", help="actually write to DynamoDB")
    ap.add_argument(
        "--allow-unmapped",
        action="store_true",
        help="store an assignee with no Jira email as null instead of stopping",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="import even though the board already holds tasks (will duplicate)",
    )
    args = ap.parse_args()

    with open(args.export) as fh:
        export = json.load(fh)

    resolved, missing = resolve_projects(export["lanes"])
    if missing:
        raise SystemExit(
            "no project named: %s\n"
            "Live projects: %s\n"
            "Rename the lane in the export or add the project first. Not creating one: a "
            "project invented here would arrive with no phases and no dates and would "
            "draw as an empty lane on the roadmap."
            % (
                ", ".join(missing),
                ", ".join(sorted(p["name"] for p in project_q.list_projects(include_inactive=True))),
            )
        )

    written = plan(export, resolved)

    if written["unmapped_owners"] and not args.allow_unmapped:
        raise SystemExit(
            "Jira gave no email address for: %s\n"
            "Pass --allow-unmapped to import these with no owner - the name is kept in "
            "the task body either way.\n"
            "Not guessing: first.last@qwealth.com is a plausible-looking wrong answer, "
            "and a task owned by an address nobody reads is worse than one owned by "
            "nobody."
            % ", ".join(sorted(written["unmapped_owners"]))
        )

    summarise(written)

    if not args.write:
        print("\n(dry run -- pass --write to load into DynamoDB)")
        return

    # Refuse to import on top of existing tasks, for the same reason load_roadmap
    # refuses to seed on top of existing projects: create_task always mints a new id,
    # so a second run does not update the first - it doubles the board, and the only
    # way back is deleting a few hundred rows by hand.
    existing = work_q.list_tasks()
    if existing and not args.force:
        raise SystemExit(
            "refusing to import: %d task(s) already on the board. This loader creates, "
            "it does not merge, so running it again would duplicate every one of them. "
            "Pass --force if you have already cleared them."
            % len(existing)
        )

    print()
    load(written)
    print("\nimported.")


if __name__ == "__main__":
    main()
