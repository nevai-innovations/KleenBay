# KleenBay

Car wash operations app: track every vehicle through the wash stages, keep customers
updated on WhatsApp, and give owners a live view of their business.

## What's in this repo

| Path | What it is |
|---|---|
| `prototype/` | Clickable UX prototype (static HTML/CSS/JS, sample data, no backend). Deployed to Vercel. |
| `apps/`, `packages/` | Local API-driven app (React, Fastify, Prisma and shared validation). Broader production roadmap remains in progress. |
| `docker-compose.yml`, `docker/` | Local PostgreSQL for the production app. |

## Prototype

Two portals:

- **Owner**: live board, activity feed of employee updates, daily summary, history, team and wash-type management.
- **Employee**: board, stage changes, vehicle check-in, photos. Never sees prices or payments.

Sign in with any sample account shown on the sign-in screen. The one-time code is `123456`
for every account (placeholder until a real SMS/WhatsApp OTP provider is integrated).

Data lives in your browser only (localStorage) and syncs between tabs of the same browser.
Nothing is sent to a server.

Run locally:

```bash
node prototype/server.mjs
```

Then open http://localhost:4321.

## Local API-driven app

Requires Node.js 22+, pnpm 11+ and Docker. Keep the prototype on port 4321 separate from this app.

```bash
cp .env.example .env
pnpm install
docker compose up -d --wait postgres
pnpm --filter @carwash/api db:deploy
pnpm --filter @carwash/api db:seed
pnpm dev
```

Open http://localhost:5173. The local seed prints an owner login on first run; set
`DEV_SEED_PASSWORD` in your untracked `.env` to choose or reset its development password.
Employee accounts are owner-created and the fixed OTP works only with the development
flag enabled. No SMS or WhatsApp is sent locally: message events are stored and
marked as simulated by the local provider.

The shared-RDS target architecture is documented in
[`docs/shared-rds-database.md`](docs/shared-rds-database.md). The stage database,
roles, secrets, and workloads were provisioned separately in AWS; the KleenBay
production database has not been created. Production requires an explicit
`EXPECTED_DATABASE_NAME` matching the database selected by `DATABASE_URL`.

The public stage deployment manifests and runbook are under
[`deploy/k8s-stage/`](deploy/k8s-stage/README.md). `stage.kleenbay.com` is live
over HTTPS. Public staging disables fixed OTP and live messaging
until a real provider is configured.

The current workflow is **Received → Started Washing → Ready → Handover**. Both roles
can check in a vehicle; Handover permissions and outstanding balances are owner
settings. Active vehicles are on the board, and handed-over visits remain in History.
Condition records and photos use local storage in `.local-data/uploads`.

### Annual subscription billing

Billing is owner-only and belongs to the signed-in organization. The server sets
the single KleenBay Annual plan at INR 7,200; PayU test checkout remains unavailable
until `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, and
`PAYU_BASE_URL=https://test.payu.in` are configured in the untracked `.env` or
stage secret. Never use live PayU credentials locally or in stage. Successful
payments activate a subscription only after server-side PayU verification. Run
`pnpm --filter @carwash/api db:deploy` for the subscription migrations.

The linked policy pages are placeholders pending legal approval. Production
checkout requires the final policies and `BILLING_POLICIES_APPROVED=true`; leave
that flag false until the approved copy is published. PayU secrets must never go
in Git, frontend environment variables, or docs.

Run `pnpm verify` for lint, typecheck, tests and builds. Tests require the separate
`carwash_test` database from `docker/postgres/init`; the suite accepts only a
loopback `_test` database and clears its test tables.
