#!/usr/bin/env python3
"""
Load a Confluence export into the RFC table.

    python3 -m app.seeds.load_confluence_rfcs --export /tmp/confluence_rfcs
    python3 -m app.seeds.load_confluence_rfcs --export /tmp/confluence_rfcs --write

Third loader in the same shape as load_roadmap.py and load_jira_tasks.py, for the same
reasons: dry run by default, a plan() that builds exactly what would be written, and a
hard stop instead of a guess whenever the source is silent. The interesting output is
still the list of things it refuses to do.

WHY THE EXPORT IS A DIRECTORY AND NOT ONE JSON FILE
---------------------------------------------------
load_jira_tasks takes a single file because a Jira issue is a row: a summary, a status,
a handful of ids. An RFC is a document, and the document is the entire point of
importing it. Fifteen markdown bodies inside JSON string fields is an export nobody can
read - every code fence, every backslash and every newline goes behind an escape, and a
body that got mangled in transit looks exactly like a body that was always like that.

So: `index.json` holds the metadata, and each body sits beside it as `<pageId>.md`,
byte for byte as Confluence returned it. The export can be read, diffed and eyeballed
before anything is written, which is the only real defence against a silent corruption
of text that is about to become a permanent record.

STATUS: WHAT CONFLUENCE SAYS, OR NOTHING
----------------------------------------
The house convention in space QA is a header block at the top of the body - `Status:`,
`Author:`, `Version:`, `Created:`, `Last Updated:`. Where a `Status:` is stated it is
mapped, and an unrecognised value is a hard stop that names it rather than a shrug onto
`draft`.

Where there is no header block at all - the older design docs have none - the row lands
on `draft` because that is the schema default, and every one of them is listed in the
summary under "no status stated". That listing is not decoration. A 2023 document
describing a system that shipped is arguably `accepted`, and inferring that from its age
or its confident tone would be a real judgement dressed up as a data migration. The
loader declines to make it; the footer records that Confluence stated no status; and
changing five statuses in the UI afterwards takes a minute.

There is deliberately no mapping for `Superseded`. It is a status people write in
Confluence and it has no home here - work.py explains why there is no `superseded` enum
value - and quietly filing it under `withdrawn` would assert that an author pulled a
proposal when in fact the team replaced it. Unknown status, hard stop, human decides.

DECIDED_ON IS ALWAYS NULL
-------------------------
No exceptions, including for a page that says `Status: Accepted`. Confluence records
when a page was last edited, which is not when a decision was made, and the two differ
by however long it took someone to tidy the wording afterwards. `decided_on` drives a
date on the reader, so a fabricated one is a fact on screen that nobody typed.

WHY THE PAGE ID GOES IN THE BODY
--------------------------------
Same argument as the Jira key: there is no confluence_page_id column, because this is a
one-time port and a field supporting a sync that was explicitly not built will be wrong
within the month. But every imported body ends with the page id, the URL, the stated
author, and the stated status - so an RFC here can always be traced back to the page it
came from, and to whatever that page claimed about itself at the moment it was read.

WHY project_id IS A TABLE AND NOT A MATCH
-----------------------------------------
PAGE_PROJECT below is keyed by page id and written out by hand. Matching titles against
lane names would work for most of them and put the rest on the wrong project, and an
RFC filed under the wrong project is worse than one filed under none: the whole reason
`project_id` is nullable is that "how we do code review" belongs to no project. A page
absent from the table imports with no project, which is a first-class answer here.

NOT EVERY PAGE IN THE EXPORT IS AN RFC
--------------------------------------
The export holds every page in the space that looked like a candidate, on purpose - if
the filtering happened at export time the decision would be buried in a subagent's
summary and there would be nothing to argue with. So four of the fifteen are excluded
here, in SKIP_PAGES, each with the sentence from the page that decided it.

The test applied to all fifteen was the same one: does the page PROPOSE a change and
ask for a decision, or does it DESCRIBE something that already exists? An audit, an
execution plan, a conventions guide and a description of shipped behaviour are all
useful documents and none of them is a decision record. An RFC list that contains them
stops answering "what did we decide and why", which is the only thing it is for.

Length was explicitly not the test. Two short and one visibly unfinished page are
imported, with the reasoning recorded next to the skip list.

OWNERS: FOUR REAL ONES, AND NO GUESSES
--------------------------------------
Confluence hands over a display name and no address. AUTHOR_EMAIL maps the handful of
names that genuinely resolve to an account in this app, and main() checks every address
in it against the people table before anything is written, so a typo there stops the
import instead of producing an RFC owned by an address nobody reads. Every other author
keeps their display name in the footer and the row keeps `owner_email` null, which is
the honest representation of what the source actually told us.
"""

