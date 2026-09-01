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

LEVELS

Four answers in the UI, three of them stored:

    "No"                     no entry at all - absence is the answer
    "Yes, but slowly"        SECONDARY - can do it, will take longer
    "Yes"                    PRIMARY   - the obvious person to ask
    "No, but wants to learn" LEARNING  - cannot do it today, wants the work

There is no numeric proficiency scale on purpose: self-rated 1-5 levels go stale,
invite argument, and the only question actually being asked here is who to put on a
phase.

The split is not enforced by count. Marking eight primaries is unhelpful but it is a
management problem, not a validation problem, and a 422 on the third primary would
just teach people to lie to the form.

WHY THE STORED VALUES ARE STILL `primary` AND `secondary`
--------------------------------------------------------
The wording changed, the data did not. `primary`/`secondary` are the identifiers in
DynamoDB against every person already recorded, and this module's own rule is that
labels are presentation - renaming what the UI says must never rewrite data. So "Yes"
and "Yes, but slowly" are relabelling, not a migration, and nothing has to be
backfilled.

`learning` IS a new stored value, because it records something no existing entry
could express. Note what it is NOT: it is not a third rung of the capability ladder.
`primary` > `secondary` is an ordering; `learning` sits off that scale entirely,
describing appetite rather than ability. Anything that sorts or ranks specialisations
must treat it as its own category rather than as "less than secondary".

WHO COUNTS AS COVER

Every recorded level counts, `learning` included, so "recorded at all" is the test and
absence is the only no. That is a decision, not a default: a staffing search will
therefore return people who cannot do the job today. It is the right trade because a
learner who is never surfaced is never offered the work and so never stops being a
learner - but it only holds while the level is displayed next to the name everywhere
the list is read. Reduce a specialisation to a yes/no anywhere and this becomes a lie.
"""

from enum import Enum


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
    QA_TESTING = "qa-testing"
    DATA_ENGINEERING = "data-engineering"
    COMPLIANCE = "compliance"


class SkillLevel(str, Enum):
    """
    How somebody holds a skill - or wants to.

    See the LEVELS note in the module docstring: PRIMARY and SECONDARY are a
    capability ordering, LEARNING is deliberately outside it.
    """

    PRIMARY = "primary"
    SECONDARY = "secondary"
    LEARNING = "learning"


# The words the UI puts on each level, kept beside the values they describe so a
# reworded label and the value it belongs to cannot drift apart in review.
LEVEL_LABELS: dict[str, str] = {
    SkillLevel.PRIMARY: "Yes",
    SkillLevel.SECONDARY: "Yes, but slowly",
    SkillLevel.LEARNING: "No, but wants to learn",
}


LABELS: dict[str, str] = {
    Skill.FRONT_END: "Front-end",
    Skill.BACK_END: "Back-end",
    Skill.INFRASTRUCTURE: "Infrastructure",
    Skill.RELATIONAL_DB: "Relational databases",
    Skill.NON_RELATIONAL_DB: "Non-relational databases",
    Skill.NETWORKING: "Networking",
    Skill.UI_UX: "UI/UX",
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
    Skill.QA_TESTING: "Test strategy and the Testing phase on every lane.",
    Skill.DATA_ENGINEERING: "Pipelines and feeds: Enhanced Data Delivery, Qfeed.",
    Skill.COMPLIANCE: "Regulatory review and controls.",
}


def catalogue() -> list[dict[str, str]]:
    """The vocabulary as the API serves it, in display order."""
    return [
        {"skill": s.value, "label": LABELS[s], "description": DESCRIPTIONS[s]}
        for s in Skill
    ]
