# Subscription Entitlement Stage Verification

Verified 10 October 2026 against `https://stage.kleenbay.com`.
Context: `brickview-stage-verified`. Namespace: `kleenbay-stage`.
Database: `kleenbay_stage`. No production deployment or database changes.

## Release

Application source: `1faee71ce35020a13b7afe018ac14a344674a9ed` on `main`.
API image digest: `sha256:36585a89a1c5bb8c546a737388c3b58dc5b775feec7884222261aa48585b6d42`.
Web image digest: `sha256:d1adcb35c941036a937fe0e7f4a6b925e1c33a39f9a2fa77091890c787bcf448`.
Both deployments rolled out and are 1/1 Ready. Internal `/health` and `/ready`
return 200. ConfigMap/pod confirms `SUBSCRIPTION_GRACE_DAYS=7`.

No schema migration or subscription reset was necessary. All 26 existing
migrations were applied successfully to a fresh **local** test database; local
seeding, owner login, synthetic ACTIVE entitlement and the live job board passed.

## Changes

- Central date-derived entitlement service, authentication enforcement,
  tenant/branch-scoped grace checks and deduplicated transition audits.
- API: new `GET /api/entitlement`; owner-only Billing includes derived state,
  grace dates/counts alongside compatible payment-processing status.
- Employee board/metrics filtered to eligible jobs during grace; direct detail
  and photo retrieval checked too. No plan/date/payment data in employee access DTO.
- Razorpay grace renewal extends the old period; fully expired renewal starts
  at successful verification. Existing locking/idempotency retained.
- Owner warning/renewal banner, Billing lifecycle display, disabled check-in,
  per-job stage controls and employee inactive screen. Access refreshes on focus,
  every 20 seconds and immediately after successful payment verification.
- Safe local seed fixture, explicit paid operational test fixtures,
  `.env.example`, stage ConfigMap, README, entitlement runbook and stage-only
  operator fixture generator. No new secrets or dependency changes.

Core implementation files are `apps/api/src/entitlements.ts`, `auth.ts`,
`app.ts`, `operations.ts`, `billing.ts`, `config.ts`, `scripts/seed-dev.ts`,
and `apps/web/src/Entitlement.tsx`, `entitlement.css`, `App.tsx`,
`BillingView.tsx`, `OperationsViews.tsx`. Tests include the new
`entitlements.test.ts`, `paid-fixture.ts`, `Entitlement.test.tsx`, renewal cases
in `billing.test.ts`, and updated existing authentication/operations/UI fixtures.

## Automated Results

`pnpm verify` passed: lint, typecheck, tests and production builds.
**180 tests passed, none failed/skipped**: 5 shared, 131 API, 44 web.
There are 29 additional entitlement tests (19 API, 10 UI).

Coverage includes exact expiry/grace boundaries, UTC leap-day arithmetic,
configuration-dependent grace, never-paid organizations, all four states,
setup expansion blocking, employee restrictions, pre-expiry job completion,
photo/inspection access, invoice/payment completion, tracking/messages,
cross-tenant access, deduplicated audit records, early/grace/expired renewal,
immediate restoration and concurrent duplicate payment/webhook protection.

Existing operational tests now create explicitly paid synthetic organizations;
there is no test-mode entitlement bypass in application code.

## Live Stage Results

Five separate synthetic organizations were created: ACTIVE, near expiry,
GRACE_PERIOD, EXPIRED and NOT_SUBSCRIBED. Only those new fixtures received
controlled subscription/check-in dates, with explicit synthetic audit events.
Temporary fixture credentials/tokens are private ignored local artifacts.

| Check | Result |
| --- | --- |
| Owner password login and Billing in every state | PASS |
| ACTIVE/near-expiry new check-in | PASS |
| New work/employee/branch creation denied during grace/inactive states | PASS |
| Expired owner historical reads; job/invoice/payment mutations denied | PASS |
| Employee ACTIVE/grace/inactive access; Billing denied | PASS |
| Employee entitlement response contains only operational booleans | PASS |
| Grace employee S3-backed photo upload and authenticated retrieval | PASS |
| Cross-tenant job/stage/photo access denied | PASS |
| Grace employee Washing -> Ready -> Handover | PASS |
| Grace owner invoice issue, UPI INR 700 + Cash INR 500 on INR 1,200 invoice | PASS |
| Partial outstanding INR 500, then PAID | PASS |
| Employee job response excludes invoice/totals/outstanding | PASS |
| Public tracking follows Washing through Handed Over without login | PASS |
| Four mock status messages recorded SENT for grace job | PASS |
| Owner desktop 1440px/mobile 390px; employee mobile in all states | PASS |
| Near-expiry/grace/expired banners and inactive employee screen | PASS |
| Horizontal overflow check and screenshot inspection | PASS |
| Hosted Razorpay TEST renewal from EXPIRED | PASS |
| Provider confirms captured INR 7,200 payment and verification signature accepted | PASS |
| Exactly one calendar-year period and Billing success history | PASS |
| Owner refresh/relogin and existing employee access restored | PASS |
| New check-in succeeds after renewal | PASS |
| Two duplicate verification callbacks + two signed webhook replays | PASS |
| Replay leaves expiry unchanged; one restoration and payment-verified audit | PASS |
| Pre-existing stage subscription records/dates unchanged against snapshot | PASS |
| Log scan: sensitive credential/token/signature patterns absent; no API 5xx | PASS |

The first combined browser/API run hit the existing 120/minute rate limit (429).
Checks were rerun sequentially/throttled without weakening that protection.
An automation-only popup-navigation race was corrected before the hosted payment
was completed. No failing application tests were skipped.

## Limitations

- Observed transition audits are lazy and deduplicated, not a scheduled event
  feed. Actual expiry/grace timestamps remain authoritative even before observation.
- Status messaging was verified with the configured **mock** provider, not real
  WhatsApp delivery.
- Signed webhook replay was verified. Razorpay-dashboard registration and actual
  provider-origin webhook delivery remain unverified; checkout callback plus
  server-side provider fetch completed the real TEST payment successfully.
- No entitlement milestone blocker remains. This is not a production-readiness
  approval or a production billing activation.
- Existing unrelated uncommitted UI/infrastructure changes were preserved locally
  and excluded from the tested image. A recoverable stash snapshot was retained.

See [subscription rules/runbook](subscription-entitlements.md).
