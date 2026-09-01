"""planning.qconnect.qwnext.com: CloudFront in front of S3 and the API.

One hostname serves both the app and the API, on purpose. The alternative - the app
on one name and the API on another - means every request from the browser is
cross-origin, which buys a CORS preflight on every call and a token that has to be
attached across origins. Same-origin removes both problems and is why the /api/*
behaviour below points at API Gateway rather than at a second hostname.

Adapted from marketing_compliance_review/cdk/lib/frontend_stack.py. The comments
that came with it are reproduced where they still apply, because each one is a bug
somebody already paid for.
"""

import os
from typing import Optional
from urllib.parse import urlparse

import aws_cdk as cdk
from aws_cdk import (
    aws_certificatemanager as acm,
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_route53 as route53,
    aws_route53_targets as targets,
    aws_s3 as s3,
    aws_s3_deployment as s3_deploy,
)
from constructs import Construct


class FrontendStack(cdk.Stack):
    """S3 + CloudFront + the Route53 alias record."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        api_endpoint: str,
        domain_name: str,
        hosted_zone_id: str,
        zone_name: str,
        certificate_arn: str,
        web_acl_arn: Optional[str] = None,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        zone = route53.HostedZone.from_hosted_zone_attributes(
            self,
            "QconnectZone",
            hosted_zone_id=hosted_zone_id,
            zone_name=zone_name,
        )

        # Rehydrated from an ARN rather than passed as a construct: the certificate
        # lives in a us-east-1 stack and a cross-region reference carries a value.
        certificate = acm.Certificate.from_certificate_arn(
            self, "PlanningCertificate", certificate_arn
        )

        self.bucket = s3.Bucket(
            self,
            "FrontendBucket",
            versioned=True,
            # DESTROY here, unlike the DynamoDB tables. This bucket holds build
            # output and nothing else - every byte of it is reproducible from the
            # repo, so there is nothing to protect. The tables hold the roadmap
            # itself and are RETAIN for exactly the opposite reason.
            removal_policy=cdk.RemovalPolicy.DESTROY,
            auto_delete_objects=True,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            enforce_ssl=True,
        )

        oai = cloudfront.OriginAccessIdentity(
            self, "OAI", comment="Planning Roadmap OAI"
        )
        self.bucket.grant_read(oai)

        # Split the API Gateway endpoint into host and stage path. api_endpoint is
        #   "https://slxqk1v4x3.execute-api.ca-central-1.amazonaws.com/prod/"
        # so the origin needs origin_path="/prod". Without it CloudFront forwards
        # "/api/roadmap" to the bare domain, the stage is missing, and API Gateway
        # answers 403 Forbidden - which reads like an auth problem and is not one.
        # The trailing slash is stripped so the joined path is "/prod/api/roadmap"
        # and not "/prod//api/roadmap".
        parsed = urlparse(api_endpoint)
        api_domain = parsed.netloc or api_endpoint
        api_stage_path = parsed.path.rstrip("/")

        api_origin = origins.HttpOrigin(api_domain, origin_path=api_stage_path)

        # The origin request policy is load-bearing, not boilerplate.
        #
        # A cache policy decides what goes into the cache key; an origin request
        # policy decides what actually reaches the origin. With no origin request
        # policy CloudFront forwards only what the cache key contains, and
        # CACHING_DISABLED contains no query strings and no headers.
        #
        # For this API the header that must survive is Authorization. Drop it and
        # every authenticated call becomes an anonymous one: API Gateway's Cognito
        # authorizer answers 401 for a request the browser definitely sent a token
        # on, and nothing in the logs says the header went missing at the CDN.
        #
        # The same policy also fixed a real paging bug in the marketing tool -
        # "/api/rules?limit=100&offset=100" arrived as bare "/api/rules", so every
        # page came back as page one and rules 101-155 were unreachable.
        #
        # ALL_VIEWER_EXCEPT_HOST_HEADER forwards query strings, cookies and headers
        # while dropping Host. Host must be dropped: API Gateway routes on it, and
        # forwarding the CloudFront hostname makes it answer 403 because no custom
        # domain is mapped there.
        api_behavior = cloudfront.BehaviorOptions(
            origin=api_origin,
            viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
            cache_policy=cloudfront.CachePolicy.CACHING_DISABLED,
            origin_request_policy=cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
            allowed_methods=cloudfront.AllowedMethods.ALLOW_ALL,
        )

        self.distribution = cloudfront.Distribution(
            self,
            "PlanningDistribution",
            domain_names=[domain_name],
            certificate=certificate,
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3Origin(self.bucket, origin_access_identity=oai),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
            ),
            additional_behaviors={
                "/api/*": api_behavior,
                # /health too, so the placeholder page (and later any uptime check
                # pointed at the friendly hostname) can reach it without a token.
                # It is a separate behaviour rather than part of /api/* because
                # FastAPI serves it at the root - see app/main.py.
                "/health": api_behavior,
            },
            default_root_object="index.html",
            # Despite the name this takes the Web ACL's full ARN, not its id, for a
            # CLOUDFRONT-scoped ACL. Passing an id deploys cleanly and silently
            # associates nothing.
            #
            # None today. The marketing tool fronts its distribution with a country
            # allowlist; this one does not yet, and the reason to leave it off rather
            # than copy it is that a CLOUDFRONT Web ACL which blocks by default locks
            # out whoever has to undo it. The API is Cognito-gated on every route but
            # /health, so the WAF would be a second layer, not the only one.
            web_acl_id=web_acl_arn,
            error_responses=[
                # SPA routing: React Router owns the path, so a deep link must return
                # index.html rather than S3's error. 403 is listed as well as 404
                # because S3 with a private origin answers AccessDenied - not
                # NoSuchKey - for a missing object, so a 404-only rule leaves every
                # refreshed deep link showing CloudFront's XML error page.
                cloudfront.ErrorResponse(
                    http_status=404,
                    response_http_status=200,
                    response_page_path="/index.html",
                    ttl=cdk.Duration.minutes(5),
                ),
                cloudfront.ErrorResponse(
                    http_status=403,
                    response_http_status=200,
                    response_page_path="/index.html",
                    ttl=cdk.Duration.minutes(5),
                ),
            ],
        )

        route53.ARecord(
            self,
            "PlanningAliasRecord",
            zone=zone,
            record_name=domain_name,
            target=route53.RecordTarget.from_alias(
                targets.CloudFrontTarget(self.distribution)
            ),
        )

        # What actually gets uploaded.
        #
        # ../dist is the React build and wins whenever it exists. ../web is the
        # placeholder that ships until then - without it the origin is empty and
        # CloudFront answers AccessDenied, which looks like a broken deploy rather
        # than an unfinished one.
        #
        # Note the consequence, inherited from the marketing tool: the bundle is
        # built locally and uploaded as an asset, so whatever was last built is what
        # ships. A stale dist/ deploys silently.
        root = os.path.join(os.path.dirname(__file__), "..", "..")
        dist_dir = os.path.join(root, "dist")
        web_dir = os.path.join(root, "web")
        source_dir = dist_dir if os.path.exists(dist_dir) else web_dir

        # Two uploads, because index.html and the hashed assets need opposite
        # caching, and getting it wrong renders a blank white page.
        #
        # The failure it prevents, observed in the marketing tool on 2026-08-20: a
        # single deployment stored index.html with no Cache-Control at all. Browsers
        # apply heuristic caching to that, so a returning visitor re-used an old
        # index.html whose <script> pointed at the previous build's hashed filename.
        # That file no longer existed, the script 404'd, React never mounted - no
        # error, no content, just white. It presents as an intermittent outage
        # because it depends on which edge the viewer lands on.
        s3_deploy.BucketDeployment(
            self,
            "FrontendIndex",
            sources=[s3_deploy.Source.asset(source_dir)],
            destination_bucket=self.bucket,
            distribution=self.distribution,
            distribution_paths=["/", "/index.html"],
            exclude=["*"],
            include=["index.html"],
            # Never cached, so a deploy takes effect immediately and a stale entry
            # point cannot outlive the assets it references.
            cache_control=[
                s3_deploy.CacheControl.no_cache(),
                s3_deploy.CacheControl.must_revalidate(),
            ],
            # Must not prune: this upload contains only index.html, so pruning here
            # would delete every asset the page depends on.
            prune=False,
        )

        if os.path.exists(os.path.join(source_dir, "assets")):
            # Cached for a year and immutable. Safe because Vite puts a content hash
            # in every filename, so a changed file is a new URL.
            #
            # prune stays off deliberately. Leaving superseded bundles costs about a
            # megabyte per deploy and means a viewer holding a stale index.html still
            # gets a working page - a second line of defence behind the no-cache
            # above.
            s3_deploy.BucketDeployment(
                self,
                "FrontendAssets",
                sources=[s3_deploy.Source.asset(source_dir)],
                destination_bucket=self.bucket,
                distribution=self.distribution,
                distribution_paths=["/assets/*"],
                exclude=["index.html"],
                cache_control=[
                    s3_deploy.CacheControl.max_age(cdk.Duration.days(365)),
                    s3_deploy.CacheControl.immutable(),
                ],
                prune=False,
            )

        cdk.CfnOutput(self, "CustomDomain", value=f"https://{domain_name}")
        cdk.CfnOutput(self, "CloudFrontDomain", value=self.distribution.domain_name)
        cdk.CfnOutput(self, "DistributionId", value=self.distribution.distribution_id)
        cdk.CfnOutput(self, "BucketName", value=self.bucket.bucket_name)
