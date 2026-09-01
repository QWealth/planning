"""Top-level stack: tables, sign-in, API, and the public hostname.

planning.qconnect.qwnext.com nests inside an already-delegated zone, which is the
whole reason it is safe to build. `dig +short NS qconnect.qwnext.com @8.8.8.8`
answers with four Route53 nameservers, so a validation CNAME written there is
visible to ACM. Six certificates in this account are permanently FAILED because
that was not true for intake.qwnext.com and onboarding.qwnext.com - the qwnext.com
apex is served by Cloudflare and the NS records delegating those names to Route53
were never added, so ACM waited 72 hours and gave up. See CLAUDE.md.

There is still no React app. The distribution serves a static placeholder from
web/ until dist/ exists, because an empty origin makes CloudFront answer
AccessDenied XML - indistinguishable, to anyone opening the link, from a broken
deployment.
"""

import aws_cdk as cdk
from constructs import Construct

from .certificate_stack import CertificateStack
from .cognito_stack import PLANNING_GROUP, CognitoStack
from .dynamodb_stack import DynamoDBStack
from .frontend_stack import FrontendStack
from .lambda_stack import LambdaStack


class PlanningRoadmapStack(cdk.Stack):
    """Orchestration."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        env_name: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # Every child gets its region stated outright rather than inheriting it.
        # Cheap here, and it is the thing that has to be true anyway the moment any
        # stack needs cross_region_references - at which point CDK demands an
        # explicit region on both ends of every reference, not just the crossing one.
        child_env = cdk.Environment(account=self.account, region=self.region)

        user_pool_id = self.node.try_get_context("user_pool_id")
        if not user_pool_id:
            raise ValueError("cdk.json must set context.user_pool_id")

        # Whether API Gateway demands a token at all. Separate from the group check
        # below because they fail differently: no authorizer means the API is open to
        # the internet, while a group check with nobody in the group means the API is
        # closed to everyone. Only one of those is safe to get wrong.
        require_auth = bool(self.node.try_get_context("require_auth"))
        enforce_group = bool(self.node.try_get_context("enforce_group"))
        required_group = self.node.try_get_context("required_group") or PLANNING_GROUP
        # Falls back to the API's own default rather than to PLANNING_GROUP: getting
        # this wrong the other way - defaulting the admin group to the group everybody
        # is in - would make the whole team admins, which is the one mistake here that
        # has no visible symptom until somebody deletes a person.
        admin_group = self.node.try_get_context("admin_group") or "admin"
        cors_origins = self.node.try_get_context("cors_origins") or ""
        allow_whole_pool = bool(self.node.try_get_context("allow_whole_pool"))

        if require_auth and not enforce_group and not allow_whole_pool:
            # Not a hypothetical footgun: this combination is a shared pool with the
            # door open. The authorizer would accept any token the compliance pool
            # ever issued, and the app would then wave it through - so every
            # compliance-tool account could edit the roadmap. Refusing at synth is
            # better than discovering it from an audit row.
            #
            # It is a refusal rather than a warning because the state is not visible
            # from anywhere: nothing in the console says "this API trusts a pool it
            # does not own", and the only symptom is somebody who should not be here
            # editing a date. A synth error is the last moment it can be noticed.
            #
            # `allow_whole_pool` is the way to mean it on purpose. Setting it does not
            # make the consequence go away - it makes the consequence a written-down
            # decision in cdk.json instead of an accident, which is all a guard over a
            # deliberate choice can honestly do.
            raise ValueError(
                "require_auth without enforce_group leaves the shared pool "
                "unauthorized: every compliance-tool account would be admitted. "
                "Set context.allow_whole_pool if that is intended. "
                "See lib/cognito_stack.py."
            )

        dynamodb_stack = DynamoDBStack(self, "DynamoDBStack", env=child_env)

        cognito_stack = CognitoStack(
            self,
            "CognitoStack",
            user_pool_id=user_pool_id,
            env_name=env_name,
            env=child_env,
        )

        lambda_stack = LambdaStack(
            self,
            "LambdaStack",
            projects_table=dynamodb_stack.projects_table,
            people_table=dynamodb_stack.people_table,
            audit_table=dynamodb_stack.audit_table,
            user_pool=cognito_stack.user_pool,
            env_name=env_name,
            required_group=required_group,
            enforce_group=enforce_group,
            admin_group=admin_group,
            cors_origins=cors_origins,
            require_auth=require_auth,
            env=child_env,
        )

        # The group has to exist before the API starts refusing people for not being
        # in it. CDK cannot infer this - the dependency runs through a Cognito pool
        # neither stack owns - so it is stated.
        lambda_stack.add_dependency(cognito_stack)

        self.api = lambda_stack.api

        # The public hostname. Optional so that `cdk deploy` still works for someone
        # without Route53 access, or against a name that is not delegated yet - in
        # which case the API's execute-api URL is the whole product and the
        # certificate never gets requested. Unset domain_name means no cert, no
        # distribution, no record.
        domain_name = self.node.try_get_context("domain_name")
        if domain_name:
            hosted_zone_id = self.node.try_get_context("hosted_zone_id")
            zone_name = self.node.try_get_context("zone_name")
            if not hosted_zone_id or not zone_name:
                raise ValueError(
                    "domain_name needs hosted_zone_id and zone_name alongside it."
                )
            if not domain_name.endswith("." + zone_name):
                # A name outside the zone cannot be DNS-validated by this stack, and
                # the failure is a 72-hour ACM timeout rather than a synth error -
                # which is the specific way the six dead certificates in this account
                # were created. Catch it here instead.
                raise ValueError(
                    f"{domain_name} is not inside {zone_name}, so its validation "
                    f"record cannot be written to this zone. See CLAUDE.md on DNS."
                )

            # us-east-1, because CloudFront accepts certificates from nowhere else.
            # cross_region_references is what lets the ca-central-1 frontend stack
            # read the ARN back out; both ends need it, and both need an explicit
            # region, which is why child_env exists above.
            certificate_stack = CertificateStack(
                self,
                "CertificateStack",
                domain_name=domain_name,
                hosted_zone_id=hosted_zone_id,
                zone_name=zone_name,
                env=cdk.Environment(account=self.account, region="us-east-1"),
                cross_region_references=True,
            )

            frontend_stack = FrontendStack(
                self,
                "FrontendStack",
                api_endpoint=lambda_stack.api.url,
                domain_name=domain_name,
                hosted_zone_id=hosted_zone_id,
                zone_name=zone_name,
                certificate_arn=certificate_stack.certificate_arn,
                env=child_env,
                cross_region_references=True,
            )
            frontend_stack.add_dependency(certificate_stack)

            self.distribution = frontend_stack.distribution
