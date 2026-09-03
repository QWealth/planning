"""
Tests for the shared Atlassian markup helpers.

Both importers and the one-off repair script call clean_adf, so it is tested once,
here, rather than three times in three places that could drift.

Half of these assert what it does. The other half - the more valuable half - assert
what it must NOT touch. Jira descriptions and Confluence pages are full of angle
brackets that are content: API placeholders, schema notation, JSX examples. A cleanup
that ate those would look like a tidy-up and would be data loss.

TestFooter exists because 381 tests passed while every imported body rendered its last
sentence as an `<h2>`. They all asserted substrings, and a substring survives a
whitespace bug intact. These assert the structure markdown actually cares about.
"""

from app.seeds.atlassian import FOOTER_RULE, clean_adf, footer


class TestUnwrapping:
    def test_a_smartlink_is_unwrapped_to_its_url(self):
        assert clean_adf(
            'See <custom data-type="smartlink" data-id="id-0">https://x/QCON-73</custom> now'
        ) == "See https://x/QCON-73 now"

    def test_a_mention_keeps_the_name(self):
        assert clean_adf(
            'ping <custom data-type="mention" data-id="abc">@Jordan Thiessen</custom>'
        ) == "ping @Jordan Thiessen"

    def test_status_date_and_emoji_all_keep_their_text(self):
        for kind, inner in [("status", "IN REVIEW"), ("date", "2026-09-30"), ("emoji", ":tada:")]:
            assert clean_adf(
                '<custom data-type="%s" data-id="z">%s</custom>' % (kind, inner)
            ) == inner

    def test_several_wrappers_in_one_body_are_all_unwrapped(self):
        got = clean_adf(
            '<custom data-type="mention" data-id="a">@Sam</custom> to review '
            '<custom data-type="smartlink" data-id="b">https://x/1</custom>'
        )
        assert got == "@Sam to review https://x/1"
        assert "custom" not in got

    def test_two_adjacent_lozenges_both_survive_as_text(self):
        """
        A real page in space QA opens with two contradicting status lozenges. Both have
        to reach the body, because the loader's status override says a human read them
        and a reader has to be able to check that.
        """
        got = clean_adf(
            '<custom data-type="status" data-id="id-0">REQUEST FOR COMMENTS</custom> '
            '<custom data-type="status" data-id="id-1">Draft</custom>'
        )
        assert got == "REQUEST FOR COMMENTS Draft"

    def test_a_wrapper_spanning_newlines_is_unwrapped(self):
        assert clean_adf(
            '<custom data-type="smartlink" data-id="a">https://x/1\nhttps://x/2</custom>'
        ) == "https://x/1\nhttps://x/2"

    def test_it_is_idempotent(self):
        """What lets the repair script run twice without a second opinion."""
        once = clean_adf('a <custom data-type="mention" data-id="q">@Sam</custom> b\n\n‌\n\nc')
        assert clean_adf(once) == once


class TestWhatItMustNotTouch:
    def test_a_placeholder_in_angle_brackets_is_left_alone(self):
        """
        Somebody typed `<uuid>` to mean "a uuid goes here". react-markdown escaping it
        into a visible `<uuid>` is the correct rendering, not a bug to clean up.
        """
        for text in [
            "GET /notes/<uuid>",
            "save as <filename>",
            "<write table details here>",
            "id <int>, name <str>",
            "<optional int FK>",
            "<fk to parent table>",
            "<en, fr, ...>",
        ]:
            assert clean_adf(text) == text

    def test_a_jsx_snippet_is_left_alone(self):
        snippet = '<View accessibilityRole="header">\n  <Text>Hi</Text>\n</View>'
        assert clean_adf(snippet) == snippet

    def test_a_fenced_code_block_is_left_alone(self):
        code = '```tsx\n<Icon name="chevron-right" />\n```'
        assert clean_adf(code) == code

    def test_a_tag_that_merely_looks_similar_is_left_alone(self):
        """The match is on `<custom data-type=`, not on the word custom."""
        for text in ["<customer>", '<custom-thing data-type="x">y</custom-thing>', "<custom>"]:
            assert clean_adf(text) == text

    def test_an_ordinary_markdown_body_passes_through_untouched(self):
        text = (
            "# Heading\n\nSome *markdown* with a [link](https://x).\n\n"
            "- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n"
        )
        assert clean_adf(text) == text

    def test_an_empty_string_survives(self):
        assert clean_adf("") == ""


class TestFooter:
    """
    The whitespace here is the whole test. `text\\n---` is a setext H2 in markdown, so
    a footer one newline short renders the author's closing sentence as a big heading
    and makes the separator disappear. Verified against a real react-markdown render;
    these pin the shape that render agreed with.
    """

    def test_a_blank_line_separates_the_body_from_the_rule(self):
        out = "The last sentence." + footer(["Imported from Jira A-1 (https://x)"])
        assert "The last sentence.\n\n---\n" in out

    def test_the_rule_is_never_directly_under_a_line_of_text(self):
        """The exact bug. One newline, and that sentence becomes an <h2>."""
        out = "The last sentence." + footer(["a fact"])
        assert "The last sentence.\n---" not in out

    def test_the_rule_is_alone_on_its_line(self):
        """
        A blank line BEFORE the rule, and none needed after it - a list opens fine
        directly under a thematic break, which was checked rather than assumed.
        """
        out = "Body." + footer(["a fact"])
        lines = out.split("\n")
        assert "---" in lines
        assert lines[lines.index("---") - 1] == ""
        assert lines[lines.index("---") + 1] == "- a fact"

    def test_each_fact_is_its_own_bullet(self):
        """
        Consecutive plain lines are ONE paragraph in markdown, so the facts ran
        together into a single sentence on screen. Bullets are the fix.
        """
        out = footer(["first fact", "second fact", "third fact"])
        assert out.count("\n- ") == 3
        assert out.endswith("- first fact\n- second fact\n- third fact")

    def test_a_single_fact_is_still_a_bullet(self):
        assert footer(["only one"]).endswith("- only one")

    def test_no_fact_is_swallowed(self):
        facts = ["a", "b", "c", "d"]
        out = footer(facts)
        for fact in facts:
            assert "- %s" % fact in out

    def test_the_footer_starts_with_the_shared_rule(self):
        """
        fix_adf_bodies finds the already-written rows by looking for FOOTER_RULE, so
        the constant and what footer() emits cannot be allowed to drift apart.
        """
        assert footer(["x"]).startswith(FOOTER_RULE)

    def test_an_empty_fact_list_still_produces_a_separator(self):
        assert footer([]) == FOOTER_RULE


class TestZeroWidthPadding:
    def test_a_zero_width_only_line_is_dropped(self):
        assert clean_adf("One.\n\n‌\n\nTwo.") == "One.\n\n\nTwo."

    def test_a_zero_width_line_with_surrounding_spaces_is_dropped(self):
        assert clean_adf("One.\n  ‌  \nTwo.") == "One.\nTwo."

    def test_a_blank_line_is_never_dropped(self):
        """Paragraph separation is real markdown and load-bearing for the reader."""
        assert clean_adf("One.\n\nTwo.") == "One.\n\nTwo."

    def test_paragraphs_stay_separate_after_the_padding_goes(self):
        out = clean_adf("One.\n\n‌\n\nTwo.")
        assert "One." in out.split("\n\n")[0]
        assert out.strip().endswith("Two.")

    def test_a_zero_width_inside_real_text_is_left_where_it_is(self):
        assert clean_adf("a‌b") == "a‌b"

    def test_several_padding_lines_all_go(self):
        assert clean_adf("A\n‌\n‌\n‌\nB") == "A\nB"
