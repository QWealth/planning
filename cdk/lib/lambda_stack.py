"""The FastAPI backend on Lambda, behind a REST API."""

import os

import aws_cdk as cdk
from aws_cdk import (
    aws_apigateway as apigateway,
    aws_cognito as cognito,
    aws_dynamodb as dynamodb,
    aws_ecr_assets as ecr_assets,
    aws_iam as iam,
    aws_lambda as lambda_,
    aws_logs as logs,
)
from constructs import Construct


class LambdaStack(cdk.Stack):
    """Container-image Lambda + API Gateway REST API."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        projects_table: dynamodb.ITable,
        people_table: dynamodb.ITable,
        audit_table: dynamodb.ITable,
        user_pool: cognito.IUserPool,
        env_name: str,
        required_group: str,
        enforce_group: bool,
        admin_group: str,
        cors_origins: str,
        require_auth: bool = True,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        lambda_role = iam.Role(
            self,
            "LambdaRole",
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name(
                    "service-role/AWSLambdaBasicExecutionRole"
                )
            ],
        )

        # Read/write on all three tables. grant_read_write_data covers the audit
        # table's GSI too, which a hand-written policy usually forgets - a Query on
        # an index needs the index ARN, not just the table's, and the failure shows
        # up only on the "what changed lately" route.
        for table in (projects_table, people_table, audit_table):
            table.grant_read_write_data(lambda_role)

        # Nothing else. No Bedrock, no Cognito admin verbs: this API never creates a
        # user (the pool is populated by the compliance tool's invite flow) and never
        # calls a model. An unused grant is a standing invitation.

        # The platform must be pinned. Without it Docker builds for the host, so a
        # deploy from an Apple Silicon machine produces an arm64 image; if the
        # function were x86_64 it would fail at startup with Runtime.InvalidEntrypoint
        # and the error would say nothing about architecture. Pinned here and matched
        # on the function below, so the result does not depend on who runs deploy.
        image_asset = ecr_assets.DockerImageAsset(
            self,
            "RoadmapAPIImage",
            directory=os.path.join(os.path.dirname(__file__), "..", "..", "fast"),
            file="Dockerfile",
            platform=ecr_assets.Platform.LINUX_ARM64,
            invalidation=ecr_assets.DockerImageAssetInvalidationOptions(build_args=True),
        )

        self.lambda_function = lambda_.DockerImageFunction(
            self,
            "RoadmapAPIFunction",
            code=lambda_.DockerImageCode.from_ecr(
                repository=image_asset.repository,
                tag=image_asset.image_tag,
            ),
            role=lambda_role,
            # Must match the image platform pinned above.
            architecture=lambda_.Architecture.ARM_64,
            # 512MB, not the compliance tool's 3008. That one runs concurrent Bedrock
            # calls; this one assembles JSON from at most a few hundred DynamoDB
            # items. Memory also buys CPU on Lambda, and 512 is where the cold start
            # of importing FastAPI plus boto3 stops improving much.
            memory_size=512,
            timeout=cdk.Duration.seconds(30),
            environment={
                "PROJECTS_TABLE_NAME": projects_table.table_name,
                "PEOPLE_TABLE_NAME": people_table.table_name,
                "AUDIT_TABLE_NAME": audit_table.table_name,
                "AUDIT_BY_ENTITY_INDEX": "entity-timestamp-index",
                "COGNITO_USER_POOL_ID": user_pool.user_pool_id,
                # The two halves of the authorization story. REQUIRED_GROUP names the
                # group; ENFORCE_GROUP decides whether missing it is fatal. Both are
                # set explicitly rather than left to the code defaults so the deployed
                # posture is readable here, in the stack, and not only in config.py.
                "REQUIRED_GROUP": required_group,
                "ENFORCE_GROUP": "true" if enforce_group else "false",
                # A separate axis from the two above, not a third setting of the same
                # dial: those answer "may you use this app", this answers "may you act
                # on somebody other than yourself" on the roster. It stays enforced
                # even when ENFORCE_GROUP is off, which is the current posture - see
                # the _group_comment in cdk.json.
                "ADMIN_GROUP": admin_group,
                "CORS_ORIGINS": cors_origins,
                "LOG_LEVEL": "INFO",
                # Deliberately absent: DEV_AUTH_BYPASS, and DEV_ADMIN with it. app/auth.py
                # honours both, and setting either here would make every request appear to
                # come from one address - an admin one, in DEV_ADMIN's case - while looking,
                # from the outside, exactly like a working deployment. They belong in
                # run.sh and nowhere else.
            },
            log_group=logs.LogGroup(
                self,
                "LogGroup",
                retention=logs.RetentionDays.ONE_MONTH,
                removal_policy=cdk.RemovalPolicy.DESTROY,
            ),
        )

        self.api = apigateway.RestApi(
            self,
            "RoadmapAPI",
            rest_api_name=f"planning-roadmap-api-{env_name}",
            description="Planning Roadmap API",
            deploy_options=apigateway.StageOptions(
                # Off by default in API Gateway, and worth the few cents: without it
                # a 502 from a bad image tag or a 403 from the authorizer is
                # indistinguishable from the API being down, because nothing is
                # logged anywhere the caller or the operator can see.
                metrics_enabled=True,
            ),
        )

        lambda_integration = apigateway.LambdaIntegration(self.lambda_function)

        # The authorizer validates signature, expiry and audience before the request
        # reaches Lambda, so FastAPI never parses a JWT - it reads already-verified
        # claims out of the request context (app/auth.py).
        #
        # It authenticates. It does not authorize. On a shared pool that distinction
        # is the entire security model, and the group check inside the app is the
        # half that does the authorizing. Turning require_auth off leaves the roadmap
        # open to the internet: the app-side check reads claims the authorizer would
        # have put there, and with no authorizer there are no claims.
        method_options = {}
        if require_auth:
            authorizer = apigateway.CognitoUserPoolsAuthorizer(
                self,
                "RoadmapAuthorizer",
                cognito_user_pools=[user_pool],
            )
            method_options = {
                "authorizer": authorizer,
                "authorization_type": apigateway.AuthorizationType.COGNITO,
            }

        # /health stays open, and it is the only thing that does.
        #
        # It reports a literal {"status": "ok"} and nothing about the data or the
        # configuration - see app/main.py. An uptime monitor holds no Cognito token,
        # so gating this would mean the only way to learn the API is down is a person
        # complaining.
        self.api.root.add_resource("health").add_method("GET", lambda_integration)

        # Everything else is authorized, and the resource tree has to be spelled out
        # rather than left to a single greedy root proxy.
        #
        # API Gateway matches a path one segment at a time and prefers a literal
        # child over a {proxy+} sibling. Declaring "health" above creates a literal
        # child of the root, which is fine on its own - but the same rule is what
        # makes the /api branch below necessary in full. Adding a literal "api"
        # resource stops deeper paths falling back to the root proxy, so without
        # /api/{proxy+} declared alongside it, /api/roadmap would resolve to nothing.
        # That failure appears only in the deployed environment and looks like an
        # authorization problem rather than a routing one.
        api_resource = self.api.root.add_resource("api")
        api_resource.add_method("ANY", lambda_integration, **method_options)
        api_resource.add_resource("{proxy+}").add_method(
            "ANY", lambda_integration, **method_options
        )

        # /, /docs, /openapi.json and anything else FastAPI serves. Authorized on
        # purpose, including the docs: the OpenAPI schema names every route and every
        # field of the roadmap, which is not a thing to publish because it is
        # convenient for the browser.
        self.api.root.add_method("ANY", lambda_integration, **method_options)
        self.api.root.add_resource("{proxy+}").add_method(
            "ANY", lambda_integration, **method_options
        )

        cdk.CfnOutput(self, "APIEndpoint", value=self.api.url)
        cdk.CfnOutput(self, "LambdaFunctionName", value=self.lambda_function.function_name)
