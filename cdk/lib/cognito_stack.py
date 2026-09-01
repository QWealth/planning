"""Sign-in for the roadmap, on the compliance tool's existing user pool.

WHY REUSE A POOL AT ALL
-----------------------
Because the alternative is a second set of credentials and a second MFA enrolment
for the same twelve people, and a roster that drifts the moment someone leaves. The
pool at ca-central-1_P8orSDvVO is already restricted to @qwealth.com, already
enforces MFA, and already holds the staff who would use this.

WHAT REUSING IT COSTS, AND WHAT PAYS FOR IT
-------------------------------------------
An API Gateway COGNITO_USER_POOLS authorizer *authenticates* and does not
*authorize*. It accepts any unexpired token the pool issued - regardless of which
app client minted it. So attaching it to this API and stopping there would mean
every compliance-tool account can edit the roadmap, and (were the reverse done)
every roadmap account could delete the compliance ruleset. The authorizer cannot
express "only this app's users" because, to Cognito, there is no such thing.

The group below is what makes it express that. app/auth.py refuses any caller whose
cognito:groups does not contain REQUIRED_GROUP, and config.ENFORCE_GROUP defaults
to true so it fails closed: before anyone is added to the group, nobody gets in.
That is the correct direction to fail, and it is only affordable to switch on at the
first deploy - enforcement added to a live system locks people out instead.

THIS STACK OWNS THE GROUP, NOT THE POOL
---------------------------------------
The pool is imported, never defined here, so nothing in this stack can modify or
delete it and a `cdk destroy` cannot take the compliance tool's sign-in with it.
The group and the app client are new resources that this stack does own.

The group deliberately is NOT added to the marketing repo's _GROUPS list, for two
reasons. Deploying that stack right now would also ship whatever uncommitted changes
are sitting in its working tree. And creating it by hand with the AWS CLI is the
exact hand-created-resource mistake that CLAUDE.md documents for Route53 - the next
`cdk deploy` finds a resource it did not create and refuses. Each app owning its own
group means neither stack can surprise the other.
"""

import aws_cdk as cdk
from aws_cdk import aws_cognito as cognito
from constructs import Construct

# The group name. Must match config.REQUIRED_GROUP in the API.
PLANNING_GROUP = "planning"

# Precedence orders roles when a user is in several groups; lowest wins. The
# compliance pool already uses 10 (admin), 20 (compliance) and 30 (marketing), so
# this sits below all of them. That matters in one direction only: a person in both
# `admin` and `planning` still resolves to admin for the compliance tool, which is
# what that tool expects. This API does not read precedence at all - it asks the
# single yes/no question "is `planning` in the list".
PLANNING_GROUP_PRECEDENCE = 40


class CognitoStack(cdk.Stack):
    """The planning group and web client, on an imported pool."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        user_pool_id: str,
        env_name: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # Imported, not defined. from_user_pool_id gives an IUserPool that CDK will
        # not manage: no property of the pool is in this stack's template, so a drift
        # or a destroy here cannot touch it.
        self.user_pool = cognito.UserPool.from_user_pool_id(self, "SharedPool", user_pool_id)

        cognito.CfnUserPoolGroup(
            self,
            "PlanningGroup",
            user_pool_id=user_pool_id,
            group_name=PLANNING_GROUP,
            precedence=PLANNING_GROUP_PRECEDENCE,
            description="May read and edit the planning roadmap.",
        )

        # A client of this app's own, rather than borrowing the compliance tool's.
        #
        # Not a security boundary - the authorizer ignores which client issued a
        # token, which is the whole reason the group check exists. It is an
        # operational one: token lifetimes, and later the callback URLs and refresh
        # policy a frontend needs, can be tuned for this app without changing how
        # long a compliance session lasts.
        self.user_pool_client = cognito.UserPoolClient(
            self,
            "PlanningWebClient",
            user_pool=self.user_pool,
            user_pool_client_name=f"planning-roadmap-web-{env_name}",
            # No secret: this is destined for a browser, where a secret is not one.
            generate_secret=False,
            # SRP only. USER_PASSWORD_AUTH would send the password itself to Cognito
            # and is not needed by anything here - Amplify's Authenticator does SRP,
            # and so does the pycognito-based token helper in fast/get_token.py.
            auth_flows=cognito.AuthFlow(user_srp=True),
            # Short ID token so a revoked account or a removed group membership stops
            # working within the hour, long refresh so a working day of editing does
            # not need a re-login.
            id_token_validity=cdk.Duration.hours(1),
            access_token_validity=cdk.Duration.hours(1),
            refresh_token_validity=cdk.Duration.hours(12),
            prevent_user_existence_errors=True,
        )

        cdk.CfnOutput(self, "UserPoolId", value=user_pool_id)
        cdk.CfnOutput(
            self, "UserPoolClientId", value=self.user_pool_client.user_pool_client_id
        )
        cdk.CfnOutput(self, "RequiredGroup", value=PLANNING_GROUP)
