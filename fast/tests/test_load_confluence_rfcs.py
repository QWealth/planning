"""
Tests for the Confluence -> RFC importer.

Aimed at plan(), same as the Jira loader's tests, and for the same reason: every
decision that could quietly falsify the decision record lives there. What status a page
lands on, whether a missing status gets invented, whether a body arrives whole, whether
an author's name turns into an email nobody reads. All of those look completely fine on
the RFC list afterwards, which is why they are pinned here.

read_bodies gets its own attention because a truncated import is the one failure mode
with no later symptom: half an RFC reads exactly like an RFC somebody never finished.
"""

import json
import os

import pytest

from app.seeds import load_confluence_rfcs as loader
from app.work import RfcStatus


def page(
    page_id="1000",
    title="A Proposal",
    confluence_status=None,
    author_name=None,
    version_label=None,
    stated_updated=None,
    last_modified=None,
    body_chars=None,
    space_key="QA",
):
    return {
        "page_id": page_id,
        "title": title,
        "url": "https://qwealth.atlassian.net/wiki/spaces/QA/pages/%s" % page_id,
        "space_key": space_key,
        "subtype": "",
        "body_file": "%s.md" % page_id,
        "body_chars": body_chars,
        "author_name": author_name,
        "last_modified": last_modified,
        "confluence_status": confluence_status,
        "version_label": version_label,
        "stated_created": None,
        "stated_updated": stated_updated,
        "notes": "",
    }


def export_of(pages):
    return {"site": "qwealth.atlassian.net", "pages": pages, "failed": []}


def write_export(tmp_path, pages, bodies=None):
    """Lay an export down on disk the way the exporter would."""
    bodies = bodies or {}
    for p in pages:
        text = bodies.get(p["page_id"], "The body of %s." % p["page_id"])
        (tmp_path / p["body_file"]).write_text(text, encoding="utf-8")
    export = export_of(pages)
    (tmp_path / "index.json").write_text(json.dumps(export), encoding="utf-8")
    return str(tmp_path)


# Every project PAGE_PROJECT names, resolved to a fake id. Derived from the table
# rather than listed, so adding a page to PAGE_PROJECT cannot break unrelated tests.
ALL_RESOLVED = {name: "proj-%s" % name.lower().replace(" ", "-")
                for name in set(loader.PAGE_PROJECT.values())}


def planned(pages, bodies=None, resolved=None, skip=None):
    """
    plan() over in-memory bodies, for the cases that do not care about the disk.

    `skip` defaults to nothing rather than to SKIP_PAGES, so that a test which happens
    to reuse a real skipped page id as a fixture does not silently get zero rows and an
    assertion failure about something it was not testing. TestSkipList passes the real
    list, and pins that plan() defaults to it.
    """
    bodies = bodies or {p["page_id"]: "The body of %s." % p["page_id"] for p in pages}
    return loader.plan(
        export_of(pages),
        bodies,
        ALL_RESOLVED if resolved is None else resolved,
        {} if skip is None else skip,
    )


