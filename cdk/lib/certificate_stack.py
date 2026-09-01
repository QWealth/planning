"""The TLS certificate for planning.qconnect.qwnext.com.

A stack of its own, pinned to us-east-1, because CloudFront will only attach a
certificate from that region no matter where the app runs. Everything else in this
project is ca-central-1.

DO NOT COPY THE DEPRECATED CONSTRUCT FROM THE MARKETING REPO. Its frontend_stack.py
uses `DnsValidatedCertificate`, which is deprecated in CDK v2 - it works by running a
custom-resource Lambda that writes the validation record itself, and it is on its way
out. `Certificate` with `CertificateValidation.from_dns(zone)` is the supported path:
CloudFormation writes the CNAME into the zone natively and blocks until ACM sees it.

WHY THIS IS SAFE TO REQUEST AT ALL
----------------------------------
Checked before writing this file, and it is the check that matters:

    $ dig +short NS qconnect.qwnext.com @8.8.8.8
    ns-1624.awsdns-11.co.uk.   ns-395.awsdns-49.com.
    ns-1510.awsdns-60.org.     ns-782.awsdns-33.net.

The zone is really delegated to Route53, so a validation CNAME written there is
visible to ACM from the public internet. Six certificates in this account are in
FAILED / VALIDATION_TIMED_OUT precisely because that was not true for
intake.qwnext.com and onboarding.qwnext.com - their Route53 zones exist but
Cloudflare, which serves the qwnext.com apex, never got the NS record delegating to
them. ACM waits 72 hours and then gives up permanently.

The rule in CLAUDE.md exists because of those six: never request a DNS-validated
certificate for a name until `dig +short NS <parent> @8.8.8.8` answers. This name
nests under an already-delegated zone, so no Cloudflare change is needed and there is
nothing to get wrong.
"""

import aws_cdk as cdk
from aws_cdk import (
    aws_certificatemanager as acm,
    aws_route53 as route53,
)
from constructs import Construct


class CertificateStack(cdk.Stack):
    """An ACM certificate in us-east-1, DNS-validated against the qconnect zone."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        domain_name: str,
        hosted_zone_id: str,
        zone_name: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        zone = route53.HostedZone.from_hosted_zone_attributes(
            self,
            "QconnectZone",
            hosted_zone_id=hosted_zone_id,
            zone_name=zone_name,
        )

        self.certificate = acm.Certificate(
            self,
            "PlanningCertificate",
            domain_name=domain_name,
            validation=acm.CertificateValidation.from_dns(zone),
        )

        # The ARN as a plain string, not the ICertificate object. The consuming stack
        # is in ca-central-1, and a cross-region reference carries a value, not a
        # construct - the frontend stack rehydrates it with from_certificate_arn.
        self.certificate_arn = self.certificate.certificate_arn

        cdk.CfnOutput(self, "CertificateArn", value=self.certificate_arn)
