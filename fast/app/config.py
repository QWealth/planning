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

# Logging. See the Lambda note in main.py - basicConfig alone does nothing there.
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

# API Configuration
API_TITLE = "Planning Roadmap API"
API_VERSION = "0.1.0"
CORS_ORIGINS = os.environ.get(
    "CORS_ORIGINS", "http://localhost:5173,http://localhost:3000"
).split(",")
