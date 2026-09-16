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
    aws_scheduler as scheduler,
    aws_scheduler_targets as scheduler_targets,
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
        work_table: dynamodb.ITable,
        audit_table: dynamodb.ITable,
        user_pool: cognito.IUserPool,
        env_name: str,
        required_group: str,
        enforce_group: bool,
        admin_group: str,
        cors_origins: str,
        require_auth: bool = True,
        app_url: str = "",
        service_caller_arns: str = "",
        slack_secret_name: str = "",
        digest_enabled: bool = False,
        progress_enabled: bool = False,
        milestone_check_enabled: bool = False,
        rfc_chase_enabled: bool = False,
        rfc_review_channel: str = "",
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

        # Read/write on all four tables. grant_read_write_data covers each table's
        # GSIs too, which a hand-written policy usually forgets - a Query on an index
        # needs the index ARN, not just the table's, and the failure shows up only on
        # the routes that use one: "what changed lately" on the audit table, and every
        # RFC and task list page on the work table.
        for table in (projects_table, people_table, work_table, audit_table):
            table.grant_read_write_data(lambda_role)

        # Four Cognito admin verbs, and no more.
        #
        # This used to say "no Cognito admin verbs at all", on the grounds that the
        # pool was populated by the compliance tool's invite flow. It no longer is:
        # POST /api/people/invite creates the login here, because asking an admin to
        # go and use a different app to grant access to this one was the reason
        # nobody got access. See fast/app/cognito.py.
        #
        # Scoped to this one pool's ARN rather than "*". The pool is IMPORTED, not
        # owned by this stack (cognito_stack.py), and it is shared with the marketing
        # compliance tool - so a wildcard here would be a grant over somebody else's
        # production identity store, handed out by a stack that has no business
        # touching it.
        #
        # AdminCreateUser and AdminAddUserToGroup are the write half. The two reads
        # are not padding: ListGroupsForUser is what makes an invite idempotent
        # instead of a blind write, and GetUser answers "does this person already
        # have a login" - which is the first question asked when an invite fails.
        #
        # Notably absent, and to stay absent: AdminDeleteUser, AdminSetUserPassword,
        # AdminRemoveUserFromGroup, AdminUpdateUserAttributes. Nothing in this app
        # revokes or reassigns a login, and on a shared pool the blast radius of a
        # bug in code that could would reach the compliance tool's users.
        lambda_role.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "cognito-idp:AdminCreateUser",
                    "cognito-idp:AdminAddUserToGroup",
                    "cognito-idp:AdminListGroupsForUser",
                    "cognito-idp:AdminGetUser",
                ],
                resources=[user_pool.user_pool_arn],
            )
        )

        # Read the Slack bot token, and nothing else in Secrets Manager.
        #
        # The secret belongs to Aardvark Aap and is SHARED rather than copied: one
        # Slack app, one token, rotated in one place. Copying it would produce a second
        # value that looks identical until the day the first is revoked.
        #
        # GetSecretValue only - no write, no rotation, no list. And scoped to this one
        # secret's ARN with a six-character suffix wildcard, because Secrets Manager
        # appends a random suffix to every ARN and a policy written without it matches
        # nothing at all. Broadening to "*" would be a grant over every secret in the
        # account, including the RDS and Redshift credentials that live beside it.
        #
        # The token is deliberately NOT passed as an environment variable: anything in
        # a Lambda's environment is readable with lambda:GetFunctionConfiguration, which
        # is a far wider audience than those who can read a secret. See app/slack.py.
        # Skipped entirely when no secret is named, rather than granted over an ARN
        # built from an empty string - which would deploy a statement matching nothing
        # and read, to anybody auditing it later, as though access had been intended.
        slack_secret_arn = (
            f"arn:aws:secretsmanager:{self.region}:{self.account}"
            f":secret:{slack_secret_name}-??????"
            if slack_secret_name
            else ""
        )
        if slack_secret_arn:
            lambda_role.add_to_policy(
                iam.PolicyStatement(
                    actions=["secretsmanager:GetSecretValue"],
                    resources=[slack_secret_arn],
                )
            )

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
                "WORK_TABLE_NAME": work_table.table_name,
                "WORK_BY_KIND_INDEX": "kind-updated-index",
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
                # The link inside an invitation. Not derived from the request: an
                # invite is composed server-side precisely so that whoever triggers it
                # - the Team page or the Slack bot - sends the same, correct address.
                "APP_URL": app_url,
                # Who may use the IAM-authorized /api/service/* door. Empty deploys a
                # closed door, which is the right way for this to be misconfigured.
                "SERVICE_CALLER_ARNS": service_caller_arns,
                # WHERE the Slack token is, never the token itself. Empty disables the
                # invite picker and the DM; invites still work by typed address, which
                # is what the app did before Slack was involved at all.
                "SLACK_SECRET_NAME": slack_secret_name,
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

        # ------------------------------------------------------------------------
        # The Monday digest
        # ------------------------------------------------------------------------
        #
        # A SECOND function off the SAME image, with the CMD overridden. Not a second
        # build, and not a copy of the app in a zip: the job reads the roadmap through
        # the same query modules the API does, so a separately built artefact is how a
        # scheduled message ends up describing last month's schema. One image, two
        # entry points, one deploy.
        #
        # Its own ROLE, though, and that is the part worth keeping. The API's role can
        # create Cognito users - it has to, for invitations. Nothing about sending a
        # digest needs that, and a scheduled job running unattended every week with
        # standing permission to create logins on the pool SHARED with the compliance
        # tool is a blast radius bought for nothing.
        digest_role = iam.Role(
            self,
            "DigestRole",
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name(
                    "service-role/AWSLambdaBasicExecutionRole"
                )
            ],
        )

        # Read the roadmap and the roster; the digest never edits either. The audit
        # table is the one exception and it is read-WRITE, because the deduplication
        # that stops a retried run sending a colleague the same DM twice is a
        # conditional put onto it. See fast/app/db/queries/audit.py:claim_once.
        projects_table.grant_read_data(digest_role)
        people_table.grant_read_data(digest_role)
        audit_table.grant_read_write_data(digest_role)

        if slack_secret_arn:
            digest_role.add_to_policy(
                iam.PolicyStatement(
                    actions=["secretsmanager:GetSecretValue"],
                    resources=[slack_secret_arn],
                )
            )

        self.digest_function = lambda_.DockerImageFunction(
            self,
            "RoadmapDigestFunction",
            code=lambda_.DockerImageCode.from_ecr(
                repository=image_asset.repository,
                tag=image_asset.image_tag,
                # The whole reason one image can serve both. Overrides the Dockerfile's
                # CMD of app.main.handler, which is the Mangum-wrapped API.
                cmd=["app.notifications.lambda_handler"],
            ),
            role=digest_role,
            architecture=lambda_.Architecture.ARM_64,
            memory_size=512,
            # Longer than the API's 30s on purpose. This one lists every Slack workspace
            # member and then sends a DM per recipient, serially - a run is a handful of
            # HTTP round trips per person, and timing out halfway would leave some weeks
            # claimed and undelivered.
            timeout=cdk.Duration.minutes(5),
            environment={
                "PROJECTS_TABLE_NAME": projects_table.table_name,
                "PEOPLE_TABLE_NAME": people_table.table_name,
                "AUDIT_TABLE_NAME": audit_table.table_name,
                "AUDIT_BY_ENTITY_INDEX": "entity-timestamp-index",
                "SLACK_SECRET_NAME": slack_secret_name,
                # The master switch, and the reason the schedule can be deployed before
                # anybody has agreed to be messaged. Off means the function still runs
                # on Monday and still logs what it WOULD have done, and sends nothing.
                "DIGEST_ENABLED": "true" if digest_enabled else "false",
                # The progress nudge's own switch, separate from the digest's. The
                # two messages have different audiences and different risk: the
                # digest goes only to people who opted in, the nudge goes to every
                # phase owner and DRI whether they asked or not, and its buttons
                # write to the roadmap. Turning one on must not turn the other on.
                "PROGRESS_ENABLED": "true" if progress_enabled else "false",
                # The third switch, and the one guarding the loudest thing this function
                # does: naming colleagues in a public channel, daily. Nothing about that
                # should start as a side effect of turning the other two on.
                "RFC_CHASE_ENABLED": "true" if rfc_chase_enabled else "false",
                # The fourth, for the day-of milestone check. Its own switch for the
                # same reason as the others, and one more: this is the only scheduled
                # message that writes a colleague's stated reason into a log other
                # people read, which is not a thing to start doing as a side effect.
                "MILESTONE_CHECK_ENABLED": "true" if milestone_check_enabled else "false",
                # A channel ID, not a name, and empty means the chase refuses to run.
                # See config.RFC_REVIEW_CHANNEL - the app must also have been invited to
                # the channel, which is not something a deploy can do.
                "RFC_REVIEW_CHANNEL": rfc_review_channel,
                "LOG_LEVEL": "INFO",
                # No COGNITO_USER_POOL_ID, no SERVICE_CALLER_ARNS, no CORS_ORIGINS and
                # no group settings: this function answers no requests and has no
                # callers, so every one of those would be configuration that cannot
                # affect anything, read later as though it could.
            },
            log_group=logs.LogGroup(
                self,
                "DigestLogGroup",
                retention=logs.RetentionDays.ONE_MONTH,
                removal_policy=cdk.RemovalPolicy.DESTROY,
            ),
        )

        # EventBridge Scheduler rather than an Events rule, for one reason: a rule's
        # cron is UTC only, so "08:00 Monday" would arrive at 08:00 for half the year
        # and 09:00 for the other half as Toronto moves on and off daylight saving.
        # Scheduler takes the timezone and does the arithmetic.
        #
        # 08:00 America/Toronto is chosen to land before the working day rather than
        # during it. A digest read at the moment somebody is deciding what their week
        # looks like is the only moment it is actionable - see fast/app/digest.py.
        scheduler.Schedule(
            self,
            "DigestSchedule",
            schedule=scheduler.ScheduleExpression.cron(
                week_day="MON",
                hour="8",
                minute="0",
                time_zone=cdk.TimeZone.AMERICA_TORONTO,
            ),
            target=scheduler_targets.LambdaInvoke(
                self.digest_function,
                # No retries. Scheduler's default is 185 attempts over 24 hours, which
                # for this target is exactly wrong: the function already swallows its
                # own per-person failures and returns a summary, so it almost never
                # reports an error - and when it genuinely does, a retry is a second
                # pass over people who may already have been messaged. The week claim
                # in the audit table is what makes that safe, and it should not have
                # to be.
                retry_attempts=0,
            ),
            description="Weekly milestone digest to project DRIs",
        )

        # The progress nudge, on the SAME function as the digest.
        #
        # One function, several schedules, told apart by the `job` in the payload. They
        # share an image, a role and exactly the same table permissions, so a second
        # function would be three more things to keep in step for no gain - and the
        # image is already built once and pointed at twice (see the API function above).
        #
        # Twice a week rather than weekly, and 09:00 rather than the digest's 08:00.
        # The digest is read before the day starts and says what is coming; this one
        # asks for something back, so it lands once people are actually at a keyboard.
        # An hour apart on Monday also keeps the two from arriving as one clump of
        # notifications, which is how a bot stops being read.
        #
        # MON,WED in one schedule rather than two: the expression supports a list, and
        # two schedules would be two places to edit the hour.
        scheduler.Schedule(
            self,
            "ProgressNudgeSchedule",
            schedule=scheduler.ScheduleExpression.cron(
                week_day="MON,WED",
                hour="9",
                minute="0",
                time_zone=cdk.TimeZone.AMERICA_TORONTO,
            ),
            target=scheduler_targets.LambdaInvoke(
                self.digest_function,
                # What tells the handler which job this is. Without it the invocation
                # defaults to the digest, which would send milestone reminders on a
                # Wednesday morning - see notifications.lambda_handler.
                input=scheduler.ScheduleTargetInput.from_object({"job": "progress"}),
                # Same reasoning as the digest's: the function swallows its own
                # per-person failures, so a retry is a second pass over people who may
                # already have been messaged. The per-DAY claim makes that safe and
                # should not have to.
                retry_attempts=0,
            ),
            description="Monday/Wednesday progress nudge to phase owners and DRIs",
        )

        # The day-of milestone check, weekday mornings.
        #
        # MON-FRI, and 09:15 - between the progress nudge at 09:00 and the RFC chase at
        # 09:30. Fifteen minutes rather than the thirty separating the other two because
        # this one is usually silent: most people have no milestone dated today, so on
        # most mornings it is not a third interruption at all. When it is, it is the
        # most time-sensitive of the three - the question is about today.
        #
        # Weekdays only, with the job itself covering the weekend. A Saturday deadline
        # is asked about on the Monday, because a Sunday DM about it is a question
        # nobody is there to answer and one that has scrolled away by the time they are.
        # See milestone_check.window, which is what makes the two halves line up.
        scheduler.Schedule(
            self,
            "MilestoneCheckSchedule",
            schedule=scheduler.ScheduleExpression.cron(
                week_day="MON-FRI",
                hour="9",
                minute="15",
                time_zone=cdk.TimeZone.AMERICA_TORONTO,
            ),
            target=scheduler_targets.LambdaInvoke(
                self.digest_function,
                input=scheduler.ScheduleTargetInput.from_object({"job": "milestone-check"}),
                # Same reasoning as the other three: the run claims the day per person
                # before it sends, so a retry cannot double-ask, and it should not have
                # to rely on that.
                retry_attempts=0,
            ),
            description="Weekday day-of milestone check to project DRIs",
        )

        # The RFC read-chase, weekday mornings.
        #
        # MON-FRI rather than daily, because the chase counts in WORKING days and stops
        # after five of them - a weekend post would be noise nobody is there to act on
        # while spending none of the budget it appears to spend.
        #
        # 09:30 puts it after the progress nudge rather than alongside it. Two bot
        # messages arriving together read as one interruption and the second is the one
        # that gets skimmed; half an hour apart they are two things.
        scheduler.Schedule(
            self,
            "RfcChaseSchedule",
            schedule=scheduler.ScheduleExpression.cron(
                week_day="MON-FRI",
                hour="9",
                minute="30",
                time_zone=cdk.TimeZone.AMERICA_TORONTO,
            ),
            target=scheduler_targets.LambdaInvoke(
                self.digest_function,
                input=scheduler.ScheduleTargetInput.from_object({"job": "rfc-chase"}),
                # Same reasoning as the other two: the run claims the day before it
                # posts, so a retry cannot double-post, and it should not have to.
                retry_attempts=0,
            ),
            description="Daily #request_for_comments chase for unread RFCs",
        )

        cdk.CfnOutput(
            self, "DigestFunctionName", value=self.digest_function.function_name
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

        # /api/service/* is authorized by IAM instead of Cognito, for the Aardvark Aap
        # Slack bot - an ECS task in this account, which has no Cognito token and
        # cannot get one. See fast/app/routes/service.py.
        #
        # A method carries exactly one authorizer, so this could not be a flag on
        # /api/people/invite; it had to be a second path. And declaring a literal
        # "service" child is precisely the trap described above: it beats the
        # /api/{proxy+} sibling for /api/service/anything, so WITHOUT its own
        # {proxy+} below, /api/service/invite would resolve to nothing at all - a
        # 403 in the deployed environment that looks like an auth bug and is not.
        #
        # IAM regardless of `require_auth`. That flag turning the Cognito authorizer
        # off is a deliberate local-ish posture for the human routes; it is not a
        # reason to expose a door that writes to the shared pool.
        service_options = {"authorization_type": apigateway.AuthorizationType.IAM}
        service_resource = api_resource.add_resource("service")
        service_resource.add_method("ANY", lambda_integration, **service_options)
        service_resource.add_resource("{proxy+}").add_method(
            "ANY", lambda_integration, **service_options
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
