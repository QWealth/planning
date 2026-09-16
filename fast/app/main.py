"""FastAPI application for the planning roadmap."""

import logging
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mangum import Mangum

from app import config
from app.routes import (
    digest,
    identity,
    milestone_log,
    people,
    projects,
    roadmap,
    service,
    slack,
    work,
)

# Configure logging.
#
# basicConfig() alone is silently useless in Lambda: the runtime attaches its own
# handler to the root logger before this module is imported, and basicConfig()
# returns without doing anything when the root logger already has handlers. The root
# level stays at the runtime default of WARNING, so every logger.info in this
# codebase is discarded, and the log stream holds nothing but START/END/REPORT.
#
# Setting the level on the root logger explicitly works in both environments,
# whether or not a handler already exists. basicConfig() is still called first so
# local runs get a handler and a format.
logging.basicConfig(level=config.LOG_LEVEL)
logging.getLogger().setLevel(config.LOG_LEVEL)
logger = logging.getLogger(__name__)

app = FastAPI(
    title=config.API_TITLE,
    version=config.API_VERSION,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers. identity is the only one not behind the planning-group check - see its
# docstring for why a refused user still needs to be able to ask why.
app.include_router(identity.router)
app.include_router(people.router)
app.include_router(people.skills_router)
app.include_router(people.roles_router)
app.include_router(projects.router)
app.include_router(roadmap.router)

# The Monday digest, read-only: it shows a person their own message and sends nothing.
# The job that actually sends is app/notifications.py, invoked by EventBridge rather
# than through here.
app.include_router(digest.router)

# The milestone-check log. The only route in the app gated on a ROSTER ROLE rather
# than on a Cognito group - routes/milestone_log.py opens by explaining why that is
# a weaker gate than it looks and why it is the right one here anyway.
app.include_router(milestone_log.router)

# RFCs and tasks. Two routers over one table - see routes/work.py for why the two
# kinds do not share a prefix even though they share every access pattern.
app.include_router(work.router)
app.include_router(work.tasks_router)

# The Slack directory the invite picker is built from. Read-only and admin-only, and
# it creates no roster rows - see routes/slack.py for why that separation matters.
app.include_router(slack.router)

# The only router not reached by a signed-in human. IAM-authorized rather than
# Cognito-authorized, for the Slack bot - see routes/service.py, which is short and
# worth reading before anything is added to it.
app.include_router(service.router)


@app.get("/health")
async def health_check() -> dict[str, Any]:
    """
    Health check.

    Unauthenticated, and it must stay that way: this is what a load balancer or
    uptime monitor calls, and neither of those holds a Cognito token. It deliberately
    reports nothing about the data or the configuration.
    """
    return {"status": "ok", "service": "planning-roadmap"}


@app.get("/")
async def root() -> dict[str, Any]:
    """Root endpoint."""
    return {
        "service": config.API_TITLE,
        "version": config.API_VERSION,
        "status": "running",
    }


@app.exception_handler(Exception)
async def global_exception_handler(request: Any, exc: Exception) -> JSONResponse:
    """
    Catch-all handler.

    The detail is deliberately generic. Returning str(exc) would leak table names
    and boto3 internals to the browser, and the full traceback is in CloudWatch
    where it is useful and not readable by the caller.
    """
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


handler = Mangum(app, lifespan="off")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
