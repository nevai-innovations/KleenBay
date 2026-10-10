# Subscription Entitlements

`NOT_SUBSCRIBED -> ACTIVE -> GRACE_PERIOD -> EXPIRED`. Verified Razorpay payment
restores `ACTIVE` immediately. The annual plan remains INR 7,200.

## Source of Truth

`apps/api/src/entitlements.ts` derives access from the existing subscription's
`activatedAt`, `currentPeriodEnd`, server UTC time and `SUBSCRIPTION_GRACE_DAYS`
(default 7). No scheduler or new database status column is required. Existing
payment-processing `status` values remain for compatibility; authorization and
the UI use the derived `state`, not the processing status.

At the exact expiry instant, grace starts. At the exact grace-end instant,
access is expired. Calendar-day arithmetic uses UTC, including leap days.

| State | Owner | Employee |
| --- | --- | --- |
| NOT_SUBSCRIBED | Login, Billing, checkout and historical reads; no operational mutations | Login/logout, safe inactive screen; operations denied |
| ACTIVE | Normal owner permissions | Normal operational permissions |
| GRACE_PERIOD | Historical reads, renewal and completion of eligible jobs; no new work/setup expansion | Only eligible active jobs in their authorized branch |
| EXPIRED | Billing/renewal and historical read-only access | Safe inactive screen; operations denied |

An eligible grace job belongs to the authenticated organization, was checked in
**strictly before** `currentPeriodEnd`, and is not `HANDED_OVER`. Inspection,
photos, stages, permitted add-on selection, invoice preparation/issue, partial or
full payment and handover can finish. Stage corrections are blocked in grace.
New customers/vehicles, check-ins, employees, branches, services and sale items,
and configuration mutations require ACTIVE. Existing role/branch restrictions
still apply; entitlement never grants financial access to employees.

Public tracking and its normal 30-day post-handover expiry are independent of
subscription access. Existing job status messages remain queued normally during
grace. Blocked check-ins cannot queue messages or create records.

## Integration Rules

Protected handlers must authenticate through `currentUser` or `requireOwner`.
These helpers enforce entitlement centrally; owner authorization runs before
entitlement in `requireOwner`. Auth, owner-only Billing, health/readiness and
public tracking are exempt. New job-related grace exceptions must resolve the
job through a tenant-scoped relationship; never trust a request organization ID.

`GET /api/entitlement` returns dates/state to OWNER, but only `canOperate` and
`canCreateWork` booleans to EMPLOYEE. Owner history remains readable after expiry.
The employee board/metrics are filtered during grace and direct job/photo access
is checked too. Subscription errors are safe HTTP 402 responses. Owner UI shows
warnings and a renewal link; employees never receive plan/payment details.

Observed state transitions are audited once per subscription period/state using
deterministic audit IDs (safe across concurrent replicas). Blocked mutations and
successful restoration are audited. Reads do not create repeated audit events.
Transitions are observed lazily, not scheduled; timestamps in the audit payload
distinguish observation time from the actual expiry/grace dates.

## Renewal

ACTIVE or GRACE renewal adds one calendar year to the existing period end.
EXPIRED/first activation starts at successful server verification time. Existing
subscription row locking and payment idempotency prevent duplicate verification
or webhook delivery from extending a period twice. No session recreation or
manual unblocking is needed. The frontend refreshes access every 20 seconds, on
window focus and immediately after payment verification.

## Local Development

The development seed creates an explicitly synthetic ACTIVE subscription for
the local demo organization, without pretending to create a Razorpay payment.
It never extends an existing period. The seed rejects production runtime and
non-local database hosts. Other new organizations must subscribe normally.
Use `pnpm verify` for lint, type checking, database-backed tests and builds.

## Stage Verification

Only use context `brickview-stage-verified`, namespace `kleenbay-stage` and database
`kleenbay_stage`. Set `SUBSCRIPTION_GRACE_DAYS=7` in the stage ConfigMap.
No migration is required; never reset stage subscriptions or existing payments.

Create separate clearly named synthetic organizations for ACTIVE, near expiry,
GRACE, EXPIRED and NOT_SUBSCRIBED. Controlled dates must only affect those newly
created fixtures and must be audited; never add an HTTP bypass or production test
switch. Verify owner history/Billing, employee restrictions, pre-expiry handover,
tracking and messaging, then complete a genuine hosted Razorpay TEST payment for
an expired fixture. Check access restoration and duplicate callback handling.
Keep temporary fixture credentials/session tokens only in ignored local files;
do not print them or commit them. Production is outside this runbook.