class TestStatusMapping:
    def test_draft_maps_to_draft(self):
        written = planned([page(confluence_status="Draft")])
        assert written["rows"][0]["status"] == RfcStatus.DRAFT.value

    def test_request_for_comments_maps_to_review(self):
        written = planned([page(confluence_status="Request for Comments")])
        assert written["rows"][0]["status"] == RfcStatus.REVIEW.value

    def test_the_status_is_matched_case_and_space_insensitively(self):
        """It is typed by hand at the top of a wiki page, so it will not be tidy."""
        for stated in ["draft", "DRAFT", "  Draft  ", "dRaFt"]:
            written = planned([page(confluence_status=stated)])
            assert written["rows"][0]["status"] == RfcStatus.DRAFT.value

    def test_a_page_with_no_status_defaults_to_draft(self):
        written = planned([page(page_id="7", confluence_status=None)])
        assert written["rows"][0]["status"] == RfcStatus.DRAFT.value

    def test_a_defaulted_status_is_never_silent(self):
        """
        Otherwise a 2023 design doc of a system that shipped years ago sits in Draft
        forever and nobody knows the loader chose that rather than the author.
        """
        written = planned([page(page_id="7", confluence_status=None), page(page_id="8", confluence_status="Draft")])
        assert written["no_status"] == ["7"]

    def test_a_stated_status_is_not_counted_as_missing(self):
        written = planned([page(confluence_status="Draft")])
        assert written["no_status"] == []

    def test_an_unknown_status_is_a_hard_stop(self):
        with pytest.raises(SystemExit) as excinfo:
            planned([page(confluence_status="Marinating")])
        assert "Marinating" in str(excinfo.value)

    def test_superseded_is_deliberately_not_mapped(self):
        """
        It is the tempting one. 'Superseded' onto `withdrawn` would claim the author
        pulled the proposal, when the team in fact replaced it - a different piece of
        history, and the wrong one. A human decides; the loader stops.
        """
        assert "superseded" not in loader.STATUS_MAP
        with pytest.raises(SystemExit) as excinfo:
            planned([page(confluence_status="Superseded")])
        assert "Superseded" in str(excinfo.value)

    def test_nothing_in_the_map_lands_on_withdrawn(self):
        assert RfcStatus.WITHDRAWN.value not in set(loader.STATUS_MAP.values())

    def test_every_mapped_value_is_a_real_status(self):
        """A typo here would 422 at the API boundary long after the import."""
        valid = {s.value for s in RfcStatus}
        assert set(loader.STATUS_MAP.values()) <= valid


class TestStatusOverride:
    """
    One real page opens with two contradicting status lozenges, so a human had to
    choose. These pin that the choice is applied, is reported, and does not quietly
    widen into a general-purpose override of whatever the page said.
    """

    def test_an_overridden_page_gets_the_recorded_status(self):
        written = planned([page(page_id="1764360194", confluence_status="REQUEST FOR COMMENTS / Draft")])
        assert written["rows"][0]["status"] == loader.PAGE_STATUS["1764360194"]

    def test_an_override_beats_the_hard_stop_on_an_unknown_value(self):
        """Without the override this exact value would raise, which is how it was found."""
        written = planned([page(page_id="1764360194", confluence_status="REQUEST FOR COMMENTS / Draft")])
        assert written["rows"][0]["status"] == RfcStatus.REVIEW.value

    def test_an_override_is_never_silent(self):
        written = planned([page(page_id="1764360194", confluence_status="REQUEST FOR COMMENTS / Draft")])
        assert len(written["overridden"]) == 1
        assert "1764360194" in written["overridden"][0]
        assert "REQUEST FOR COMMENTS / Draft" in written["overridden"][0]

    def test_an_overridden_page_is_not_also_counted_as_statusless(self):
        written = planned([page(page_id="1764360194", confluence_status="REQUEST FOR COMMENTS / Draft")])
        assert written["no_status"] == []

    def test_a_page_with_no_override_is_not_reported_as_overridden(self):
        written = planned([page(page_id="1", confluence_status="Draft")])
        assert written["overridden"] == []

    def test_every_override_names_a_real_status(self):
        valid = {s.value for s in RfcStatus}
        assert set(loader.PAGE_STATUS.values()) <= valid


