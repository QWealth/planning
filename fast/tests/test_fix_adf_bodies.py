"""
Tests for the one-off body repair.

This script rewrites text that is already a permanent record - 287 imported tasks and
11 imported RFCs - so the interesting assertions are the ones about restraint: that it
leaves a setext heading in somebody's document alone, that it does not touch a body a
human typed in the app, and that running it twice does nothing the second time.

The footer bug it fixes was invisible to 393 passing tests, because they all asserted
substrings and a substring survives a whitespace bug intact. So these look at shape.
"""

import pytest

from app.seeds import fix_adf_bodies as fixer
from app.seeds.atlassian import footer


BROKEN = "The closing sentence.\n---\nImported from Jira A-1 (https://x/A-1)\nJira status at import: Code Review"
FIXED = "The closing sentence." + footer([
    "Imported from Jira A-1 (https://x/A-1)",
    "Jira status at import: Code Review",
])


class TestFixFooter:
    def test_the_separator_gains_its_blank_line(self):
        assert "The closing sentence.\n\n---\n" in fixer.fix_footer(BROKEN)

    def test_the_last_sentence_stops_being_a_heading(self):
        """The whole bug: one newline short and that line renders as an <h2>."""
        assert "sentence.\n---" not in fixer.fix_footer(BROKEN)

    def test_the_facts_become_bullets(self):
        out = fixer.fix_footer(BROKEN)
        assert "- Imported from Jira A-1 (https://x/A-1)" in out
        assert "- Jira status at import: Code Review" in out

    def test_the_repaired_body_matches_what_the_loader_now_produces(self):
        """
        The point of the repair: a fixed row should be indistinguishable from one
        imported today. If these two drift, the table holds two shapes of the same
        thing and nobody can tell which pass wrote a given row.
        """
        assert fixer.fix_footer(BROKEN) == FIXED

    def test_it_is_idempotent(self):
        once = fixer.fix_footer(BROKEN)
        assert fixer.fix_footer(once) == once

    def test_an_already_correct_footer_is_untouched(self):
        assert fixer.fix_footer(FIXED) == FIXED

    def test_the_confluence_footer_is_recognised_too(self):
        broken = "Body text.\n---\nImported from Confluence page 123 (https://x)\nOriginal title: A Proposal"
        out = fixer.fix_footer(broken)
        assert "Body text.\n\n---\n" in out
        assert "- Original title: A Proposal" in out

    def test_the_body_above_the_footer_is_preserved_exactly(self):
        body = "# Heading\n\nSome *markdown*.\n\n```py\nx = 1\n```\n\n| a | b |\n| - | - |\n\nEnd."
        out = fixer.fix_footer(body + "\n---\nImported from Jira A-1 (https://x)")
        assert out.startswith(body)

    def test_a_body_with_no_footer_is_returned_unchanged(self):
        for text in ["", "Just a body.", "# Heading\n\ntext", "A\n---\nB"]:
            assert fixer.fix_footer(text) == text


class TestWhatTheFooterFixMustNotTouch:
    """
    `text\\n---` is a legitimate setext H2 in markdown. Rewriting every instance would
    silently restructure documents that were correct, which is why the fix is anchored
    on the importer's own footer line and nothing else.
    """

    def test_a_setext_heading_in_the_body_is_left_alone(self):
        text = "Motivation\n---\nWe need this because of the thing.\n\nMore text."
        assert fixer.fix_footer(text) == text

    def test_a_setext_heading_is_still_safe_when_a_real_footer_follows(self):
        """The heading stays a heading; only the footer's own rule is rewritten."""
        text = ("Motivation\n---\nBecause of the thing.\n\nDone."
                "\n---\nImported from Jira A-1 (https://x)")
        out = fixer.fix_footer(text)
        assert "Motivation\n---\nBecause" in out
        assert "Done.\n\n---\n- Imported from Jira A-1 (https://x)" in out

    def test_a_horizontal_rule_the_author_wrote_is_left_alone(self):
        text = "One section.\n\n---\n\nAnother section."
        assert fixer.fix_footer(text) == text

    def test_a_line_merely_mentioning_the_footer_wording_is_not_a_footer(self):
        text = "We should say Imported from Jira somewhere in the body."
        assert fixer.fix_footer(text) == text


