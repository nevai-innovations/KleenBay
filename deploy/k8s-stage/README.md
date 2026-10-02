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
- Build and test both images. The job/app manifests pin tested ECR images by
  digest. Update all three manifests together for a later release.

## Release order

Run `./deploy/k8s-stage/assert-main.ps1` from the repository root before
building or deploying. It fetches `origin/main` and stops unless the local
checkout is clean `main` at exactly the same commit. Build both images from
that verified commit, tag them with its SHA, and record their immutable ECR
digests in the manifests. Never build a stage release from an uncommitted
checkout or a feature branch.

1. Verify AWS account, Kubernetes context, certificate, RDS backup/capacity,
   and image digests. Confirm the namespace is not already in use.
2. Apply `namespace.yaml` and `config.yaml`; create the four secrets without
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

Stage uses one API replica and a gp3 persistent volume for photos. On 2026-10-02,
the dedicated `KleenBayStageOTP` MSG91 widget, scoped `KBStageOTP` AuthKey,
`kleenbay-stage-otp` Kubernetes secret, and OTP migration were configured.
The current stage ConfigMap selects `OTP_PROVIDER=DUMMY_OTP` with
`DUMMY_OTP=123456`, while `DEV_OTP_ENABLED=false`. No SMS is sent. The API pod
loads only `OTP_HASH_SECRET` from the OTP secret, not the MSG91 credentials.
The secret retains `MSG91_AUTH_KEY`, `MSG91_WIDGET_ID`,
`MSG91_WIDGET_TOKEN`, and a random 32+ character `OTP_HASH_SECRET`. Never put
their values in Git, chat, shell history, or logs. The Widget ID/token are
public browser configuration when MSG91 is selected; AuthKey and hash secret stay API-only. The widget
allows India only and has no demo credentials. Its AuthKey has OTPWidget View
permission with IP security enabled for the stage EKS nodes' current public
addresses. These addresses can change when nodes are replaced; update the MSG91
allowlist or provide stable egress before relying on OTP operationally.

Each OWNER belongs to their own organization. The normal Owner portal manages
employees, not other owners. Owner provisioning belongs to a separate, controlled
platform process; the public one-time password-setup endpoint remains available
for accounts provisioned by that process, but no Owner portal creates setup links.
The four existing stage owners were separated by the guarded stage transfer job;
Arun's original business data stayed with the original organization. Employee
mobiles and owner emails are globally unique so login needs no tenant selector.

Stage employee sign-in uses the same owner-created mobile and hashed challenge
flow as MSG91, but accepts the ConfigMap's fixed test code. Challenges expire
after 5 minutes, are single-use, and remain rate-limited. Public stage is not
safe for real customer or employee data with a shared OTP. Production must use
`OTP_PROVIDER=MSG91` with dedicated secrets and no `DUMMY_OTP`; no production
namespace or ConfigMap is created by this stage release.
The live stage API and browser tests on 2026-10-02 confirmed `123456` creates
an EMPLOYEE session for an active owner-created account and opens the Board.
Wrong-code, immediate resend,
and replay attempts were rejected; employee financial/Owner APIs remained
forbidden. No SMS was sent and no code appeared in the checked API logs.

Customer status updates on stage use `MESSAGING_PROVIDER=mock`. Events and rendered
text persist in the KleenBay stage database and are marked simulated sent; no SMS
or WhatsApp status message leaves the application. `MOCK_MESSAGING_FAIL=true` is
for controlled failure testing only. MSG91 WhatsApp remains disabled pending
business verification, number connection, approved templates, and credentials.
Do not use this public stage for real customer operations until those integrations
and a production storage design are ready.

WhatsApp sender settings are now per organization in `OrganizationWhatsAppConfig`.
`Settings > WhatsApp` is owner-only and never returns credential references. Mock
delivery snapshots the organization's sender and template on each message. The
stage-only, owner-only `/api/whatsapp/test-failure` endpoint arms one mock send
failure for that organization; it is audited and unavailable in production.
Tracking tokens are random, stored as a hash plus encrypted ciphertext, and
never returned in job API fields. Stage derives a separate encryption key from
the persistent `OTP_HASH_SECRET`; preserve that secret across rollouts so links
continue working. A dedicated `TRACKING_TOKEN_SECRET` can be supplied later.

After deploying a verified image and applying migrations, create
`whatsapp-smoke-job.yaml` as a one-time Job. It creates synthetic QA tenants and
uses the public stage API to verify owner/employee access, the three automatic
messages, tracking links, idempotency, tenant isolation, and mock failure/retry.
Its logs report pass/fail without printing passwords, OTP values, or links.
The QA records remain in stage for audit; do not run this Job in production.
ECR's basic scanner could not scan the first OCI image indexes. The replacement
single-platform images were scanned on 2026-10-01: API 0 critical/3 high, web
0 critical/1 high. Review and remediate remaining findings before production.
