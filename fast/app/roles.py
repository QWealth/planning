"""
The role vocabulary: what somebody *is* on the team.

A CLOSED list, for the same reason skills.py is closed - see that module's docstring
for the argument in full. The short version: free text produces "SWE", "Software Eng",
"engineer" and "Developer" as four strings and one role, and every filter built on it
quietly returns the wrong people.

THREE THINGS CALLED "ROLE", AND THIS IS ONLY ONE OF THEM
--------------------------------------------------------
The word is overloaded in this codebase and conflating the three would be a real bug,
so, explicitly:

    Role (here)     What somebody is: BA, UX, Software Engineer, QA, Data, Leadership.
                    A property of the person. Stable across projects.

    dri / support   What somebody is *on one lane*. A property of the assignment, not
                    the person - it lives on the project item, and the same person is
                    DRI of one project and Support on another. `Role` in
                    src/utils/assignments.ts means this one, which is why the frontend
                    type for the list below is called PersonRole rather than Role.

    Cognito groups  What somebody may *do*: the `admin` group. Authorisation, decided
                    outside this application entirely. Nothing here grants permission -
                    a Leadership role is a job title, not an admin bit, and anyone
                    reading this list as a permission check has introduced a
                    privilege-escalation-by-self-service bug, because people set their
                    own roles.

ROLES ARE NOT SKILLS
--------------------
Both lists exist and they overlap in wording, which looks like duplication and is not.

    Role.UX  says "I am a designer."          - who I am, on my roster row
    Skill.UI_UX says "I can do this work."    - what I can be staffed onto

The difference has teeth: a back-end engineer who is good at CSS holds Skill.FRONT_END
but is not Role.UX, and a BA who is learning testing holds Role.BA with a `learning`
entry against Skill.QA_TESTING. Roles answer "who is this person"; skills answer "who
could take this phase". Merging them would lose the second question, which is the one
that actually decides staffing.

Roles are also deliberately coarse - six entries, not twenty. They are for reading a
roster at a glance. Granularity belongs in skills, which is the list that grows.

REQUIRED GOING IN, TOLERATED COMING OUT
---------------------------------------
At least one role is required to add yourself. Nobody is none of these, and a roster
of blank roles is the workbook's Team sheet again.

But PersonOut defaults `roles` to `[]` and means it, because everybody seeded from the
workbook predates this field - the workbook recorded names, not disciplines, and
guessing them from a first name is exactly the kind of plausible-looking invention
migrate/extract_workbook.py refuses to make elsewhere. So an empty list is a real
state that must render, not a validation failure. Same asymmetry as PersonOut.email
being a plain str: validate at the edge where a caller can be told why, tolerate on
read where the only alternative is a dead endpoint.
"""

from enum import Enum


class Role(str, Enum):
    """
    What somebody does on the team.

    Values are the stable identifiers stored in DynamoDB; labels are presentation and
    live in LABELS below, so renaming what the UI says never rewrites data.
    """

    BA = "ba"
    UX = "ux"
    SOFTWARE_ENGINEER = "software-engineer"
    QA = "qa"
    DATA = "data"
    LEADERSHIP = "leadership"


LABELS: dict[str, str] = {
    Role.BA: "Business analyst",
    Role.UX: "UX",
    Role.SOFTWARE_ENGINEER: "Software engineer",
    Role.QA: "QA",
    Role.DATA: "Data",
    Role.LEADERSHIP: "Leadership",
}

# Shown next to each option in the picker. These describe the person, not the work -
# the descriptions in skills.py describe the work, and keeping the two phrasings
# distinct is what stops the pickers reading as the same question asked twice.
DESCRIPTIONS: dict[str, str] = {
    Role.BA: "Requirements, process, and what the business actually asked for.",
    Role.UX: "Interaction and visual design, research, prototypes.",
    Role.SOFTWARE_ENGINEER: "Builds and ships the software.",
    Role.QA: "Test strategy, and the Testing phase on every lane.",
    Role.DATA: "Pipelines, feeds, reporting, data modelling.",
    Role.LEADERSHIP: "Sets direction and owns outcomes. A job, not a permission.",
}


def catalogue() -> list[dict[str, str]]:
    """The vocabulary as the API serves it, in display order."""
    return [
        {"role": r.value, "label": LABELS[r], "description": DESCRIPTIONS[r]}
        for r in Role
    ]
