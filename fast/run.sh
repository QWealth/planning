#!/bin/bash
# Local development runner for FastAPI.
#
# This talks to REAL AWS: the projects, people and audit tables in ca-central-1,
# using whatever credentials your shell has. There is no local DynamoDB outside the
# test suite, so an IAM identity without dynamodb:Scan on the projects table cannot
# load the roadmap at all - the first request fails with AccessDeniedException.

set -e

echo "Starting Planning Roadmap API..."
cd "$(dirname "$0")"

AWS_REGION="${AWS_REGION:-ca-central-1}"
PROJECTS_TABLE_NAME="${PROJECTS_TABLE_NAME:-planning-roadmap-projects}"
PEOPLE_TABLE_NAME="${PEOPLE_TABLE_NAME:-planning-roadmap-people}"
AUDIT_TABLE_NAME="${AUDIT_TABLE_NAME:-planning-roadmap-audit}"
CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:5173,http://localhost:3000}"

# Local runs have no API Gateway authorizer, so there are no claims and no groups.
# With ENFORCE_GROUP on - the deployed default - every request would be 401 and the
# app would be unusable locally. Turning it off here is what the flag is for; the
# warning it logs on every request is intentional, so this can never be mistaken for
# the deployed configuration.
ENFORCE_GROUP="${ENFORCE_GROUP:-false}"

# Passed through rather than defaulted on. Without this, local edits are attributed
# to "system" in the audit table. Export DEV_AUTH_BYPASS=1 and DEV_USER_EMAIL to
# your own address if you are going to change the roadmap locally; leaving it off is
# the safer default because an on-by-default bypass would also hide a misconfigured
# authorizer in a deployed environment. See app/auth.py.
DEV_AUTH_BYPASS="${DEV_AUTH_BYPASS:-}"
DEV_USER_EMAIL="${DEV_USER_EMAIL:-}"

# Prefer the project venv's interpreter. `python` on a pyenv-managed machine
# resolves to a shim that is very often not the venv, so `python -m uvicorn` fails
# with "No module named uvicorn" even though `pip install -r requirements.txt`
# succeeded a moment earlier.
PYTHON="python"
if [ -x "./venv/bin/python" ]; then
    PYTHON="./venv/bin/python"
fi

AWS_REGION="$AWS_REGION" \
PROJECTS_TABLE_NAME="$PROJECTS_TABLE_NAME" \
PEOPLE_TABLE_NAME="$PEOPLE_TABLE_NAME" \
AUDIT_TABLE_NAME="$AUDIT_TABLE_NAME" \
CORS_ORIGINS="$CORS_ORIGINS" \
ENFORCE_GROUP="$ENFORCE_GROUP" \
DEV_AUTH_BYPASS="$DEV_AUTH_BYPASS" \
DEV_USER_EMAIL="$DEV_USER_EMAIL" \
"$PYTHON" -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
