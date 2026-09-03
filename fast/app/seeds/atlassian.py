"""
Shared plumbing for the Atlassian importers: text cleanup, and the provenance footer.

Jira issue descriptions and Confluence page bodies both come back with fragments of
Atlassian's own document serialisation embedded in them. Both importers hit it, and the
one-off repair script hits it too, so the rule lives here once. Two copies of a rule
about rewriting somebody's text is how the two quietly disagree, and the disagreement
shows up as a body that reads slightly differently depending on which script last
touched it.

WHY THIS HAS TO BE FIXED AT ALL
-------------------------------
The reader is src/components/Markdown.tsx: react-markdown with remark-gfm and
deliberately no rehype-raw. That does NOT drop unknown tags - it ESCAPES them - so an
untouched body renders the literal text

    <custom data-type="smartlink" data-id="id-0">https://…</custom>

on screen, wrapper and all. That was measured by rendering through the real pipeline,
not reasoned about; the first guess was that the tags would silently vanish, and it was
wrong. Worth stating because the same wrong guess is easy to make again.

WHY THE RULE IS NARROW, AND MUST STAY NARROW
--------------------------------------------
The tempting fix is to strip anything that looks like a tag. It would be a disaster.
These documents are full of angle brackets that are *content*:

    GET /notes/<uuid>          <filename>          <write table details here>
    <optional int FK>          <View accessibilityRole="header">

Those are placeholders somebody typed to mean "put a value here", and JSX in code
examples. react-markdown escaping them into a visible `<uuid>` is the correct
rendering. So the only thing matched here is the single pattern Atlassian generates and
no human writes by hand: `<custom data-type="...">`.

THE FOOTER, AND WHY ITS WHITESPACE IS LOAD-BEARING
--------------------------------------------------
Every imported body ends with where it came from, and both loaders build that footer,
so footer() lives here too. It looks like formatting and it is not:

  * `text\\n---` is a **setext H2** in markdown, not a paragraph followed by a rule. A
    footer that opens with a single newline therefore renders the last sentence of the
    description as a large heading and makes the separator vanish. The first 298 rows
    were imported that way, and fix_adf_bodies repairs them.
  * consecutive lines are **one paragraph**, so the facts written as plain lines run
    together into a single unreadable sentence. They are a bullet list.

Both were measured against a real react-markdown render rather than reasoned about,
for the reason given above: reasoning about this renderer has already been wrong once.
"""

import re

# Smartlinks, @mentions, status lozenges, inline dates and emoji all serialise this
# way. The inner text is the content - the URL, the person's name, the status word -
# and it is kept exactly as written; only the wrapper goes.
ADF_WRAPPER = re.compile(r"<custom\s+data-type=\"[^\"]*\"[^>]*>(.*?)</custom>", re.DOTALL)

# Confluence and Jira pad empty paragraphs with a zero-width non-joiner. Alone on a
# line it renders as <p>‌</p>: a paragraph holding one invisible character, so a
# visible gap with nothing in it.
ZWNJ = "‌"


def clean_adf(text: str) -> str:
    """
    Unwrap Atlassian's <custom> nodes and drop lines that are only zero-width padding.

    Idempotent: a body that has already been through this comes back unchanged, which
    is what lets the repair script run twice, or after a later import, safely.
    """
    text = ADF_WRAPPER.sub(lambda m: m.group(1), text)

    kept = []
    for line in text.split("\n"):
        # A genuinely blank line separates paragraphs and must survive. A line whose
        # only content is zero-width is the artifact and goes. A ZWNJ sitting inside a
        # line of real text is left exactly where it is.
        bare = line.strip()
        if bare and not bare.strip(ZWNJ):
            continue
        kept.append(line)
    return "\n".join(kept)


# The exact separator every imported body carries, and what fix_adf_bodies looks for
# when repairing the rows that were written before this was right.
FOOTER_RULE = "\n\n---\n"


def footer(facts: list[str]) -> str:
    """
    The provenance block, as markdown that renders the way it reads. See the docstring.

    Takes the facts as a list rather than a string so that a caller cannot accidentally
    hand over pre-joined lines and reintroduce the run-together paragraph.
    """
    return FOOTER_RULE + "\n".join("- %s" % f for f in facts)