class TestSkipList:
    """
    Four of the fifteen exported pages are not proposals. These pin that they stay out
    of the table, that leaving them out is visible, and - the one that matters most -
    that the eleven judged to BE proposals are not quietly caught by the same filter.
    """

    def test_a_skipped_page_produces_no_row(self):
        written = planned([page(page_id="966262801")], skip=loader.SKIP_PAGES)
        assert written["rows"] == []

    def test_a_skip_is_reported_with_the_reason_it_was_skipped(self):
        """
        An exclusion nobody can see is indistinguishable from an export that missed the
        page, so the reason travels with it into the summary.
        """
        written = planned([page(page_id="966262801", title="Version check")],
                          skip=loader.SKIP_PAGES)
        assert len(written["skipped"]) == 1
        assert written["skipped"][0]["page_id"] == "966262801"
        assert written["skipped"][0]["title"] == "Version check"
        assert written["skipped"][0]["reason"] == loader.SKIP_PAGES["966262801"]

    def test_the_pages_around_a_skip_are_still_imported(self):
        written = planned(
            [page(page_id="966262801"), page(page_id="1633583105"), page(page_id="1669791751")],
            skip=loader.SKIP_PAGES,
        )
        assert [r["page_id"] for r in written["rows"]] == ["1633583105"]
        assert sorted(s["page_id"] for s in written["skipped"]) == ["1669791751", "966262801"]

    def test_a_skipped_page_is_not_counted_in_any_other_gap(self):
        """It is not projectless, statusless or empty - it is simply not here."""
        written = planned([page(page_id="966262801", author_name="Joe Banning")],
                          skip=loader.SKIP_PAGES)
        assert written["no_status"] == []
        assert written["no_project"] == []
        assert written["empty_bodies"] == []
        assert written["unmapped_authors"] == {}

    def test_nothing_is_skipped_when_no_page_is_on_the_list(self):
        written = planned([page(page_id="1633583105")], skip=loader.SKIP_PAGES)
        assert written["skipped"] == []
        assert len(written["rows"]) == 1

    def test_plan_applies_the_real_skip_list_by_default(self):
        """
        The parameter exists for --only and for the tests. If plan() ever stopped
        defaulting to SKIP_PAGES, every reason written down in that table would still
        be there and would no longer do anything.
        """
        written = loader.plan(export_of([page(page_id="966262801")]), {"966262801": "x"}, {})
        assert written["rows"] == []
        assert written["skipped"][0]["page_id"] == "966262801"

    def test_the_pages_kept_on_purpose_are_not_on_the_skip_list(self):
        """
        These three were read as borderline and deliberately kept - two because they are
        short, one because it is unfinished. Length and polish are not the test; whether
        the page proposes something is. Pinned so a later tidy-up cannot reverse the
        judgement without also deleting this.
        """
        for page_id in ["1633583105", "1579843585", "1734541313"]:
            assert page_id not in loader.SKIP_PAGES

    def test_every_skip_carries_a_reason(self):
        for page_id, reason in loader.SKIP_PAGES.items():
            assert len(reason) > 40, "%s has no real reason recorded" % page_id

    def test_a_skipped_page_is_never_also_given_a_project(self):
        """
        Both tables are keyed by page id and maintained by hand, so a page can end up in
        both. Only one of the four is, and that overlap is intentional and documented -
        this pins that the count does not grow by accident.
        """
        overlap = set(loader.SKIP_PAGES) & set(loader.PAGE_PROJECT)
        assert overlap == {"1750433793"}


class TestAdfCleanup:
    """
    Confluence leaks the same <custom> wrappers Jira does - 31 of them across the 15
    exported pages. The shared helper is tested in test_atlassian_markup.py; these pin
    that the RFC loader actually calls it, on the body it is about to store.
    """

    def test_wrappers_are_gone_from_the_stored_body(self):
        source = 'Owner <custom data-type="mention" data-id="a">@Liam Hilliard</custom> agreed.'
        written = planned([page(page_id="1")], bodies={"1": source})
        body = written["rows"][0]["body"]
        assert "custom" not in body
        assert "Owner @Liam Hilliard agreed." in body

    def test_the_two_contradicting_lozenges_survive_as_readable_text(self):
        """
        The status override says a human read both. If the cleanup ate them, nobody
        could check that judgement against the source.
        """
        source = (
            "# Local Ai Queueing\n\n"
            '<custom data-type="status" data-id="id-0">REQUEST FOR COMMENTS</custom> '
            '<custom data-type="status" data-id="id-1">Draft</custom>\n'
        )
        written = planned([page(page_id="1")], bodies={"1": source})
        body = written["rows"][0]["body"]
        assert "REQUEST FOR COMMENTS Draft" in body

    def test_a_code_placeholder_in_an_rfc_is_left_alone(self):
        source = "Call `GET /notes/<uuid>` and pass <filename>."
        written = planned([page(page_id="1")], bodies={"1": source})
        assert source in written["rows"][0]["body"]

    def test_the_length_check_runs_before_the_cleanup(self):
        """
        read_bodies compares against what the exporter counted, so it has to see the
        bytes as exported. Cleaning first would make every ADF-bearing page look
        truncated and hard-stop the whole import.
        """
        source = '<custom data-type="emoji" data-id="z">:tada:</custom>'
        pages = [page(page_id="1", body_chars=len(source))]
        written = loader.plan(export_of(pages), {"1": source}, {})
        assert written["rows"][0]["body"].startswith(":tada:")


