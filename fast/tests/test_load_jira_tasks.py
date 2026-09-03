"""
Tests for the Jira -> board importer.

Most of this is aimed at plan(), which is pure and is where every decision that could
silently lose work actually lives: what becomes a subtask, what gets promoted, what is
skipped, and who ends up with no owner. A wrong answer in any of those looks perfectly
fine on the board afterwards, which is exactly why it is tested here rather than
eyeballed once.
"""

import pytest

from app.seeds import load_jira_tasks as loader
from app.work import TaskStatus


def issue(
    key,
    issuetype="Task",
    is_subtask=False,
    status="New Ticket",
    status_category="new",
    summary=None,
    description=None,
    assignee_name=None,
    assignee_email=None,
    duedate=None,
    parent_key=None,
    epic_key=None,
    epic_name=None,
):
    return {
        "key": key,
        "issuetype": issuetype,
        "is_subtask": is_subtask,
        "status": status,
        "status_category": status_category,
        "summary": summary or ("summary of %s" % key),
        "description": description,
        "assignee_name": assignee_name,
        "assignee_email": assignee_email,
        "duedate": duedate,
        "parent_key": parent_key,
        "parent_issuetype": None,
        "epic_key": epic_key,
        "epic_name": epic_name,
        "url": "https://qwealth.atlassian.net/browse/%s" % key,
    }


def export_of(issues, app_project="Net Of Fees"):
    return {
        "site": "qwealth.atlassian.net",
        "lanes": [{"app_project": app_project, "jira_source": "test", "issues": issues}],
    }


RESOLVED = {"Net Of Fees": "proj-1", "QWAPP": "proj-2"}


class TestStatusMapping:
    def test_to_do_becomes_backlog(self):
        written = loader.plan(export_of([issue("A-1", status_category="new")]), RESOLVED)
        assert written["top_level"][0]["status"] == TaskStatus.BACKLOG.value

    def test_in_progress_category_becomes_in_progress(self):
        written = loader.plan(
            export_of([issue("A-1", status_category="indeterminate", status="Code Review")]),
            RESOLVED,
        )
        assert written["top_level"][0]["status"] == TaskStatus.IN_PROGRESS.value

    def test_every_indeterminate_status_collapses_to_one_column(self):
        """The collapse is deliberate and lossy; the original name survives in the body."""
        names = ["Architecting", "Wireframing", "Testing", "Blocked/Hold", "Code Review"]
        written = loader.plan(
            export_of([
                issue("A-%d" % i, status_category="indeterminate", status=name)
                for i, name in enumerate(names)
            ]),
            RESOLVED,
        )
        assert {r["status"] for r in written["top_level"]} == {TaskStatus.IN_PROGRESS.value}
        for name, row in zip(names, written["top_level"]):
            assert name in row["body"]

    def test_an_unknown_status_category_is_a_hard_stop(self):
        with pytest.raises(SystemExit) as excinfo:
            loader.plan(export_of([issue("A-1", status_category="banana")]), RESOLVED)
        assert "banana" in str(excinfo.value)

    def test_closed_work_in_an_open_export_is_reported(self):
        written = loader.plan(
            export_of([issue("A-1", status_category="done", status="Done")]), RESOLVED
        )
        assert written["unexpected_done"] == ["A-1"]


class TestEpics:
    def test_an_epic_is_not_imported_as_a_task(self):
        written = loader.plan(
            export_of([issue("E-1", issuetype="Epic"), issue("A-1")]), RESOLVED
        )
        keys = [r["jira_key"] for r in written["top_level"] + written["subtasks"]]
        assert keys == ["A-1"]
        assert written["skipped_epics"] == ["E-1"]

    def test_a_child_of_an_epic_is_top_level_not_a_subtask(self):
        """
        The epic is not imported, so there is nothing above this. Marked is_subtask by
        Jira or not, it has no parent here.
        """
        written = loader.plan(
            export_of([
                issue("E-1", issuetype="Epic"),
                issue("A-1", is_subtask=True, parent_key="E-1"),
            ]),
            RESOLVED,
        )
        assert written["subtasks"] == []
        assert written["top_level"][0]["parent_key"] is None

    def test_the_epic_name_lands_in_the_body_as_a_breadcrumb(self):
        written = loader.plan(
            export_of([issue("A-1", epic_key="E-9", epic_name="Login")]), RESOLVED
        )
        assert "Login" in written["top_level"][0]["body"]
        assert "E-9" in written["top_level"][0]["body"]