class TestRepair:
    def test_both_defects_are_fixed_in_one_pass(self):
        source = ('Owner <custom data-type="mention" data-id="a">@Sam</custom> agreed.'
                  "\n---\nImported from Jira A-1 (https://x)")
        after, applied = fixer.repair(source)
        assert sorted(applied) == ["adf", "footer"]
        assert "custom" not in after
        assert "Owner @Sam agreed.\n\n---\n- Imported from Jira A-1 (https://x)" == after

    def test_a_clean_body_reports_no_rules_applied(self):
        after, applied = fixer.repair(FIXED)
        assert applied == []
        assert after == FIXED

    def test_repair_is_idempotent(self):
        once, _ = fixer.repair('a <custom data-type="mention" data-id="q">@Sam</custom> b'
                               "\n---\nImported from Jira A-1 (https://x)")
        twice, applied = fixer.repair(once)
        assert twice == once
        assert applied == []


class TestPlan:
    def item(self, item_id="tsk_1", kind="task", body="", created_by="jira-import"):
        return {"item_id": item_id, "kind": kind, "body": body,
                "title": "a title", "created_by": created_by}

    def test_a_broken_imported_row_is_planned_for_repair(self):
        changes = fixer.plan([self.item(body=BROKEN)], fixer.IMPORT_ACTORS)
        assert len(changes) == 1
        assert changes[0]["after"] == FIXED
        assert changes[0]["applied"] == ["footer"]

    def test_a_clean_row_is_not_planned(self):
        assert fixer.plan([self.item(body=FIXED)], fixer.IMPORT_ACTORS) == []

    def test_a_body_a_human_typed_is_never_touched(self):
        """
        The blast radius is exactly the imports that caused the problem. Somebody's
        own RFC, with their own setext headings, is not this script's business.
        """
        hand = self.item(item_id="rfc_1", kind="rfc", body=BROKEN,
                         created_by="thomas@qwealth.com")
        assert fixer.plan([hand], fixer.IMPORT_ACTORS) == []

    def test_any_author_widens_it_deliberately(self):
        hand = self.item(body=BROKEN, created_by="thomas@qwealth.com")
        assert len(fixer.plan([hand], ())) == 1

    def test_both_import_actors_are_in_scope(self):
        items = [
            self.item(item_id="tsk_1", body=BROKEN, created_by="jira-import"),
            self.item(item_id="rfc_1", kind="rfc", body=BROKEN, created_by="confluence-import"),
        ]
        changes = fixer.plan(items, fixer.IMPORT_ACTORS)
        assert sorted(c["item_id"] for c in changes) == ["rfc_1", "tsk_1"]

    def test_the_kind_travels_with_the_change(self):
        """apply() picks update_rfc or update_task off it, so a wrong kind writes nothing."""
        items = [self.item(item_id="rfc_1", kind="rfc", body=BROKEN,
                           created_by="confluence-import")]
        assert fixer.plan(items, fixer.IMPORT_ACTORS)[0]["kind"] == "rfc"

    def test_a_missing_body_does_not_raise(self):
        assert fixer.plan([{"item_id": "tsk_1", "kind": "task", "created_by": "jira-import"}],
                          fixer.IMPORT_ACTORS) == []


class TestApply:
    def test_a_task_and_an_rfc_are_both_written(self, aws):
        from app.db.queries import work as work_q

        task = work_q.create_task({
            "title": "t", "body": BROKEN, "status": "backlog",
            "created_by": "jira-import",
        })
        rfc = work_q.create_rfc({
            "title": "r", "body": BROKEN, "status": "draft",
            "created_by": "confluence-import",
        })

        items = work_q.list_tasks() + work_q.list_rfcs()
        changes = fixer.plan(items, fixer.IMPORT_ACTORS)
        assert len(changes) == 2
        fixer.apply(changes)

        assert work_q.get_task(task["item_id"])["body"] == FIXED
        assert work_q.get_rfc(rfc["item_id"])["body"] == FIXED

    def test_a_second_run_finds_nothing_to_do(self, aws):
        from app.db.queries import work as work_q

        work_q.create_task({"title": "t", "body": BROKEN, "status": "backlog",
                            "created_by": "jira-import"})
        fixer.apply(fixer.plan(work_q.list_tasks(), fixer.IMPORT_ACTORS))
        assert fixer.plan(work_q.list_tasks(), fixer.IMPORT_ACTORS) == []

    def test_a_row_that_vanished_stops_the_run_loudly(self, aws):
        """
        Skipping it would mean something else is writing to the table and this script
        carried on guessing. It stops, and says how many rows it already changed.
        """
        changes = [{"item_id": "tsk_gone", "kind": "task", "title": "t",
                    "before": BROKEN, "after": FIXED, "applied": ["footer"]}]
        with pytest.raises(SystemExit) as excinfo:
            fixer.apply(changes)
        assert "tsk_gone" in str(excinfo.value)