class TestDecidedOn:
    def test_decided_on_is_always_null(self):
        written = planned([
            page(page_id="1", confluence_status="Accepted", stated_updated="2026-08-01"),
            page(page_id="2", confluence_status="Draft", last_modified="Jan 16, 2023"),
        ])
        assert [r["decided_on"] for r in written["rows"]] == [None, None]

    def test_a_last_updated_date_still_reaches_the_body(self):
        """Not fabricated as a decision date, but not thrown away either."""
        written = planned([page(confluence_status="Draft", stated_updated="2026-08-01")])
        assert "2026-08-01" in written["rows"][0]["body"]


class TestTitles:
    def test_the_filing_prefix_is_stripped(self):
        written = planned([page(title="(2026-08) Net Worth Statement v1")])
        assert written["rows"][0]["title"] == "Net Worth Statement v1"

    def test_the_original_title_survives_in_the_body(self):
        written = planned([page(title="(2026-08) Net Worth Statement v1")])
        body = written["rows"][0]["body"]
        assert "(2026-08) Net Worth Statement v1" in body
        assert "2026-08" in body

    def test_a_title_with_no_prefix_is_left_alone(self):
        written = planned([page(title="Docusign2DataDesignDoc RFC")])
        assert written["rows"][0]["title"] == "Docusign2DataDesignDoc RFC"

    def test_only_the_leading_month_prefix_is_touched(self):
        """A bracket mid-title is part of the name, not a filing convention."""
        written = planned([page(title="QWAPI (v1) and the first endpoint")])
        assert written["rows"][0]["title"] == "QWAPI (v1) and the first endpoint"

    def test_a_sloppy_prefix_still_parses(self):
        written = planned([page(title="( 2026-05 )   QWAPI Database auditor")])
        assert written["rows"][0]["title"] == "QWAPI Database auditor"


