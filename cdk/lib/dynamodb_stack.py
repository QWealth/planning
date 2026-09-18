"""The four tables the roadmap API reads and writes, and the bucket it puts files in.

Key schemas here must match app/db/models.py and app/config.py exactly. They are
repeated in demo.py's create_tables() as well, which is the one duplication worth
having: the demo has to build the same tables in moto without importing CDK.
"""

import aws_cdk as cdk
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_s3 as s3
from constructs import Construct


class DynamoDBStack(cdk.Stack):
    """Projects+phases, people, the work table, the audit log, and task attachments."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        # Where the browser uploads from. The API's CORS list, reused rather than
        # restated: a bucket that allows an origin the API refuses is a bucket with a
        # rule nothing can use, and the reverse is an upload that fails in the browser
        # with a message about preflight that says nothing about the cause.
        cors_origins: list,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # Projects and their phases, single-table.
        #
        # sk is "#PROJECT" for the project row and "PHASE#<phase_id>" for each phase.
        # "#" (0x23) sorts before "P" (0x50), so a single Query on project_id returns
        # the project first and then its phases in one round trip - which is exactly
        # the shape the roadmap screen needs. Two tables would turn drawing nine lanes
        # into a fan-out of nine queries plus nine more.
        self.projects_table = dynamodb.Table(
            self,
            "ProjectsTable",
            partition_key=dynamodb.Attribute(
                name="project_id", type=dynamodb.AttributeType.STRING
            ),
            sort_key=dynamodb.Attribute(name="sk", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            point_in_time_recovery=True,
            # RETAIN, not DESTROY. This table is the successor to a workbook that
            # exists in exactly one copy on one laptop; a `cdk destroy` that silently
            # took the roadmap with it would recreate the original problem in a more
            # expensive form. The orphaned table has to be deleted by hand, which is
            # the point.
            removal_policy=cdk.RemovalPolicy.RETAIN,
            table_name="planning-roadmap-projects",
        )

        # The roster. Partitioned on email because that is what a Cognito token
        # carries, so "who is the logged-in user" is a GetItem and never a Scan.
        # Addresses are lowercased at the schema layer - DynamoDB keys are
        # case-sensitive and Cognito is not. See schemas/people.py.
        self.people_table = dynamodb.Table(
            self,
            "PeopleTable",
            partition_key=dynamodb.Attribute(name="email", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            point_in_time_recovery=True,
            removal_policy=cdk.RemovalPolicy.RETAIN,
            table_name="planning-roadmap-people",
        )

        # RFCs and tasks: everything that is written down but is not on the Gantt.
        #
        # A SEPARATE TABLE, for two concrete reasons rather than tidiness:
        #
        # 1. `list_projects` scans the projects table whole and groups in memory. Put
        #    RFCs and tasks in there and every roadmap load reads and discards them,
        #    so the chart gets slower in proportion to how much the team writes down -
        #    two things that should have nothing to do with each other.
        # 2. In that table `project_id` is the PARTITION KEY, so "an RFC attached to
        #    no project" is unrepresentable without inventing a sentinel partition.
        #    Here project_id is an ordinary nullable attribute and the answer is just
        #    null, which is the rule the rest of this app already runs on.
        #
        # One table for both kinds rather than two, because an RFC and a task differ
        # by about four fields and share every access pattern. `kind` discriminates.
        #
        # `sk` is fixed at "#ITEM" today and nothing reads it. It is here because a
        # sort key cannot be added to a live table, only migrated to, and an RFC in
        # state "In review" implies reviewers, which implies comments, which need a
        # child row. The projects table taught that lesson once already; the second
        # key costs nothing until it is needed and cannot be retrofitted when it is.
        self.work_table = dynamodb.Table(
            self,
            "WorkTable",
            partition_key=dynamodb.Attribute(name="item_id", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="sk", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            point_in_time_recovery=True,
            # RETAIN for the same reason the projects table is. An RFC is the written
            # record of a decision and the reasoning behind it, which is the least
            # reproducible thing in this account.
            removal_policy=cdk.RemovalPolicy.RETAIN,
            table_name="planning-roadmap-work",
        )

        # "every RFC" / "every task", one Query each. Name must match
        # config.WORK_BY_KIND_INDEX.
        #
        # Two partitions for the whole table, which is a hot-partition shape and is
        # deliberate here: this is an internal board for one team, the ceiling is
        # hundreds of rows, and a partition holds 10GB of text before it complains.
        # Sorting on updated_at means the list pages get "most recently touched first"
        # out of the key schema rather than out of an in-memory sort.
        #
        # Deliberately NO second index on project_id. "What is attached to this
        # project" filters the kind query in memory - the same call list_projects
        # already makes, correct at the same scale. Add the index when one kind stops
        # fitting in a page or two, not before.
        self.work_table.add_global_secondary_index(
            index_name="kind-updated-index",
            partition_key=dynamodb.Attribute(name="kind", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="updated_at", type=dynamodb.AttributeType.STRING),
            projection_type=dynamodb.ProjectionType.ALL,
        )

        # Audit log, partitioned on the thing that changed.
        #
        # Deliberately NOT the marketing tool's shape, and its own config.py records
        # why: that table is partitioned on `timestamp` alone, so every item lands in
        # a partition of its own and there is no key to query by. "What happened to
        # this rule" is a full table Scan there, and the scan gets slower and dearer
        # every week forever.
        #
        # The first question anyone asks of a roadmap is "who moved this date", which
        # is the history of one entity, so entity_id is the partition key and the
        # answer is one Query against one partition - the same cost in year three as
        # in week one. The GSI answers the second question, "what changed lately",
        # across all entities of a kind.
        #
        # No TTL attribute. The marketing audit table expires its rows; this one must
        # not, because the reason a date slipped is worth more two years later than
        # two weeks later, and it is a few hundred bytes a change.
        self.audit_table = dynamodb.Table(
            self,
            "AuditTable",
            partition_key=dynamodb.Attribute(
                name="entity_id", type=dynamodb.AttributeType.STRING
            ),
            sort_key=dynamodb.Attribute(name="timestamp", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            point_in_time_recovery=True,
            removal_policy=cdk.RemovalPolicy.RETAIN,
            table_name="planning-roadmap-audit",
        )

        # entity is "project" / "phase" / "person" / "assignment" - see
        # AuditLogModel. Name must match config.AUDIT_BY_ENTITY_INDEX.
        self.audit_table.add_global_secondary_index(
            index_name="entity-timestamp-index",
            partition_key=dynamodb.Attribute(name="entity", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="timestamp", type=dynamodb.AttributeType.STRING),
            projection_type=dynamodb.ProjectionType.ALL,
        )

        # Task attachments. Files rather than rows, so a bucket rather than a table -
        # but it lives in the DATA stack with the tables for the reason they are here:
        # it holds things people uploaded and would be sorry to lose, and stacks that
        # hold those are the ones that keep RETAIN.
        #
        # PRIVATE, WITH NO EXCEPTIONS. Everything reaches it through a presigned URL
        # minted by the API for a caller it has already authenticated; nothing is
        # readable by a URL somebody guesses or forwards after it expires. That is the
        # whole security model for this feature, so it is stated where the bucket is
        # made rather than inferred from four defaults.
        self.attachments_bucket = s3.Bucket(
            self,
            "AttachmentsBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            # Versioned, because the delete route removes the metadata row and the
            # object, and "somebody deleted the wrong attachment" is recoverable from a
            # version and not from anything else. The metadata row is gone either way -
            # this buys the file back, not the reference to it.
            versioned=True,
            removal_policy=cdk.RemovalPolicy.RETAIN,
            cors=[
                s3.CorsRule(
                    # The browser PUTs the file straight to S3 rather than through the
                    # API, so S3 itself has to allow the request. Uploading through
                    # Lambda would cap every attachment at the 6MB payload limit and
                    # spend Lambda time being a pipe.
                    allowed_methods=[s3.HttpMethods.PUT],
                    allowed_origins=cors_origins,
                    allowed_headers=["*"],
                    max_age=3000,
                )
            ],
            lifecycle_rules=[
                s3.LifecycleRule(
                    # An upload that was presigned and never completed leaves nothing,
                    # but a multipart one leaves parts that are billed and invisible.
                    abort_incomplete_multipart_upload_after=cdk.Duration.days(7),
                    # Old versions are the undo above, not an archive. A year is long
                    # enough that anybody who noticed would have noticed.
                    noncurrent_version_expiration=cdk.Duration.days(365),
                )
            ],
        )

        for name, table in (
            ("ProjectsTableName", self.projects_table),
            ("PeopleTableName", self.people_table),
            ("WorkTableName", self.work_table),
            ("AuditTableName", self.audit_table),
        ):
            cdk.CfnOutput(self, name, value=table.table_name)

        cdk.CfnOutput(
            self, "AttachmentsBucketName", value=self.attachments_bucket.bucket_name
        )
