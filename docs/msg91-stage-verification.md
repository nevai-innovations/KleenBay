# MSG91 Stage Connection Verification

Date: 2026-10-10. Application revision: `d25bfb3eafef8f951cd490054d69d4f269def627`.
Environment: `brickview-stage-verified` / `kleenbay-stage` only.

## Verdict

Verified code is deployed; **live MSG91 connectivity remains blocked** by missing
WhatsApp credentials. No real customer message was sent. Do not interpret this
rollout as a successful live sender connection or verified handset delivery.

## Configuration

- Controlled organization: `Synthetic Entitlement QA ACTIVE`
- Organization ID: `cmv27p7jz00000lfzg5gh0zn8`
- Provider: MSG91; automatic updates enabled
- Sender: `+918137994052`; display name: `NevAi`
- Templates: `kb_vehicle_received`, `kb_wash_started`, `kb_vehicle_ready`
- Handover: null, disabled
- Connection: ERROR after safe missing-credential test
- Approval states: NOT VERIFIED (user reported Meta review; not independently confirmed)
- Stage default remains `MESSAGING_PROVIDER=mock`
- Other organizations' configurations compared before/after: unchanged

Required Secret: `kleenbay-stage-whatsapp`.
Required key: `MSG91_WHATSAPP_AUTH_KEYS_JSON`.
Mapping key for this one tenant: `cmv27p7jz00000lfzg5gh0zn8:primary`.
The Secret was absent during verification and **was not created with fake values**.
Deployment includes an optional Secret reference so mock tenants remain healthy.
See [secure setup](msg91-stage-connection.md). A pod rollout is required after adding
the real Secret. No AuthKey was obtained, printed, stored in source, or sent to MSG91.

## Implemented Changes

- `apps/api/src/messaging.ts`: tenant provider routing, existing send adapter reused,
  read-only sender/template checks, approval gate, safe results, redirect rejection
- `apps/api/src/whatsapp-settings.ts`: owner-only real connection endpoint, rate limit,
  audited connection outcomes, controlled template edits and verification invalidation
- `apps/api/src/app.ts`: inject existing messaging provider into settings routes
- Prisma schema/migration: templateStatuses JSONB on OrganizationWhatsAppConfig
- `apps/web/src/WhatsAppSettingsView.tsx` and `api.ts`: independent template states,
  refresh connection result, platform-provisioned sender read-only
- `apps/web/src/OperationsViews.tsx`: SENT labeled Provider accepted, not delivered
- New API connection/workflow tests and real-provider UI test; existing test updates
- Stage deployment/migrator manifests, guarded single-QA-tenant provisioning script,
  and secure setup documentation

## Automated Verification

`pnpm verify`: PASS. Lint, typecheck, tests, and production build all completed.
189 tests passed: 5 shared, 139 API, 45 web. No tests skipped.
New targeted suite additionally rerun after final payload assertions: 8/8 passed.
Final lint rerun after provisioning script/documentation: PASS.

Initial failures were fixed, not skipped: missing test ETA, typed inject payload,
obsolete single-provider instance assertion, and repeat-run unique photo fixture key.

Mocked network coverage includes tenant selection, authenticated GET-only connection,
pending/unknown templates, no connection-test send, secret-safe failure, owner edits,
employee denial, cross-tenant isolation, all four dynamic body variables, exact event
mapping, handover suppression, progression despite provider failure, manual retry and
unique logical job/event notifications. Non-approved templates make no send call.

## Stage Verification

- Migration `20261010200000_whatsapp_template_statuses`: PASS on `kleenbay_stage`
- Migration Job: `kleenbay-stage-msg91-migrate-9v8bt`, completed
- API 1/1 ready; web 1/1 ready
- Internal `/health`: 200; `/ready`: 200; public web: 200
- Synthetic owner email/password login: PASS
- Settings sender/provider/templates and handover null: PASS
- Test connection: HTTP 502, safe missing-credential failure; no MSG91 network call
- Message count unchanged by connection tests: PASS
- Other tenant configs unchanged: PASS
- Employee GET/PATCH settings and POST connection: 403
- Desktop 1440px and mobile 390px browser checks: PASS, no horizontal overflow
- API log scan: no sensitive credential/presigned-URL pattern matches; no HTTP 500

API image: `sha256:b9c05e1579198ff841ea8d36aed1ac7af1b96f112d2cae643dc8b4e332be7597`.
Web image: `sha256:5e5cddd8eaac4e561f4b1ae81f58f24fb1ac3c73edb4a5752c86fd0be2278fa8`.

## Remaining Live Steps

1. Add the dedicated WhatsApp AuthKey via the hidden-input setup command.
2. Roll out the API to load the Secret; re-run Owner > Settings > WhatsApp > Test connection.
3. Confirm real sender recognition and all three provider template statuses.
4. If any template is in review/unknown, stop without sending.
5. Only after all three are APPROVED, use a consented handset and synthetic job to
   verify Received/Washing/Ready messages and the same tracking URL.

Provider acceptance does not establish handset delivery. No receipt integration or
exactly-once remote delivery claim is made. Production and BrickView were untouched.