import argparse
import json
import os
import re
import sys
from typing import Any, Optional

# Run as a module from fast/, so the app package is importable either way.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from app.work import RfcStatus  # noqa: E402
from app.schemas.work import MAX_BODY  # noqa: E402
from app.seeds.atlassian import clean_adf, footer  # noqa: E402
from app.db.queries import people as people_q, projects as project_q, work as work_q  # noqa: E402

# Keyed on the lowercased, stripped `Status:` value from the body header block. Only
# `Draft` and `Request for Comments` actually appear in the QA space today; the rest are
# here because they are the obvious next things somebody will type, and a hard stop on
# `Accepted` would be an annoying way to find that out.
#
# Nothing maps onto WITHDRAWN on purpose. See the module docstring.
STATUS_MAP: dict[str, str] = {
    "draft": RfcStatus.DRAFT.value,
    "wip": RfcStatus.DRAFT.value,
    "work in progress": RfcStatus.DRAFT.value,
    "request for comments": RfcStatus.REVIEW.value,
    "rfc": RfcStatus.REVIEW.value,
    "in review": RfcStatus.REVIEW.value,
    "review": RfcStatus.REVIEW.value,
    "under review": RfcStatus.REVIEW.value,
    "accepted": RfcStatus.ACCEPTED.value,
    "approved": RfcStatus.ACCEPTED.value,
    "rejected": RfcStatus.REJECTED.value,
    "declined": RfcStatus.REJECTED.value,
}

# What a page is about, decided by a human reading it, not by a title match.
PAGE_PROJECT: dict[str, str] = {
    "1764360194": "DocuTelligence",       # Local AI queueing + OCR pipeline
    "1746894849": "Enhanced Data Delivery",  # EDD RFC v2
    "1734541313": "Enhanced Data Delivery",  # EDD v1, superseded by the above
    "1744568321": "DocuTelligence",       # OCR field validation + bulk upload
    "1741193217": "Net Worth",            # Net Worth Statement v1
    "1750433793": "Net Worth",            # Net Worth early wireframe field mappings
    "1022984193": "D2",                   # Docusign2Data design doc
}

# Pages in the export that are NOT proposals, and why each one was read that way.
#
# The export deliberately holds everything that looked like a candidate, because the
# alternative - deciding at export time - hides the decision inside a subagent's
# summary. The judgement belongs here, in the repo, next to its reasoning, where
# somebody who disagrees can see exactly what was excluded and argue with it.
#
# The test applied to each: does it PROPOSE a change and seek a decision, or does it
# DESCRIBE something that already exists? An RFC table full of reference material stops
# being a decision record, which is the whole reason not to import these.
SKIP_PAGES: dict[str, str] = {
    "1750433793":
        "self-declared audit - 'This document is an audit' - and explicitly defers "
        "every proposed fix to companion page 1754464257. Also duplicates the 11 "
        "screen tables in 1741193217, which IS imported.",
    "1669791751":
        "execution plan, not a proposal: phases, file changes, how to test. The "
        "decision it implements is section 2 of 1669070850, which IS imported.",
    "1669431302":
        "conventions guide - 'This document describes the target file structure... New "
        "features should follow this pattern'. Prescribes, does not propose.",
    "966262801":
        "documents shipped behaviour (Current Implementation, and a how-to for adding "
        "the check to a page). Reference, not a decision being sought.",
}

