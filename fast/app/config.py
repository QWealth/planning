"""Environment configuration for the planning roadmap API."""

import os

# AWS Configuration
AWS_REGION = os.environ.get("AWS_REGION", "ca-central-1")

# DynamoDB Configuration.
#
# Projects and phases share one table, partitioned on project_id, because the
# question this app asks constantly is "give me a project and everything in it"
# and a single Query answers it. Two tables would make the roadmap screen do a
# fan-out of nine queries to draw one page.
PROJECTS_TABLE_NAME = os.environ.get("PROJECTS_TABLE_NAME", "planning-roadmap-projects")
PEOPLE_TABLE_NAME = os.environ.get("PEOPLE_TABLE_NAME", "planning-roadmap-people")

# RFCs and tasks, keyed on item_id (partition) + a fixed sk, with a GSI on kind.
#
# Its own table rather than more sort keys on the projects table, and the reason is
# not tidiness. `list_projects` scans that table whole, so anything parked there is
# read and discarded on every roadmap load - the chart would slow down in proportion
# to how much the team writes, which is backwards. And `project_id` is that table's
# partition key, so "an RFC attached to no project" could only be expressed by
# inventing a sentinel partition. Here it is a nullable attribute and the answer is
# null, which is the rule the whole backend already enforces.
#
# The GSI's partition key is `kind`, so the RFC list does not read tasks and vice
# versa. Two partitions is a hot-partition shape and is fine at this size on purpose;
# see the note in cdk/lib/dynamodb_stack.py before assuming otherwise.
WORK_TABLE_NAME = os.environ.get("WORK_TABLE_NAME", "planning-roadmap-work")
WORK_BY_KIND_INDEX = os.environ.get("WORK_BY_KIND_INDEX", "kind-updated-index")

# The audit table is keyed on entity_id (partition) + timestamp (sort).
#
# Deliberately not the marketing tool's shape. Its config.py records the mistake:
# that table is partitioned on `timestamp` alone, so every item lands in its own
# partition and there is no key to query by - "what happened to this rule" means
# scanning the whole table, and the scan gets slower and dearer every week forever.
#
# Here the first question anyone asks is "who moved this date", which is history
# for one entity, so entity_id is the partition key and the answer is one Query.
# A GSI on entity + timestamp answers the second question, "what changed lately".
AUDIT_TABLE_NAME = os.environ.get("AUDIT_TABLE_NAME", "planning-roadmap-audit")
AUDIT_BY_ENTITY_INDEX = os.environ.get("AUDIT_BY_ENTITY_INDEX", "entity-timestamp-index")

# Cognito. Shared with the marketing compliance tool - see the Cognito section of
# CLAUDE.md for why that is only safe with the group check below.
COGNITO_USER_POOL_ID = os.environ.get("COGNITO_USER_POOL_ID", "ca-central-1_P8orSDvVO")

# The Cognito group a caller must be in to use this API at all.
#
# Enforced, not merely resolved. The pool is shared with the compliance tool, and
# an API Gateway Cognito authorizer accepts any token the pool issued regardless of
# which app client minted it - so without this check, every compliance-tool account
# can edit the roadmap and every roadmap account can delete the compliance ruleset.
#
# On by default, and it fails closed: if the group does not exist in the pool yet,
# nobody gets in. That is the correct direction to fail, and it is only tolerable to
# turn on by default because nothing is deployed yet. Enforcement added to a live
# system locks people out; enforcement present from the first deploy never can.
REQUIRED_GROUP = os.environ.get("REQUIRED_GROUP", "planning").strip()
ENFORCE_GROUP = os.environ.get("ENFORCE_GROUP", "true").strip().lower() in {"1", "true", "yes"}

# The group that may manage OTHER people: deactivate them, delete them, edit their
# roster entry. Everyone else may still edit their own, and may still edit the
# roadmap itself - see routes/people.py.
#
# `admin` already exists on the shared pool at precedence 10, where the compliance
# tool uses it. Reusing it is a deliberate choice and it has a consequence worth
# stating plainly: a compliance-tool admin is an admin here too. The alternative was
# a dedicated planning-admin group, which was not chosen.
#
# The default is safe in the direction that matters. If the claim is missing or the
# group does not exist, nobody is an admin and the roster becomes read-only for
# everyone - annoying, and recoverable. The opposite default would hand deletion of
# the whole roster to any pool member.
ADMIN_GROUP = os.environ.get("ADMIN_GROUP", "admin").strip()

# Where this app answers, for the text of an invitation.
#
# Not derived from the request. An invite composed from a dev build would then tell a
# colleague to sign in at localhost, and the whole point of the message is that it is
# the only thing carrying the link - Cognito's own email has no URL in it at all.
# Defaulted to the real address rather than left empty so a missing environment
# variable produces a correct invite instead of a broken one.
#
# `or` rather than a get() default, because CDK sets this variable unconditionally
# and sets it to "" when no domain is configured. An empty string is present as far
# as os.environ is concerned, so a plain default would never fire and the invitation
# would go out with a blank line where the link should be.
APP_URL = (os.environ.get("APP_URL") or "https://planning.qconnect.qwnext.com").rstrip("/")