class TestBodies:
    def test_the_body_survives_above_the_footer(self):
        written = planned([page(page_id="1")], bodies={"1": "# Heading\n\nThe actual detail."})
        body = written["rows"][0]["body"]
        assert body.startswith("# Heading\n\nThe actual detail.")

    def test_markdown_is_not_reformatted(self):
        """react-markdown renders this; a helpfully tidied fence renders as prose."""
        source = "Text.\n\n```python\ndef f():\n    return 1\n```\n\n| a | b |\n| - | - |\n"
        written = planned([page(page_id="1")], bodies={"1": source})
        assert source.rstrip() in written["rows"][0]["body"]

    def test_the_page_id_and_url_are_always_recorded(self):
        written = planned([page(page_id="966262801")])
        body = written["rows"][0]["body"]
        assert "966262801" in body
        assert "wiki/spaces/QA/pages/966262801" in body

    def test_the_author_name_is_kept_in_the_body(self):
        """Losing the only handle on who wrote it would be worse than no owner."""
        written = planned([page(author_name="Jordan Thiessen")])
        assert "Jordan Thiessen" in written["rows"][0]["body"]

    def test_a_missing_status_is_stated_in_the_footer_not_left_blank(self):
        written = planned([page(confluence_status=None)])
        assert "stated no status" in written["rows"][0]["body"]

    def test_a_stated_status_is_recorded_verbatim_in_the_footer(self):
        """
        `Request for Comments` collapses onto `review`, which is lossy on purpose. The
        original wording stays readable, same as the Jira status names.
        """
        written = planned([page(confluence_status="Request for Comments")])
        assert "Request for Comments" in written["rows"][0]["body"]

    def test_an_empty_body_still_gets_provenance_and_is_reported(self):
        written = planned([page(page_id="1")], bodies={"1": "   \n\n"})
        assert written["empty_bodies"] == ["1"]
        assert "wiki/spaces/QA/pages/1" in written["rows"][0]["body"]

    def test_the_footer_does_not_turn_the_last_line_into_a_heading(self):
        """
        `text\\n---` is a setext H2 in markdown, not a rule. All 11 RFCs were first
        imported one newline short, which rendered the closing sentence of each as a
        large heading and swallowed the separator. Every other test in this file passed
        throughout, because they assert substrings and a substring survives it.
        """
        written = planned([page(page_id="1")], bodies={"1": "Body.\n\nThe closing sentence."})
        body = written["rows"][0]["body"]
        assert "The closing sentence.\n\n---\n" in body
        assert "The closing sentence.\n---" not in body

    def test_each_provenance_fact_is_a_bullet(self):
        written = planned([page(
            page_id="1", title="(2026-08) A Proposal", author_name="Liam Hilliard",
            confluence_status="Draft", version_label="2",
        )])
        body = written["rows"][0]["body"]
        assert "- Imported from Confluence page 1" in body
        assert "- Original title: (2026-08) A Proposal" in body
        assert "- Filed in Confluence under: 2026-08" in body
        assert "- Confluence author: Liam Hilliard" in body
        assert "- Confluence status at import: Draft" in body
        assert "- Confluence version: 2" in body

    def test_a_body_over_the_limit_is_a_hard_stop_not_a_truncation(self):
        from app.schemas.work import MAX_BODY

        with pytest.raises(SystemExit) as excinfo:
            planned([page(page_id="1")], bodies={"1": "x" * (MAX_BODY + 1)})
        assert "truncating" in str(excinfo.value)


class TestOwners:
    def test_an_author_not_in_the_table_never_becomes_an_owner_email(self):
        """
        The whole point. Confluence gives a display name; first.last@qwealth.com is a
        plausible-looking wrong answer, and an RFC owned by an address nobody reads is
        worse than one owned by nobody.
        """
        written = planned([page(author_name="Joe Banning")])
        assert written["rows"][0]["owner_email"] is None

    def test_an_author_with_no_address_is_reported(self):
        written = planned([page(page_id="1", author_name="Joe Banning")])
        assert written["unmapped_authors"] == {"Joe Banning": ["1"]}

    def test_an_author_with_several_pages_is_grouped(self):
        written = planned([
            page(page_id="1", author_name="Liam Hilliard"),
            page(page_id="2", author_name="Liam Hilliard"),
        ])
        assert written["unmapped_authors"] == {"Liam Hilliard": ["1", "2"]}

    def test_no_author_is_not_an_unmapped_author(self):
        written = planned([page(author_name=None)])
        assert written["unmapped_authors"] == {}

    def test_an_author_in_the_table_gets_the_mapped_address(self):
        written = planned([page(author_name="thomas kosciuch")])
        assert written["rows"][0]["owner_email"] == "thomas@qwealth.com"

    def test_a_mapped_author_is_matched_case_insensitively(self):
        """Confluence renders the display name however the account was created."""
        for name in ["Thomas Kosciuch", "thomas kosciuch", "  THOMAS KOSCIUCH  "]:
            written = planned([page(author_name=name)])
            assert written["rows"][0]["owner_email"] == "thomas@qwealth.com"

    def test_a_mapped_author_is_not_also_reported_as_unmapped(self):
        written = planned([page(author_name="thomas kosciuch")])
        assert written["unmapped_authors"] == {}

    def test_owners_that_were_set_are_reported_by_page(self):
        """
        Writing an owner is the one place this loader asserts something Confluence did
        not say, so it says which rows it did it to.
        """
        written = planned([
            page(page_id="1", author_name="thomas kosciuch"),
            page(page_id="2", author_name="thomas kosciuch"),
            page(page_id="3", author_name="Joe Banning"),
        ])
        assert written["owned"] == {"thomas@qwealth.com": ["1", "2"]}

    def test_nothing_is_reported_as_owned_when_no_author_matches(self):
        written = planned([page(author_name="Joe Banning")])
        assert written["owned"] == {}

    def test_every_mapped_name_is_stored_lowercased(self):
        """The lookup lowercases the page's author, so a capitalised key never matches."""
        for name in loader.AUTHOR_EMAIL:
            assert name == name.strip().lower()