class TestNesting:
    def test_a_subtask_keeps_its_parent(self):
        written = loader.plan(
            export_of([issue("A-1"), issue("A-2", is_subtask=True, parent_key="A-1")]),
            RESOLVED,
        )
        assert [r["jira_key"] for r in written["top_level"]] == ["A-1"]
        assert written["subtasks"][0]["jira_key"] == "A-2"
        assert written["subtasks"][0]["parent_key"] == "A-1"

    def test_a_subtask_whose_parent_is_closed_is_promoted_not_dropped(self):
        """
        The export holds only open work, so a shipped parent is simply absent. The
        subtask is real open work and must survive.
        """
        written = loader.plan(
            export_of([issue("A-2", is_subtask=True, parent_key="A-GONE")]), RESOLVED
        )
        assert written["subtasks"] == []
        assert written["top_level"][0]["jira_key"] == "A-2"
        assert written["top_level"][0]["parent_key"] is None

    def test_a_promotion_is_never_silent(self):
        written = loader.plan(
            export_of([issue("A-2", is_subtask=True, parent_key="A-GONE")]), RESOLVED
        )
        assert len(written["promoted"]) == 1
        assert "A-2" in written["promoted"][0]
        assert "A-GONE" in written["promoted"][0]

    def test_nesting_never_exceeds_one_level(self):
        """
        Jira allows Epic -> Story -> Sub-task. The board does not. Whatever the input,
        no imported row may point at a row that itself points at something.
        """
        written = loader.plan(
            export_of([
                issue("E-1", issuetype="Epic"),
                issue("S-1", parent_key="E-1"),
                issue("T-1", is_subtask=True, parent_key="S-1"),
            ]),
            RESOLVED,
        )
        tops = {r["jira_key"] for r in written["top_level"]}
        for row in written["subtasks"]:
            assert row["parent_key"] in tops


class TestAdfCleanup:
    """The shared helper has its own tests; this pins that plan() actually calls it."""

    def test_the_cleanup_runs_during_a_real_import(self):
        written = loader.plan(
            export_of([issue("A-1", description='x <custom data-type="mention" data-id="q">@Sam</custom>')]),
            RESOLVED,
        )
        body = written["top_level"][0]["body"]
        assert "custom" not in body
        assert "x @Sam" in body


class TestOwners:
    def test_an_assignee_with_an_email_becomes_the_owner(self):
        written = loader.plan(
            export_of([issue("A-1", assignee_name="Joe", assignee_email="joe@qwealth.com")]),
            RESOLVED,
        )
        assert written["top_level"][0]["owner_email"] == "joe@qwealth.com"
        assert written["unmapped_owners"] == {}

    def test_an_assignee_without_an_email_is_unmapped_not_invented(self):
        written = loader.plan(
            export_of([issue("A-1", assignee_name="Joe Banning")]), RESOLVED
        )
        assert written["top_level"][0]["owner_email"] is None
        assert written["unmapped_owners"] == {"Joe Banning": ["A-1"]}

    def test_an_unmapped_name_is_kept_in_the_body(self):
        """Losing the only handle on who owns the work would be worse than no owner."""
        written = loader.plan(export_of([issue("A-1", assignee_name="Joe Banning")]), RESOLVED)
        assert "Joe Banning" in written["top_level"][0]["body"]

    def test_unassigned_is_not_an_unmapped_owner(self):
        written = loader.plan(export_of([issue("A-1")]), RESOLVED)
        assert written["unmapped_owners"] == {}
        assert written["top_level"][0]["owner_email"] is None


