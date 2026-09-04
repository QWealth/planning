"""
The specialisation vocabulary.

A CLOSED list, not free text, and that is the whole point of the module.

The workbook recorded ownership as free text and ended up with "Liam -> AI Hire"
typed into a DRI cell - a person-shaped string with nobody behind it. Skills would
rot the same way and faster: "frontend", "front-end", "Front End" and "FE" are four
strings and one skill, and the moment they coexist the question this feature exists
to answer - "who could take this Testing phase" - silently returns the wrong people.
A closed list makes that a 422 at the edge instead of a slow drift nobody audits.

Adding a skill is deliberately a code change. It needs a migration decision (does
anybody already have it under another name?) and a deploy, which is the right amount
of friction for a taxonomy the whole roster is filtered on.

TWO AXES: STARS, AND APPETITE
-----------------------------
A specialisation records two independent things about one skill:

    stars           0-3, how well they can do it TODAY.
    wants_to_learn  whether they want to be given this work.

They are orthogonal on purpose, and the form makes that visible: three stars and a
tick box, not one control with four settings. Somebody can be a three-star back-end
engineer who also wants more of it, and somebody can be a zero-star one who wants to
start - and the second person is exactly who a staffing search should surface when
nobody else is free.

The rungs are uncaptioned, here and in the UI. They used to carry sentences - one star
"can help out, with somebody alongside" up to three "the obvious person to ask" - and
those were removed because they said less than the count did while putting words in the
mouth of whoever filled the form in. Zero stars means only that: no rating, and the row
is stored at all only if they want to learn.

An entry with zero stars and no appetite says nothing, so it is refused by the schema
rather than stored - the roster is a list of what people CAN do or WANT to do, and a
row per person per skill they neither can nor want would be ten times the data to say
nothing at all.

WHY THIS REPLACED THE OLD FOUR-ANSWER CONTROL
---------------------------------------------
It used to be a single `level`: `primary` ("Yes"), `secondary` ("Yes, but slowly") and
`learning` ("No, but wants to learn"). That last one was the problem. It was welded
onto a capability scale while explicitly not being part of one, so every consumer had
to be told in a comment to treat it as its own category - and the docstring here had
to argue at length that it was not a weaker `secondary`. Two fields say the same thing
without the argument, and they say it in a shape people can fill in without reading a
paragraph first.

The old prose also insisted there was "no numeric scale on purpose", on the grounds
that self-rated 1-5 levels go stale and invite argument. Three stars is still a small
ordinal scale and that objection has not evaporated - it is just outweighed. Three
rungs is few enough to be obvious at a glance, which two words per option never were,
and it sorts arithmetically instead of through a lookup table that every new consumer
had to remember to add a case to.

The split is still not enforced by count. Marking eight three-star skills is unhelpful
but it is a management problem, not a validation problem, and a 422 on the third would
just teach people to lie to the form.

NOTHING WAS MIGRATED
--------------------
Stored rows still carry the old `level` string, and `PersonModel._specialisations`
maps them on read: primary -> 3, secondary -> 2, learning -> 0 with wants_to_learn
set. That is the same layer that already defends against hand-edited items, so the
conversion costs no backfill script and no downtime, and a row written before this
change reads back as the closest honest thing under the new model. Writes use the new
shape, so the table converges as people edit their own entries.

WHO COUNTS AS COVER

Every recorded entry counts, one-star and want-to-learn included, so "recorded at all"
is the test and absence is the only no. That is a decision, not a default: a staffing
search will therefore return people who cannot do the job today. It is the right trade
because a learner who is never surfaced is never offered the work and so never stops
being a learner - but it only holds while the stars are displayed next to the name
everywhere the list is read. Reduce a specialisation to a yes/no anywhere and this
becomes a lie.
"""

from enum import Enum

# The rating scale, in one place because it is referenced as a bound in the schema, in
# the read normaliser and in the tests. Three, not five: see the docstring.
MIN_STARS = 0
MAX_STARS = 3


class Skill(str, Enum):
    """
    What somebody can be assigned to.

    Values are the stable identifiers stored in DynamoDB; labels are presentation
    and live in LABELS below, so renaming what the UI says never rewrites data.
    """

    FRONT_END = "front-end"
    BACK_END = "back-end"
    INFRASTRUCTURE = "infrastructure"
    RELATIONAL_DB = "relational-databases"
    NON_RELATIONAL_DB = "non-relational-databases"
    NETWORKING = "networking"
    UI_UX = "ui-ux"
    # Sits immediately after UI/UX because it is the tool the work is done in rather
    # than a discipline of its own, and the pair reads as one area of the list. Kept
    # separate all the same: "can design an interaction" and "can drive Figma" are
    # genuinely different answers, and the second is the one being asked when a
    # mock-up is needed by Thursday.
    FIGMA = "figma"
    QA_TESTING = "qa-testing"
    DATA_ENGINEERING = "data-engineering"
    COMPLIANCE = "compliance"


LABELS: dict[str, str] = {
    Skill.FRONT_END: "Front-end",
    Skill.BACK_END: "Back-end",
    Skill.INFRASTRUCTURE: "Infrastructure",
    Skill.RELATIONAL_DB: "Relational databases",
    Skill.NON_RELATIONAL_DB: "Non-relational databases",
    Skill.NETWORKING: "Networking",
    Skill.UI_UX: "UI/UX",
    Skill.FIGMA: "Figma",
    Skill.QA_TESTING: "QA & testing",
    Skill.DATA_ENGINEERING: "Data engineering",
    Skill.COMPLIANCE: "Compliance",
}

# Why each one is here, shown in the UI so the list is self-explaining and people
# stop inventing near-duplicates for work they think is uncovered.
DESCRIPTIONS: dict[str, str] = {
    Skill.FRONT_END: "React, TypeScript, the browser.",
    Skill.BACK_END: "APIs, services, business logic.",
    Skill.INFRASTRUCTURE: "AWS, CDK, deploys, CI.",
    Skill.RELATIONAL_DB: "Schema design, SQL, migrations.",
    Skill.NON_RELATIONAL_DB: "DynamoDB and friends; access-pattern modelling.",
    Skill.NETWORKING: "DNS, TLS, CloudFront, routing.",
    Skill.UI_UX: "Interaction and visual design.",
    Skill.FIGMA: "Mock-ups, prototypes and design files in Figma.",
    Skill.QA_TESTING: "Test strategy and the Testing phase on every lane.",
    Skill.DATA_ENGINEERING: "Pipelines and feeds: Enhanced Data Delivery, Qfeed.",
    Skill.COMPLIANCE: "Regulatory review and controls.",
}

# How a stored `level` from before the star scale reads today. See the module
# docstring: this is a read-time mapping, not a migration.
#
# `learning` maps to no stars at all, which is what it always meant - it was never a
# rung below `secondary`, and the old code needed a comment at every use site saying
# so. Here that is simply what the data says.
LEGACY_LEVEL_STARS: dict[str, int] = {
    "primary": 3,
    "secondary": 2,
    "learning": 0,
}

# What an unrecognised stored level reads as. Two stars, matching the old code's
# `str(entry.get("level") or "secondary")` default: a value nobody recognises should
# land in the middle rather than promote somebody to the obvious choice or quietly
# demote them to nothing.
LEGACY_DEFAULT_STARS = 2


def catalogue() -> list[dict[str, str]]:
    """The vocabulary as the API serves it, in display order."""
    return [
        {"skill": s.value, "label": LABELS[s], "description": DESCRIPTIONS[s]}
        for s in Skill
    ]