class TestRosterVeto:
    """
    AUTHOR_EMAIL is hand-written. The failure it guards is silent: an owner_email that
    points at no account looks answered on the RFC list, which is strictly worse than
    the null it replaced.
    """

    def test_an_address_on_the_roster_passes(self, aws):
        """
        The real AUTHOR_EMAIL, against a roster holding exactly the addresses in it.

        Seeded from the dict rather than from a hardcoded address, because the dict
        grows every time an import turns up an author who resolves. Naming one here
        meant the next addition failed this test for the one reason it is not about -
        a roster the test forgot to populate, rather than a mapping that is wrong.
        """
        from app.db.queries import people as people_q

        for address in sorted(set(loader.AUTHOR_EMAIL.values())):
            people_q.create_person(email=address, name=address.split("@")[0])
        loader.check_author_roster()  # the real table, against the real roster

    def test_an_address_not_on_the_roster_is_a_hard_stop(self, aws):
        with pytest.raises(SystemExit) as excinfo:
            loader.check_author_roster({"someone": "nobody@qwealth.com"})
        assert "nobody@qwealth.com" in str(excinfo.value)

    def test_the_error_lists_the_roster_so_the_typo_is_visible(self, aws):
        from app.db.queries import people as people_q

        people_q.create_person(email="thomas@qwealth.com", name="Thomas")
        with pytest.raises(SystemExit) as excinfo:
            loader.check_author_roster({"thomas kosciuch": "thoams@qwealth.com"})
        assert "thomas@qwealth.com" in str(excinfo.value)

    def test_an_inactive_person_still_counts_as_real(self, aws):
        """
        Deactivated is not fictional. Refusing to attribute an RFC to somebody who has
        left would lose the authorship, which is the thing being preserved.
        """
        from app.db.queries import people as people_q

        people_q.create_person(email="gone@qwealth.com", name="Gone", active=False)
        loader.check_author_roster({"gone": "gone@qwealth.com"})

    def test_an_empty_table_vetoes_everything(self, aws):
        with pytest.raises(SystemExit):
            loader.check_author_roster()


class TestProjects:
    def test_a_page_in_the_table_gets_that_project(self):
        pages = [page(page_id="1022984193", title="Docusign2DataDesignDoc RFC")]
        written = loader.plan(export_of(pages), {"1022984193": "body"}, {"D2": "proj-d2"})
        assert written["rows"][0]["project_id"] == "proj-d2"
        assert written["rows"][0]["project_name"] == "D2"

    def test_a_page_absent_from_the_table_imports_with_no_project(self):
        """Nullable project_id is the feature, not a gap. See app/work.py."""
        written = planned([page(page_id="999999")])
        assert written["rows"][0]["project_id"] is None
        assert written["no_project"] == ["999999"]

    def test_an_unresolved_project_name_is_a_named_error_not_a_keyerror(self):
        """
        main() always resolves first, so this only fires when plan() is called direct.
        A bare KeyError names the project and nothing about what went wrong.
        """
        with pytest.raises(SystemExit) as excinfo:
            planned([page(page_id="1022984193")], resolved={})
        assert "1022984193" in str(excinfo.value)
        assert "D2" in str(excinfo.value)

    def test_a_page_with_a_project_is_not_counted_as_projectless(self):
        pages = [page(page_id="1022984193")]
        written = loader.plan(export_of(pages), {"1022984193": "body"}, {"D2": "proj-d2"})
        assert written["no_project"] == []

    def test_the_project_table_only_names_real_lanes(self):
        """
        Guards a typo in PAGE_PROJECT, which resolve_projects would otherwise turn into
        a hard stop the first time anyone ran the loader against prod.
        """
        lanes = {
            "QWAPP", "Tax", "D2", "DocuTelligence", "Net Of Fees",
            "Qfeed", "Net Worth", "Enhanced Data Delivery", "QWAPP Expansion Packs",
        }
        assert set(loader.PAGE_PROJECT.values()) <= lanes

    def test_a_lane_resolves_by_name(self, aws):
        from app.db.queries import projects as project_q

        created = project_q.create_project(name="Net Worth", lane_order=0, phases=[])
        resolved, missing = loader.resolve_projects({"1": "Net Worth"})
        assert missing == []
        assert resolved == {"Net Worth": created["project_id"]}

    def test_a_project_with_no_match_is_reported(self, aws):
        resolved, missing = loader.resolve_projects({"1": "Nope"})
        assert missing == ["Nope"]
        assert resolved == {}