class TestBodyAndFields:
    def test_the_description_survives_above_the_footer(self):
        written = loader.plan(
            export_of([issue("A-1", description="The actual detail.")]), RESOLVED
        )
        body = written["top_level"][0]["body"]
        assert body.startswith("The actual detail.")
        assert "A-1" in body

    def test_an_empty_description_still_gets_provenance(self):
        written = loader.plan(export_of([issue("A-1")]), RESOLVED)
        body = written["top_level"][0]["body"]
        assert "browse/A-1" in body

    def test_the_footer_does_not_turn_the_last_line_into_a_heading(self):
        """
        `text\\n---` is a setext H2. The first 287 rows were imported one newline short
        and rendered the closing sentence of every description as a large heading, with
        no separator. Substring assertions cannot see that, so this looks at the shape.
        """
        written = loader.plan(
            export_of([issue("A-1", description="The closing sentence.")]), RESOLVED
        )
        body = written["top_level"][0]["body"]
        assert "The closing sentence.\n\n---\n" in body
        assert "The closing sentence.\n---" not in body

    def test_each_provenance_fact_is_a_bullet(self):
        """Plain consecutive lines are one paragraph, so the footer ran together."""
        written = loader.plan(
            export_of([issue("A-1", status="Code Review", status_category="indeterminate",
                             epic_key="E-1", epic_name="Login")]),
            RESOLVED,
        )
        body = written["top_level"][0]["body"]
        assert "- Imported from Jira A-1" in body
        assert "- Jira status at import: Code Review" in body
        assert "- Jira epic: Login (E-1)" in body

    def test_the_jira_key_and_url_are_always_recorded(self):
        written = loader.plan(export_of([issue("A-1")]), RESOLVED)
        body = written["top_level"][0]["body"]
        assert "A-1" in body
        assert "https://qwealth.atlassian.net/browse/A-1" in body

    def test_title_and_due_and_project_carry_over(self):
        written = loader.plan(
            export_of([issue("A-1", summary="  Fix the thing  ", duedate="2026-11-30")]),
            RESOLVED,
        )
        row = written["top_level"][0]
        assert row["title"] == "Fix the thing"
        assert row["due"] == "2026-11-30"
        assert row["project_id"] == "proj-1"

    def test_task_order_increments_within_a_lane(self):
        written = loader.plan(
            export_of([issue("A-1"), issue("A-2"), issue("A-3")]), RESOLVED
        )
        assert [r["task_order"] for r in written["top_level"]] == [0, 1, 2]

    def test_two_lanes_keep_their_own_project_ids(self):
        export = {
            "site": "qwealth.atlassian.net",
            "lanes": [
                {"app_project": "Net Of Fees", "jira_source": "x", "issues": [issue("A-1")]},
                {"app_project": "QWAPP", "jira_source": "y", "issues": [issue("B-1")]},
            ],
        }
        written = loader.plan(export, RESOLVED)
        by_key = {r["jira_key"]: r for r in written["top_level"]}
        assert by_key["A-1"]["project_id"] == "proj-1"
        assert by_key["B-1"]["project_id"] == "proj-2"


class TestProjectResolution:
    def test_a_lane_resolves_by_name(self, aws):
        from app.db.queries import projects as project_q

        created = project_q.create_project(name="Net Of Fees", lane_order=0, phases=[])
        resolved, missing = loader.resolve_projects([{"app_project": "Net Of Fees"}])
        assert missing == []
        assert resolved == {"Net Of Fees": created["project_id"]}

    def test_a_lane_with_no_matching_project_is_reported(self, aws):
        resolved, missing = loader.resolve_projects([{"app_project": "Nope"}])
        assert missing == ["Nope"]
        assert resolved == {}


class TestLoad:
    def test_tickets_and_subtasks_are_written_with_a_real_parent_link(self, aws):
        from app.db.queries import projects as project_q, work as work_q

        project = project_q.create_project(name="Net Of Fees", lane_order=0, phases=[])
        export = export_of([
            issue("A-1"),
            issue("A-2", is_subtask=True, parent_key="A-1"),
        ])
        written = loader.plan(export, {"Net Of Fees": project["project_id"]})
        loader.load(written)

        tasks = work_q.list_tasks()
        assert len(tasks) == 2
        parents = [t for t in tasks if t["parent_id"] is None]
        children = [t for t in tasks if t["parent_id"] is not None]
        assert len(parents) == 1 and len(children) == 1
        assert children[0]["parent_id"] == parents[0]["item_id"]

    def test_an_imported_task_carries_the_import_actor(self, aws):
        from app.db.queries import projects as project_q, work as work_q

        project = project_q.create_project(name="Net Of Fees", lane_order=0, phases=[])
        written = loader.plan(export_of([issue("A-1")]), {"Net Of Fees": project["project_id"]})
        loader.load(written)

        task = work_q.list_tasks()[0]
        assert task["created_by"] == loader.IMPORT_ACTOR