# Deliberately NOT skipped, though a first pass flagged them as borderline:
#   1633583105 (Using triggers) - short, but it is exactly a decision record: the
#     problem ('The .active tax'), the choice ('push it to the database'), and the
#     rationale ('Why triggers for active flag cascading'). Length is not the test.
#   1579843585 (Distributed Cron Logging) - visibly unfinished, with a '(I UNNO??? )'
#     left in the schema. But it has Summary, Motivation, Advantages AND Disadvantages,
#     so it is an RFC that stalled, and `draft` says so honestly. An abandoned proposal
#     is part of the record; deleting it loses the fact that anybody considered it.
#   1734541313 (EDD v1) - a real RFC that v2 replaced. There is no `superseded` status
#     (see app/work.py), so it imports as draft; retiring it is a one-click change in
#     the UI and not something to guess at here.

# Display name in Confluence -> a real address, for authors who genuinely resolve to an
# account in this app. Checked against the people table in main(), which is the point:
# an address invented from a display name is the exact failure mode load_roadmap warned
# about, so the roster gets to veto anything written here.
AUTHOR_EMAIL: dict[str, str] = {
    "thomas kosciuch": "thomas@qwealth.com",
}

# A human's call on a page whose own status is genuinely ambiguous, keyed by page id.
#
# It lives in code, next to the reason, rather than being patched into index.json.
# Editing the export until the loader stops complaining would work and would leave no
# trace of the fact that anybody decided anything; this way the judgement is reviewable
# and the export stays a faithful copy of what Confluence actually said.
#
# 1764360194 carries TWO status lozenges side by side - "REQUEST FOR COMMENTS" and
# "Draft" - so the page contradicts itself. Read as review: the author put "request for
# comments" first and is circulating v2 for feedback, which is exactly what the app's
# `review` means ("Open for comment. Waiting on the team."). Both original lozenges
# survive in the body text, so a reader can disagree.
PAGE_STATUS: dict[str, str] = {
    "1764360194": RfcStatus.REVIEW.value,
}

# The QA space files pages as "(2026-08) Some Title". The prefix is a filing convention,
# not part of the decision's name, and a list sorted by title reads badly when every
# entry starts with a bracket. Stripped here, and the untouched original goes in the
# footer, so nothing is lost and the change is reversible by reading the row.
TITLE_PREFIX = re.compile(r"^\(\s*(\d{4})-(\d{2})\s*\)\s*")

IMPORT_ACTOR = "confluence-import"


def check_author_roster(author_email: Optional[dict[str, str]] = None) -> None:
    """
    Refuse to run if any address in AUTHOR_EMAIL is not on the people roster.

    AUTHOR_EMAIL is hand-written, and a hand-written address is one typo away from an
    RFC owned by nobody who can be emailed. That failure has no symptom: the row looks
    answered. The people table is the only authority on who is real, so it gets to veto
    - which is what makes writing an owner here defensible at all.
    """
    author_email = AUTHOR_EMAIL if author_email is None else author_email
    for name, email in sorted(author_email.items()):
        if people_q.get_person(email) is None:
            raise SystemExit(
                "AUTHOR_EMAIL maps %r to %s, which is not on the people roster.\n"
                "Roster: %s\n"
                "Either the address is wrong or that person has not been added yet. Not "
                "writing it: an owner_email pointing at no account is worse than null, "
                "because null is visibly missing and this would look answered."
                % (
                    name,
                    email,
                    ", ".join(sorted(p["email"] for p in people_q.list_people(True))) or "empty",
                )
            )