class TestReadBodies:
    def test_bodies_are_read_off_disk_verbatim(self, tmp_path):
        pages = [page(page_id="1")]
        d = write_export(tmp_path, pages, {"1": "# Real\n\nbody\n"})
        assert loader.read_bodies(d, pages) == {"1": "# Real\n\nbody\n"}

    def test_a_body_shorter_than_the_export_recorded_is_a_hard_stop(self, tmp_path):
        """
        The failure this exists for: a truncated document reads exactly like one the
        author never finished, and there is no later moment anyone would notice.
        """
        pages = [page(page_id="1", body_chars=500)]
        d = write_export(tmp_path, pages, {"1": "short"})
        with pytest.raises(SystemExit) as excinfo:
            loader.read_bodies(d, pages)
        assert "500" in str(excinfo.value)

    def test_a_matching_length_passes(self, tmp_path):
        pages = [page(page_id="1", body_chars=len("exactly this"))]
        d = write_export(tmp_path, pages, {"1": "exactly this"})
        assert loader.read_bodies(d, pages)["1"] == "exactly this"

    def test_no_recorded_length_is_accepted(self, tmp_path):
        pages = [page(page_id="1", body_chars=None)]
        d = write_export(tmp_path, pages, {"1": "anything"})
        assert loader.read_bodies(d, pages)["1"] == "anything"

    def test_a_missing_body_file_raises(self, tmp_path):
        pages = [page(page_id="1")]
        write_export(tmp_path, pages)
        os.remove(str(tmp_path / "1.md"))
        with pytest.raises(IOError):
            loader.read_bodies(str(tmp_path), pages)


class TestLoad:
    def test_an_rfc_is_written_with_its_status_and_project(self, aws):
        from app.db.queries import projects as project_q, work as work_q

        project = project_q.create_project(name="D2", lane_order=0, phases=[])
        pages = [page(page_id="1022984193", title="Docusign2DataDesignDoc RFC",
                      confluence_status="Draft")]
        written = loader.plan(
            export_of(pages), {"1022984193": "The design."}, {"D2": project["project_id"]}
        )
        loader.load(written)

        rfcs = work_q.list_rfcs()
        assert len(rfcs) == 1
        assert rfcs[0]["title"] == "Docusign2DataDesignDoc RFC"
        assert rfcs[0]["status"] == RfcStatus.DRAFT.value
        assert rfcs[0]["project_id"] == project["project_id"]
        assert rfcs[0]["body"].startswith("The design.")

    def test_an_rfc_with_no_project_is_written_anyway(self, aws):
        from app.db.queries import work as work_q

        written = planned([page(page_id="999999")])
        loader.load(written)

        rfc = work_q.list_rfcs()[0]
        assert rfc["project_id"] is None

    def test_an_imported_rfc_carries_the_import_actor(self, aws):
        from app.db.queries import work as work_q

        loader.load(planned([page(page_id="1")]))
        assert work_q.list_rfcs()[0]["created_by"] == loader.IMPORT_ACTOR

    def test_no_imported_rfc_claims_a_decision_date(self, aws):
        from app.db.queries import work as work_q

        loader.load(planned([
            page(page_id="1", confluence_status="Accepted", stated_updated="2026-08-01"),
            page(page_id="2"),
        ]))
        assert [r.get("decided_on") for r in work_q.list_rfcs()] == [None, None]
