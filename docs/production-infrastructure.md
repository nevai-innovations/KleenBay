# Production infrastructure boundary

The stage ConfigMap remains `STORAGE_PROVIDER=local` and `MESSAGING_PROVIDER=mock` until its dedicated services are provisioned. Do not put credentials in a ConfigMap or this repository. Production requires `STORAGE_PROVIDER=s3`, `S3_BUCKET`, `S3_REGION`, `MESSAGING_PROVIDER=msg91`, and `MSG91_WHATSAPP_AUTH_KEYS_JSON` in secrets, in addition to the existing production OTP/database configuration.

## Private photo storage

- Use a dedicated, private S3 bucket with public access blocked, TLS-only access, server-side encryption, and restricted IAM for the API workload. The SDK uses its default credential chain/workload identity; no access key is coded into the app.
- PostgreSQL stores the object key, MIME type, size, uploader, and photo visibility. Current authenticated and tracking photo routes proxy bytes after checking authorization; they do not publish S3 URLs. The S3 adapter can issue short-lived signed read URLs if a future authorized route needs them.
- The API validates an 8 MB maximum and JPEG/PNG/WebP magic bytes against the declared MIME type before storage. Both storage adapters recheck data and produce tenant/job-prefixed random keys. This does not replace malware scanning or an image decoder check for highly untrusted uploads.
- Local and current stage use `.local-data/uploads` or the stage PVC. Do not select local storage in production.

## MSG91 WhatsApp

- Each organization must have an `OrganizationWhatsAppConfig` provisioned server-side with `provider=MSG91`, `enabled=true`, `status=CONNECTED`, its approved `senderNumber`, `msg91IntegratedNumberId`, `credentialRef`, and approved template names. Owner APIs cannot set secret references or promote an unverified sender.
- The secret `MSG91_WHATSAPP_AUTH_KEYS_JSON` maps `organizationId:credentialRef` to that sender's AuthKey. The lookup includes the organization ID so a reference from another tenant cannot select its key. Never place the mapping in web config or audit events.
- Approved templates must match the stored parameters. Received, Washing, and Ready use body variables 1-3 for customer name, registration and business name, plus variable 4 for the tracking URL when enabled. Handed Over uses business name and registration as variables 1-2. If tracking is disabled, provision a matching three-variable template name. Template language is currently `en`.
- The outbox snapshots template name, rendered text, parameters, recipient, sender number and event at queue time. A job/event remains unique, claim-before-send prevents concurrent duplicate dispatch, and attempts/history are recorded. Provider errors do not roll back a job. Owners can retry failed messages. A network timeout after MSG91 accepts a request is ambiguous: MSG91's documented template endpoint does not provide a confirmed idempotency key in this integration, so a retry could duplicate delivery. Resolve this with provider delivery receipts before relying on automatic retries.
- `SENT` currently means MSG91 accepted the HTTP request, not confirmed handset delivery. Real template approval, credentials, sending, receipts, and sender onboarding still need live verification. Mock tests cannot establish delivery.

## Proxy and headers

`TRUST_PROXY_HOPS` trusts exactly that many nearest hops. Use `0` without a proxy and `1` only when the API is reachable solely through the trusted ALB/Ingress, configured to append the client IP. A forged leftmost `X-Forwarded-For` value then cannot change the rate-limit key. Restrict direct API access at the network layer.

The web nginx config now sends CSP, frame denial, nosniff, and referrer policy on both the main and public tracking routes. The CSP permits the external MSG91 OTP widget and its CAPTCHA origins; retest the real widget and browser console under the deployed policy before production. Stage's dummy OTP does not exercise that path.

## Images and dependency audit

Build `docker/api.Dockerfile` target `migrate` for an ephemeral migration Job and the default `runtime` target for the serving API. The runtime target uses pnpm's production deploy output and does not copy root dev dependencies, tests or the Prisma CLI executable. The migration target retains Prisma CLI and must run checked-in migrations before the new runtime image is rolled out. Never run schema reset or `db push` on a shared database.

`pnpm audit --prod` before the dependency update found 2 high and 1 moderate advisories: DeepmergeTS 7.1.5 and mysql2 3.15.3 via Prisma's optional CLI/config chain. The workspace pins patched mysql2 3.24.5 and DeepmergeTS 8.0.2. Prisma 7.10.0 still declares DeepmergeTS 7, so the 8.x override is a compatibility exception, not a Prisma-supported upgrade. Prisma generation, migration status, migration-from-empty, builds, and tests must pass on every lockfile change. The current post-update `pnpm audit --prod` reports no known advisories, but this does not replace periodic audit or live deployment verification.
