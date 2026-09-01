#!/usr/bin/env python3
"""CDK entrypoint for the planning roadmap."""

import os
import sys

import aws_cdk as cdk

# So `lib` imports work regardless of where cdk is invoked from.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.planning_roadmap_stack import PlanningRoadmapStack  # noqa: E402

app = cdk.App()

env_name = app.node.try_get_context("env") or "dev"
account = app.node.try_get_context("account") or os.environ.get("CDK_DEFAULT_ACCOUNT")
region = (
    app.node.try_get_context("region")
    or os.environ.get("CDK_DEFAULT_REGION")
    or "ca-central-1"
)

stack = PlanningRoadmapStack(
    app,
    f"PlanningRoadmap-{env_name}",
    env=cdk.Environment(account=account, region=region),
    env_name=env_name,
)

cdk.Tags.of(stack).add("project", "planning-roadmap")
cdk.Tags.of(stack).add("environment", env_name)
cdk.Tags.of(stack).add("managed-by", "cdk")

app.synth()
