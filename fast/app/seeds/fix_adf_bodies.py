#!/usr/bin/env python3
"""
One-off: repair imported bodies already in the work table.

    python3 -m app.seeds.fix_adf_bodies
    python3 -m app.seeds.fix_adf_bodies --write

WHY THIS EXISTS AS A SEPARATE SCRIPT
------------------------------------
Both loaders now produce correct bodies, so a fresh import needs nothing. But the
imports have already run - 287 tasks and 11 RFCs - and they create rather than merge,
so re-running one would duplicate 298 rows rather than fix them. The repair is a
separate, idempotent pass over what is there.

Idempotent is the important word. Every rule below returns an already-correct body
unchanged, so this can be run twice, or after a future import, without doing anything
the second time. It reports zero changes and exits.

THE TWO DEFECTS IT FIXES
------------------------
1. ADF wrappers. Atlassian leaks `<custom data-type="mention">@Sam</custom>` into both
   Jira descriptions and Confluence bodies, and the reader escapes unknown tags rather
   than dropping them, so they were visible on screen. clean_adf unwraps them.

2. The footer separator. `text\\n---` is a setext H2 in markdown, not a paragraph
   followed by a rule - so the footer, which opened with a single newline, rendered the
   closing sentence of every imported body as a large heading and made the separator
   vanish. It also ran its own facts together into one paragraph, because consecutive
   lines are one paragraph. Both were found by rendering a real body through
   react-markdown; 393 passing tests never saw either, because they assert substrings
   and a substring survives a whitespace bug perfectly intact.

WHAT IT IS CAREFUL NOT TO DO
----------------------------
It shares clean_adf and FOOTER_RULE with the loaders rather than reimplementing them,
because two copies of a rule about rewriting somebody's text is how the two quietly
disagree. See clean_adf's docstring for why the tag rule is narrow - these documents
contain `<uuid>`, `<filename>` and whole JSX snippets that are content, not markup.

The footer fix is narrower still. It does NOT go looking for `text\\n---` in general,
because in body text that is a setext heading somebody may have meant. It only touches
a `---` immediately followed by this importer's own footer line, which no human wrote.

And it only touches rows whose created_by is one of the import actors. A body somebody
typed in the app is not this script's business, and scoping by author means the blast
radius is exactly the imports that caused the problem.
"""

import argparse
import os
import sys
from typing import Any, Callable

# Run as a module from fast/, so the app package is importable either way.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from app.seeds.atlassian import FOOTER_RULE, clean_adf  # noqa: E402
from app.seeds.load_jira_tasks import IMPORT_ACTOR as JIRA_ACTOR  # noqa: E402
from app.seeds.load_confluence_rfcs import IMPORT_ACTOR as CONFLUENCE_ACTOR  # noqa: E402
from app.db.queries import work as work_q  # noqa: E402

IMPORT_ACTORS = (JIRA_ACTOR, CONFLUENCE_ACTOR)

# The first line of each loader's footer. These are the anchors: a `---` is only
# rewritten when one of these follows it, so a setext heading in the body is safe.
FOOTER_OPENERS = ("Imported from Jira ", "Imported from Confluence page ")


def fix_footer(text: str) -> str:
    """
    Give the footer separator its blank line, and bullet its facts.

    Anchored on FOOTER_OPENERS rather than on the shape of the markup, so it cannot
    mistake a heading in somebody's document for a broken footer. Idempotent: a footer
    that already has its blank line and its bullets is not matched.
    """
    lines = text.split("\n")

    # Find the `---` that opens this importer's footer, if it is still the broken shape.
    start = None
    for i, line in enumerate(lines):
        if line.strip() != "---" or i + 1 >= len(lines):
            continue
        if any(lines[i + 1].startswith(opener) for opener in FOOTER_OPENERS):
            start = i
            break
    if start is None:
        return text

    body = "\n".join(lines[:start]).rstrip()
    facts = [line for line in lines[start + 1:] if line.strip()]
    # Already-bulleted facts keep their bullet rather than gaining a second one.
    facts = [f if f.startswith("- ") else "- %s" % f for f in facts]
    return body + FOOTER_RULE + "\n".join(facts)


# Each rule is (name, function). Order matters only in that clean_adf may shorten a
# line the footer fix then anchors on; both are idempotent either way.
RULES: list[tuple[str, Callable[[str], str]]] = [
    ("adf", clean_adf),
    ("footer", fix_footer),
]


def repair(text: str) -> tuple[str, list[str]]:
    """Apply every rule, and report which ones actually changed something."""
    applied: list[str] = []
    for name, rule in RULES:
        after = rule(text)
        if after != text:
            applied.append(name)
            text = after
    return text, applied


def plan(items: list[dict[str, Any]], actors: tuple[str, ...]) -> list[dict[str, Any]]:
    """Work out which bodies change, without changing any of them."""
    changes = []
    for item in items:
        if actors and item.get("created_by") not in actors:
            continue
        before = item.get("body") or ""
        after, applied = repair(before)
        if after != before:
            changes.append({
                "item_id": item["item_id"],
                "kind": item.get("kind") or "?",
                "title": item.get("title") or "",
                "before": before,
                "after": after,
                "applied": applied,
            })
    return changes


def summarise(changes: list[dict[str, Any]], total: int) -> None:
    print("rows examined: %d      bodies that change: %d" % (total, len(changes)))
    if not changes:
        print("\nnothing to do.")
        return

    by_rule: dict[str, int] = {}
    for change in changes:
        for name in change["applied"]:
            by_rule[name] = by_rule.get(name, 0) + 1
    print("by rule: %s" % "   ".join("%s %d" % (n, by_rule[n]) for n in sorted(by_rule)))

    print()
    for change in changes[:20]:
        print("%-16s %-4s %-14s %s" % (
            change["item_id"],
            change["kind"][:4],
            ",".join(change["applied"]),
            change["title"][:44],
        ))
    if len(changes) > 20:
        print("... and %d more" % (len(changes) - 20))

    # One worked example in full, so the transform is visible rather than trusted.
    sample = changes[0]
    print("\n--- example: %s ---" % sample["item_id"])
    print("  before |")
    for line in sample["before"].split("\n")[-6:]:
        print("         | %s" % line[:120])
    print("  after  |")
    for line in sample["after"].split("\n")[-6:]:
        print("         | %s" % line[:120])


def apply(changes: list[dict[str, Any]]) -> None:
    for done, change in enumerate(changes):
        write = work_q.update_rfc if change["kind"] == "rfc" else work_q.update_task
        updated = write(change["item_id"], {"body": change["after"]})
        if updated is None:
            # Loud rather than skipped: a row that vanished between the read and the
            # write means something else is writing, and continuing would be guessing.
            raise SystemExit(
                "%s %s no longer exists. Stopped; %d row(s) already updated."
                % (change["kind"], change["item_id"], done)
            )
    print("  updated %d row(s)" % len(changes))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="actually update DynamoDB")
    ap.add_argument(
        "--any-author",
        action="store_true",
        help="also fix bodies not created by an importer (default: importer rows only)",
    )
    args = ap.parse_args()

    items = work_q.list_tasks() + work_q.list_rfcs()
    changes = plan(items, () if args.any_author else IMPORT_ACTORS)
    summarise(changes, len(items))

    if not changes:
        return

    if not args.write:
        print("\n(dry run -- pass --write to update DynamoDB)")
        return

    print("\nupdating:")
    apply(changes)
    print("\ndone: %d body(ies) rewritten" % len(changes))


if __name__ == "__main__":
    main()