# IAM principals allowed to call /api/service/*, as full role ARNs.
#
# This is the Aardvark Aap Slack bot and nothing else. It is a SECOND way to reach the
# invite endpoint, alongside the admin-only human route, and it deserves the paranoia:
# an invite writes to the Cognito pool SHARED with the marketing compliance tool.
#
# API Gateway has already refused anyone without execute-api:Invoke on the route
# before Lambda is reached, so this list is the second of two locks rather than the
# only one. It exists because IAM permissions are granted in a different repo, by a
# different deploy, and "who may invite" should be reviewable HERE too.
#
# Empty by default, and empty means the service door is shut. A misconfigured
# environment loses the Slack command; it does not open the endpoint to the account.
SERVICE_CALLER_ARNS = [
    arn.strip()
    for arn in os.environ.get("SERVICE_CALLER_ARNS", "").split(",")
    if arn.strip()
]

# Slack, for the invite picker on the Team page. See app/slack.py.
#
# The token itself is NOT an environment variable in the deployed app. CDK grants the
# Lambda role read access to this secret instead, because a value in a Lambda's
# environment is readable by anyone holding lambda:GetFunctionConfiguration - a much
# wider group than those who can read a secret, and a bot token is a workspace-wide
# credential.
#
# The secret is Aardvark Aap's, and is shared rather than copied: one Slack app, one
# token, rotated in one place. The consequence is that a DM sent from here appears to
# come from Aardvark, which matches its own /roadmap-invite command.
SLACK_SECRET_NAME = os.environ.get("SLACK_SECRET_NAME", "aardvark-app/slack")

# A direct token, for local development and tests only. Checked BEFORE the secret, so
# `demo.py` and pytest never reach for AWS. Empty in every deployed environment.
SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN", "").strip()

# The master switch on the Monday digest. See app/notifications.py.
#
# OFF by default, and this is the second of two switches rather than a duplicate of
# the per-person one. That one answers "do I want this"; this one answers "is this
# deployment allowed to DM real colleagues at all", and the two are different
# questions the moment a second environment exists. A dev stack pointed at the
# production tables would otherwise send the production roster a real digest.
#
# It gates DELIVERY only. The preview endpoint composes the same text with the switch
# off, so the feature can be looked at before it is turned on - which is the whole
# reason the switch is worth having rather than just not deploying the schedule.
DIGEST_ENABLED = os.environ.get("DIGEST_ENABLED", "false").strip().lower() in {
    "1",
    "true",
    "yes",
}

# The same switch again for the Monday/Wednesday progress nudge, and deliberately a
# SEPARATE one rather than a reuse of DIGEST_ENABLED.
#
# The two messages have different audiences and different risk. The digest goes only to
# people who opted in; the nudge goes to every phase owner and DRI whether they asked or
# not, and its buttons write to the roadmap. Turning the milestone reminders on should
# not silently also start DMing ten people twice a week and inviting them to edit data -
# that is a second decision and it gets a second switch.
#
# Off by default, for the reason above and because the button does nothing until
# Aardvark is deployed with a handler for it. A nudge that arrives before then is a
# message asking people to press something inert.
PROGRESS_ENABLED = os.environ.get("PROGRESS_ENABLED", "false").strip().lower() in {
    "1",
    "true",
    "yes",
}

# Where the daily "these RFCs still need reading" post goes, and whether it goes at all.
#
# A channel ID (C…), not a name. chat.postMessage accepts "#name" but resolves it
# server-side in a way that has been deprecated for years and fails differently
# depending on the app's scopes; an ID is stable and cannot be ambiguous. The app must
# also have been INVITED to the channel - being able to post is not the same as being
# a member, and the error when it is not says `not_in_channel` and nothing else.
#
# Empty by default, and the chase refuses to run without it rather than guessing at a
# channel. Posting a list of colleagues who owe a review into the wrong room is not a
# mistake worth risking to save a deploy.
RFC_REVIEW_CHANNEL = os.environ.get("RFC_REVIEW_CHANNEL", "").strip()

# Its own switch again, and for a sharper reason than the other two. This one names
# real people in a public channel every day. Nothing about that should start happening
# as a side effect of turning something else on.
RFC_CHASE_ENABLED = os.environ.get("RFC_CHASE_ENABLED", "false").strip().lower() in {
    "1",
    "true",
    "yes",
}

# A fourth switch, for the day-of milestone check. The pattern is now established and
# the reasoning is the same each time: a new thing that DMs colleagues gets its own
# switch rather than riding on somebody else's.
#
# What is different about this one is what it asks for. The digest tells you what is
# coming, the nudge asks for a percentage; this asks whether a dated commitment was met
# and, if not, why - and it writes the answer into a log other people read. That is a
# heavier thing to start doing to a team by accident than either of the others, so it
# is off by default and stays off until somebody decides otherwise.
#
# Like the nudge, it also needs Aardvark deployed with handlers for its two buttons
# before it is any use. A question with inert buttons is worse than no question.
MILESTONE_CHECK_ENABLED = os.environ.get("MILESTONE_CHECK_ENABLED", "false").strip().lower() in {
    "1",
    "true",
    "yes",
}

# Logging. See the Lambda note in main.py - basicConfig alone does nothing there.
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

# API Configuration
API_TITLE = "Planning Roadmap API"
API_VERSION = "0.1.0"
CORS_ORIGINS = os.environ.get(
    "CORS_ORIGINS", "http://localhost:5173,http://localhost:3000"
).split(",")