def resolve_projects(page_project: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """
    Map each project NAME used by PAGE_PROJECT to a live project_id.

    By name for the same reason load_jira_tasks resolves by name: the ids differ per
    environment, so an id written down here points at nothing in prod. The name is the
    thing a human agreed on.
    """
    live = {p["name"]: p["project_id"] for p in project_q.list_projects(include_inactive=True)}

    resolved: dict[str, str] = {}
    missing: list[str] = []
    for name in sorted(set(page_project.values())):
        if name in live:
            resolved[name] = live[name]
        else:
            missing.append(name)
    return resolved, missing


def clean_title(title: str) -> tuple[str, Optional[str]]:
    """
    Strip the `(YYYY-MM)` filing prefix. Returns the title and the month it carried.

    The month is returned rather than discarded because it is the only date on some of
    these pages that means anything, and it goes into the footer.
    """
    match = TITLE_PREFIX.match(title)
    if not match:
        return title.strip(), None
    return TITLE_PREFIX.sub("", title).strip(), "%s-%s" % (match.group(1), match.group(2))


def provenance(page: dict[str, Any], site: str, filed: Optional[str]) -> str:
    """
    The footer every imported body carries. See the module docstring, and see footer()
    in seeds/atlassian.py for why its whitespace is not cosmetic.
    """
    facts = [
        "Imported from Confluence page %s (%s)" % (page["page_id"], page["url"]),
        "Original title: %s" % page["title"],
    ]
    if filed:
        facts.append("Filed in Confluence under: %s" % filed)
    if page.get("author_name"):
        # The author's display name. It is recorded whether or not AUTHOR_EMAIL turned
        # it into an owner, because the name is what the source actually said.
        facts.append("Confluence author: %s" % page["author_name"])
    if page.get("confluence_status"):
        facts.append("Confluence status at import: %s" % page["confluence_status"])
    else:
        facts.append("Confluence stated no status at import.")
    if page.get("version_label"):
        facts.append("Confluence version: %s" % page["version_label"])
    if page.get("stated_updated"):
        facts.append("Last updated per the page: %s" % page["stated_updated"])
    elif page.get("last_modified"):
        facts.append("Last modified in Confluence: %s" % page["last_modified"])
    return footer(facts)


def read_bodies(export_dir: str, pages: list[dict[str, Any]]) -> dict[str, str]:
    """
    Load each body off disk and check it against the length the exporter recorded.

    The check is the point. A body silently truncated somewhere between Confluence and
    here reads as a document that was simply never finished, and there is no later
    moment at which anyone would notice.
    """
    bodies: dict[str, str] = {}
    for page in pages:
        path = os.path.join(export_dir, page["body_file"])
        with open(path, encoding="utf-8") as fh:
            text = fh.read()

        recorded = page.get("body_chars")
        if recorded is not None and len(text) != recorded:
            raise SystemExit(
                "%s is %d characters but the export recorded %d.\n"
                "Refusing to import a body that changed on the way here."
                % (path, len(text), recorded)
            )
        bodies[page["page_id"]] = text
    return bodies


def plan(
    export: dict[str, Any],
    bodies: dict[str, str],
    resolved: dict[str, str],
    skip: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """
    Build exactly what would be written, without writing it.

    `skip` defaults to SKIP_PAGES and is a parameter only so that main() can hand back
    a page the caller named explicitly - see --only.
    """
    site = export.get("site", "confluence")
    skip = SKIP_PAGES if skip is None else skip
    rows: list[dict[str, Any]] = []
    no_status: list[str] = []
    overridden: list[str] = []
    owned: dict[str, list[str]] = {}
    unmapped_authors: dict[str, list[str]] = {}
    no_project: list[str] = []
    empty_bodies: list[str] = []
    skipped: list[dict[str, str]] = []

    for page in export["pages"]:
        page_id = page["page_id"]

        if page_id in skip:
            # Not a proposal. Recorded rather than dropped quietly, so the summary
            # shows what was left behind and why - an exclusion nobody can see is
            # indistinguishable from an export that missed the page.
            skipped.append({
                "page_id": page_id,
                "title": page["title"],
                "reason": skip[page_id],
            })
            continue

        stated = (page.get("confluence_status") or "").strip().lower()
        if page_id in PAGE_STATUS:
            # A recorded human call on a self-contradicting page. Listed in the
            # summary, because a status nobody can trace back to the source is the
            # thing this whole loader is trying not to produce.
            status = PAGE_STATUS[page_id]
            overridden.append("%s -> %s (page said %r)"
                              % (page_id, status, page.get("confluence_status")))
        elif stated:
            status = STATUS_MAP.get(stated)
            if status is None:
                raise SystemExit(
                    "unknown Confluence status %r on page %s (%s).\n"
                    "Known: %s\n"
                    "Add it to STATUS_MAP only if the mapping is honest. 'Superseded' is "
                    "the one that looks easy and is not - see the module docstring."
                    % (page.get("confluence_status"), page_id, page["title"],
                       ", ".join(sorted(STATUS_MAP)))
                )
        else:
            # No header block on the page at all. Default, and say so out loud.
            status = RfcStatus.DRAFT.value
            no_status.append(page_id)

        title, filed = clean_title(page["title"])

        project_name = PAGE_PROJECT.get(page_id)
        project_id = None
        if project_name:
            if project_name not in resolved:
                # main() resolves before calling plan(), so this means plan() was
                # called directly. Named rather than a bare KeyError, because the
                # KeyError says "DocuTelligence" and nothing about why.
                raise SystemExit(
                    "page %s is filed under project %r, which was not resolved to an id.\n"
                    "Resolved: %s\n"
                    "Call resolve_projects() first, or take the page out of PAGE_PROJECT."
                    % (page_id, project_name, sorted(resolved) or "nothing")
                )
            project_id = resolved[project_name]
        else:
            no_project.append(page_id)

        # An author only becomes an owner if AUTHOR_EMAIL says so, and main() has
        # already made the people table agree. Everyone else stays unowned; the display
        # name is in the footer, which is the honest version of what Confluence gave us.
        author = page.get("author_name") or ""
        owner_email = AUTHOR_EMAIL.get(author.strip().lower())
        if owner_email:
            owned.setdefault(owner_email, []).append(page_id)
        elif author:
            unmapped_authors.setdefault(author, []).append(page_id)

        body = clean_adf(bodies[page_id]).rstrip()
        if not body:
            empty_bodies.append(page_id)
        body = body + provenance(page, site, filed)

        if len(body) > MAX_BODY:
            raise SystemExit(
                "page %s (%s) is %d characters, over the %d limit.\n"
                "Not truncating: half an RFC is worse than a link to a whole one. Split "
                "the page in Confluence, or raise MAX_BODY in app/schemas/work.py if the "
                "limit is genuinely the wrong number."
                % (page_id, page["title"], len(body), MAX_BODY)
            )

        rows.append({
            "page_id": page_id,
            "title": title,
            "body": body,
            "status": status,
            "project_id": project_id,
            "project_name": project_name,
            "owner_email": owner_email,
            "decided_on": None,
            "author_name": page.get("author_name"),
        })

    return {
        "rows": rows,
        "no_status": no_status,
        "overridden": overridden,
        "owned": owned,
        "unmapped_authors": unmapped_authors,
        "no_project": no_project,
        "empty_bodies": empty_bodies,
        "skipped": skipped,
    }


def summarise(written: dict[str, Any]) -> None:
    """Print what is about to happen, gaps and all."""
    rows = written["rows"]
    print("RFCs to import: %d" % len(rows))
    print()

    print("%-8s %-42s %-9s %-22s %s" % ("PAGE", "TITLE", "STATUS", "PROJECT", "OWNER"))
    for row in rows:
        print("%-8s %-42s %-9s %-22s %s" % (
            row["page_id"][-8:],
            row["title"][:42],
            row["status"],
            (row["project_name"] or "-")[:22],
            row["owner_email"] or "-",
        ))

    by_status: dict[str, int] = {}
    for row in rows:
        by_status[row["status"]] = by_status.get(row["status"], 0) + 1
    print("\nby status: %s" % "   ".join(
        "%s %d" % (s, by_status[s]) for s in sorted(by_status)
    ))
    print("body size: min %d   median %d   max %d characters" % _body_spread(rows))

    if written["overridden"]:
        print("\nstatus set by hand because the page contradicts itself (%d):"
              % len(written["overridden"]))
        for line in written["overridden"]:
            print("  %s" % line)

    if written["no_status"]:
        print("\nno status stated on the page, defaulted to draft (%d): %s"
              % (len(written["no_status"]), ", ".join(written["no_status"])))

    if written["no_project"]:
        print("\nimporting with no project, which is a real answer for an RFC (%d): %s"
              % (len(written["no_project"]), ", ".join(written["no_project"])))

    if written["empty_bodies"]:
        print("\nEMPTY body, only a footer will be written (%d): %s"
              % (len(written["empty_bodies"]), ", ".join(written["empty_bodies"])))

    if written["owned"]:
        print("\nowner set from AUTHOR_EMAIL, checked against the people table (%d):"
              % len(written["owned"]))
        for email in sorted(written["owned"]):
            pages = written["owned"][email]
            print("  %-30s %d page(s): %s" % (email, len(pages), ", ".join(pages)))

    if written["unmapped_authors"]:
        print("\nConfluence gives a display name and no address, so owner_email stays null:")
        for name in sorted(written["unmapped_authors"]):
            pages = written["unmapped_authors"][name]
            print("  %-24s %d page(s)" % (name, len(pages)))

    if written["skipped"]:
        print("\nNOT imported - read and judged not to be a proposal (%d):"
              % len(written["skipped"]))
        for item in written["skipped"]:
            print("  %s  %s" % (item["page_id"], item["title"][:60]))
            print("      %s" % item["reason"])


def _body_spread(rows: list[dict[str, Any]]) -> tuple[int, int, int]:
    """min, median and max body length - a cheap check that nothing arrived empty."""
    if not rows:
        return (0, 0, 0)
    sizes = sorted(len(r["body"]) for r in rows)
    return (sizes[0], sizes[len(sizes) // 2], sizes[-1])


def load(written: dict[str, Any]) -> None:
    """Write it. No ordering constraint here - an RFC has no parent."""
    for row in written["rows"]:
        created = work_q.create_rfc({
            "title": row["title"],
            "body": row["body"],
            "status": row["status"],
            "project_id": row["project_id"],
            "owner_email": row["owner_email"],
            "decided_on": row["decided_on"],
            "created_by": IMPORT_ACTOR,
        })
        print("  + %-12s %s  %s" % (row["page_id"], created["item_id"], row["title"][:40]))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", required=True, help="directory holding index.json and <pageId>.md")
    ap.add_argument("--write", action="store_true", help="actually write to DynamoDB")
    ap.add_argument(
        "--allow-unmapped",
        action="store_true",
        help="import with owner_email null instead of stopping on an unresolved author",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="import even though the table already holds RFCs (will duplicate)",
    )
    ap.add_argument(
        "--only",
        default=None,
        help="comma-separated page ids: import just these, ignore the rest of the index "
             "(naming a page in SKIP_PAGES imports it anyway - see below)",
    )
    args = ap.parse_args()

    check_author_roster()

    with open(os.path.join(args.export, "index.json")) as fh:
        export = json.load(fh)

    if export.get("failed"):
        raise SystemExit(
            "the export records %d page(s) it could not read: %s\n"
            "Fix the export first. Importing a partial set is fine, but it should be a "
            "decision, not a leftover - use --only to say so explicitly."
            % (len(export["failed"]), ", ".join(f["page_id"] for f in export["failed"]))
        )

    skip = dict(SKIP_PAGES)

    if args.only:
        wanted = {p.strip() for p in args.only.split(",") if p.strip()}
        known = {p["page_id"] for p in export["pages"]}
        unknown = wanted - known
        if unknown:
            raise SystemExit("--only names pages not in the export: %s" % ", ".join(sorted(unknown)))
        export["pages"] = [p for p in export["pages"] if p["page_id"] in wanted]

        # Naming a page by id is a human asking for that page. SKIP_PAGES is a default
        # judgement, not a lock, and silently importing nothing because the one page you
        # asked for is on a list you cannot see from the command line would be the worst
        # of both. Overriding is announced.
        for page_id in sorted(wanted & set(skip)):
            print("--only names %s, which SKIP_PAGES excludes (%s). Importing it anyway."
                  % (page_id, skip[page_id]))
            del skip[page_id]

    if not export["pages"]:
        raise SystemExit("nothing to import: the export holds no pages")

    bodies = read_bodies(args.export, export["pages"])

    importing = {p["page_id"] for p in export["pages"]} - set(skip)
    needed = {pid: name for pid, name in PAGE_PROJECT.items() if pid in importing}
    resolved, missing = resolve_projects(needed)
    if missing:
        raise SystemExit(
            "no project named: %s\n"
            "Live projects: %s\n"
            "Fix PAGE_PROJECT in this file, or add the project first. Not creating one, "
            "and not falling back to no project either: filing an RFC under nothing "
            "because a name was misspelled hides the misspelling."
            % (
                ", ".join(missing),
                ", ".join(sorted(p["name"] for p in project_q.list_projects(include_inactive=True))),
            )
        )

    written = plan(export, bodies, resolved, skip)

    if not written["rows"]:
        raise SystemExit(
            "nothing left to import: every page in the export is in SKIP_PAGES.\n"
            "Use --only <pageId> if you meant to import one of them anyway."
        )

    if written["unmapped_authors"] and not args.allow_unmapped:
        raise SystemExit(
            "Confluence gives no email address for: %s\n"
            "Pass --allow-unmapped to import these with no owner - the display name is "
            "kept in the RFC body either way.\n"
            "Not guessing: first.last@qwealth.com is a plausible-looking wrong answer, "
            "and an RFC owned by an address nobody reads is worse than one owned by "
            "nobody."
            % ", ".join(sorted(written["unmapped_authors"]))
        )

    summarise(written)

    if not args.write:
        print("\n(dry run -- pass --write to load into DynamoDB)")
        return

    # Refuse to import on top of a previous run of THIS loader. create_rfc always mints
    # a new id, so a second run does not update the first - it doubles the table, and
    # telling the two copies of a 36,000-character document apart afterwards means
    # reading both.
    #
    # Scoped to created_by, not to "the table is non-empty". An RFC somebody wrote in
    # the app is not evidence that the import already ran, and blocking on it would
    # push the operator towards --force, which turns off the check that matters.
    existing = work_q.list_rfcs()
    already_imported = [r for r in existing if r.get("created_by") == IMPORT_ACTOR]
    if already_imported and not args.force:
        raise SystemExit(
            "\nrefusing to import: %d RFC(s) already carry created_by=%s, so this "
            "import has run before. It creates rather than merges, so running it again "
            "would duplicate every one of them. Pass --force if that is genuinely what "
            "you want."
            % (len(already_imported), IMPORT_ACTOR)
        )
    if existing:
        print("\nnote: %d RFC(s) already in the table, none from this importer. Leaving "
              "them alone." % len(existing))

    print("\nwriting:")
    load(written)
    print("\ndone: %d RFC(s)" % len(written["rows"]))


if __name__ == "__main__":
    main()
