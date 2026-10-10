# Razorpay Stage Verification - 10 October 2026

Target: `https://stage.kleenbay.com`, namespace `kleenbay-stage`, context
`brickview-stage-verified`. No production deployment or BrickView configuration changes.

Application source: `70aab63c5e1e6a51f69abf0de08989352392b04e` on main.
The isolated tested release has the identical Git tree. Unrelated uncommitted
board-photo/theme work was preserved and excluded from this release.

## Results

| Check | Result |
| --- | --- |
| Lint, typecheck, tests, build (`pnpm verify`) | PASS: 151 tests (5 shared, 112 API, 34 web) |
| Migrate empty local PostgreSQL database | PASS: all 26 migrations |
| Stage database migration | PASS: `20261010100000_razorpay_billing` applied to `kleenbay_stage` only |
| API secret mount | PASS: `kleenbay-stage-razorpay`, all three required keys, test key prefix |
| Configuration | PASS: `RAZORPAY_ENV=test`; existing stage S3 and dummy employee OTP preserved |
| API and web rollout | PASS: both 1/1 Ready |
| Health and internal readiness | PASS: HTTP 200 |
| Hosted Razorpay Test Mode checkout | PASS: INR 720000 paise through demo netbanking Success |
| Signature verification | PASS: application verification HTTP 200 SUCCESS; invalid signature rejected |
| Provider confirmation | PASS: fetched Razorpay payment reports captured, matching order and amount |
| Subscription activation and history | PASS: ACTIVE and successful payment visible in Billing |
| Calendar-year expiry | PASS: 2026-10-10T08:47:35.892Z to 2027-10-10T08:47:35.892Z |
| Refresh and fresh owner password login | PASS: ACTIVE/history persist |
| Duplicate callback | PASS: two repeat verifications leave expiry unchanged |
| Duplicate signed webhook | PASS: three identical signed event replays leave expiry unchanged |
| Audit idempotency | PASS: exactly one activation and successful-verification audit |
| Actual provider-declined payment | PASS: demo bank Failure, provider reconciliation FAILED, active expiry unchanged |
| Cancelled checkout/order | PASS: cancellation recorded, active expiry unchanged |
| Employee navigation/direct route | PASS: Billing absent; direct `/billing` shows Access denied |
| Employee API authorization | PASS: eight owner billing endpoints return 403 |
| Organization isolation | PASS: second owner sees independent inactive subscription/empty history; foreign transaction/verify/reconcile/cancel return 404 |
| Desktop/mobile | PASS: Billing inspected at 1440 and 390 px; no document horizontal overflow |
| Headers | PASS: CSP permits hosted Checkout; X-Frame-Options DENY preserved |
| API log scan | PASS: none of the three secret values, checkout signatures or Basic authorization headers present |

Two synthetic QA organizations and an owner-created synthetic employee were
used. Existing customer data and owner subscriptions were not used for test payments.
Passwords and session cookies were generated privately and were not committed
or printed. Test transactions remain historical records, not deleted financial data.

## Outstanding Provider Setup

The separate Razorpay dashboard webhook registration is not yet confirmed.
The application endpoint is live and signed replay/security checks passed, but
these do not prove dashboard-originated event delivery. Register the endpoint
and independently verify delivery for `payment.captured`, `payment.failed` and
`order.paid` using the KleenBay-specific webhook secret. Do not edit the existing
BrickView webhook or rotate/deactivate the shared test API key.

Live-mode billing remains gated on approved legal policies and separate
production configuration. This report does not authorize production deployment.
