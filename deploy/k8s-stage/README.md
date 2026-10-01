# KleenBay stage release

Target: EKS account `208519604276`, region `us-east-1`, namespace
`kleenbay-stage`, public host `stage.kleenbay.com`. Always pass
`--context brickview-stage-verified` and `-n kleenbay-stage` to Kubernetes
commands. Do not use the current default context or namespace implicitly.

## Prerequisites

- DNS records for `stage.kleenbay.com` and ACM validation resolve; certificate
  `df0e6d9a-9b9d-4333-9e7c-874ade1484cc` is issued.
- The operator has explicitly authorized creation of `kleenbay_stage` and
  dedicated app/migration roles on `brickview-postgres-stage`. Do not touch
  BrickView databases or create the KleenBay production database during the
  stage release. Review the shared-instance risks in
  [`docs/shared-rds-database.md`](../../docs/shared-rds-database.md).
- The stage database roles and independent credentials exist. The runtime role
  cannot access audited BrickView tables, create objects in KleenBay's schema,
  or access Prisma's migration ledger. The existing `brickview_stage` database
  still grants `PUBLIC CONNECT`; changing its ACL needs a separate review. Two
  Kubernetes secrets in this namespace hold
  their distinct `DATABASE_URL` values: `kleenbay-stage-api-db` and
  `kleenbay-stage-migrator-db`. Use `sslmode=verify-full` and the RDS CA bundle
  in the API image. Never place credentials in manifests, shell history, logs,
  or Git.
- The one-time `kleenbay-stage-bootstrap` secret holds
  `STAGE_ORGANIZATION_NAME`, `STAGE_ORGANIZATION_SLUG`, `STAGE_BRANCH_NAME`,
  `STAGE_OWNER_NAME`, `STAGE_OWNER_USERNAME`, `STAGE_OWNER_EMAIL`, and a random
  `STAGE_OWNER_PASSWORD` of at least 16 characters. This job refuses to
  overwrite an existing organization.
- Build and test both images. The job/app manifests pin the tested 2026-10-01
  ECR images by digest. Update all three manifests together for a later release.

## Release order

1. Verify AWS account, Kubernetes context, certificate, RDS backup/capacity,
   and image digests. Confirm the namespace is not already in use.
2. Apply `namespace.yaml` and `config.yaml`; create the three secrets without
   exposing their values. Keep the owner bootstrap secret until the owner has
   signed in. The app does not yet offer a password-change flow; arrange a
   supported rotation before real operational use.
3. Create `migrate-job.yaml` as a new Job. Wait for completion and inspect its
   output; stop on any failure. Never use `migrate dev`, `db push`, or reset on
   the shared RDS instance.
4. Create `bootstrap-job.yaml` once. Verify exactly one organization and owner
   were created. Do not run the development seed on shared RDS.
5. Apply `app.yaml`, wait for API/web readiness, and inspect the PVC and Ingress
   status. Verify `/health`, unauthenticated API behavior, HTTPS certificate,
   sign-in, and static assets from the public hostname.
6. Recheck BrickView stage and production ingress health after the shared ALB
   reconciles. If KleenBay fails, remove only KleenBay stage Ingress/workloads;
   do not roll back or edit unrelated services.

Stage uses one API replica and a gp3 persistent volume for photos. It has no
live WhatsApp/MSG91 provider yet: employee OTP returns unavailable, and outgoing
message attempts become `FAILED`. Do not use this public stage for real customer
operations until those integrations and a production storage design are ready.
ECR's basic scanner could not scan the first OCI image indexes. The replacement
single-platform images were scanned on 2026-10-01: API 0 critical/3 high, web
0 critical/1 high. Review and remediate remaining findings before production.
