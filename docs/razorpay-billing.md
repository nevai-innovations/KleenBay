# Razorpay Annual Billing

Customer wash invoices and KleenBay subscription billing are separate systems.
The only plan is `KLEENBAY_ANNUAL`: INR 720000 paise for one calendar year.
Renewal is manual through Razorpay Orders and Checkout, not recurring auto-debit.

## Configuration

Set `RAZORPAY_ENV=test` for stage. Mount secret `kleenbay-stage-razorpay`
in namespace `kleenbay-stage` with `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
and `RAZORPAY_WEBHOOK_SECRET`. Never commit values or display secret YAML.
Stage rejects live keys. Live mode requires approved billing policies.

The stage test API key is intentionally shared with BrickView, as authorized.
KleenBay has an independent Kubernetes secret and webhook signing secret.
Do not rotate the shared key or edit BrickView configuration for KleenBay.

Register a separate TEST MODE webhook in Razorpay:

`https://stage.kleenbay.com/api/billing/razorpay/webhook`

Subscribe to `payment.captured`, `payment.failed` and `order.paid`.
Use the KleenBay webhook secret, not the merchant key secret.

## API And Security

OWNER only: `GET /api/billing`, `GET /api/billing/payments`,
`POST /api/billing/checkout`, `POST /api/billing/renew`,
`GET /api/billing/transactions/:id`,
`POST /api/billing/transactions/:id/reconcile`,
`POST /api/billing/transactions/:id/cancel`,
`POST /api/billing/razorpay/verify`.
Checkout accepts only a UUID `idempotencyKey`; price and organization are server-controlled.

The public webhook authenticates the exact raw body with HMAC-SHA256.
Checkout verifies `order_id|payment_id` using the merchant secret.
Both paths fetch authoritative order/payment data from Razorpay and require
matching amount, currency and order ownership. Only captured payments activate billing.
Signatures, provider secrets and raw webhook bodies are not logged.

Subscription-row locking and unique payment/order identifiers prevent duplicate
callbacks or concurrent webhooks from extending the subscription twice.
Early renewals extend the existing expiry; expired subscriptions restart on
verification. Calendar-year arithmetic clamps February 29 to February 28.
Failed or cancelled attempts cannot shorten an active subscription.

## Release Gate

Run `pnpm verify` and migrate an empty local test database before stage rollout.
Apply migration `20261010100000_razorpay_billing` to KleenBay stage only.
It adds nullable provider identifiers and indexes without deleting legacy history.
Deploy immutable API/web images and verify health/readiness.

Verify a real Razorpay TEST MODE successful checkout, cancellation, refresh,
new login, duplicate callback/webhook, employee denial and cross-tenant denial.
Provider mocks prove application logic but do not prove hosted checkout delivery.
Do not claim end-to-end completion until the real test payment succeeds.
