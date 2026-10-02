# KleenBay

KleenBay is a car wash operations app. The current API-driven application is in
`apps/web`, `apps/api`, and `packages/shared`. `prototype/` is an older UX
reference, not the application to develop or run for normal work.

## Local Development Setup

These commands use **Windows PowerShell** from the repository root.

### Prerequisites

- Git.
- Node.js **22.12 or newer** (`package.json` requires `>=22.12`).
- **pnpm 11.9.0**, the version pinned in `package.json`. Node's Corepack can
  install it using the commands below.
- Docker Desktop with Docker Compose, started before the database commands.
- Free local ports **5432** (PostgreSQL), **3000** (API), and **5173** (web).

Check your tools with `git --version`, `node --version`, `pnpm --version`, and
`docker compose version`.

### 1. Clone and install

```powershell
git clone https://github.com/nevai-innovations/KleenBay.git
cd KleenBay
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
```

If pnpm is already installed, check that `pnpm --version` says `11.9.0`.

### 2. Create the local environment file

There is **one** environment template: the root `.env.example`. Copy it to the
root `.env`; the API and Prisma read that file. No `.env.local` or app-specific
env file is needed for this setup. Both `.env` and `.env.local` are gitignored.
Owner email/password and employee mobile/OTP login resolve the organization on the server. The browser does not select a tenant.

```powershell
Copy-Item .env.example .env
```

The copied values below are **local-only defaults**, not stage or production
credentials. Leave them as shown for a first run:

| Variable                                | Local value / purpose                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `NODE_ENV`                              | `development`; required for the development OTP.                                          |
| `HOST`, `PORT`                          | `127.0.0.1`, `3000`; API address.                                                         |
| `APP_ORIGIN`                            | `http://localhost:5173`; must match the browser's web origin for protected requests.      |
| `DATABASE_URL`                          | Local Docker `carwash` database on `localhost:5432`; required by the API and migrations.  |
| `EXPECTED_DATABASE_NAME`                | `carwash`; safety check against the database URL.                                         |
| `TEST_DATABASE_URL`                     | Separate local `carwash_test` database; required by API tests.                            |
| `DEV_SEED_PASSWORD`                     | Empty by default. The first seed generates and prints a random local owner password once. |
| `DEV_OTP_ENABLED`, `DEV_OTP_FIXED_CODE` | `true`, `123456`; local employee OTP only. No SMS is sent.                                |
| `OTP_PROVIDER`, `STAGING_MODE`          | `unconfigured`, `false`; no MSG91 or AWS credentials are needed locally.                  |
| `MESSAGING_PROVIDER`, `MOCK_MESSAGING_FAIL` | `mock`, `false`; customer updates are saved as simulated sent, never delivered externally. |
| `COOKIE_SECURE`, `TRUST_PROXY_HOPS`     | `false`, `0`; local HTTP without a reverse proxy.                                         |
| `SESSION_HOURS`, `LOG_LEVEL`            | `168`, `info`; session lifetime and API log level.                                        |

The other OTP settings in `.env.example` are optional provider/rate-limit
settings. Do not add MSG91 keys for local development. Do not point either
database URL at an external database.

### 3. Start PostgreSQL, migrate, and seed

Docker Compose runs PostgreSQL 17 and creates `carwash` plus a separate
`carwash_test` database on a **new** volume. Wait for `healthy` in
`docker compose ps` before migrating.

```powershell
docker compose up -d --wait postgres
docker compose ps
pnpm --filter @carwash/api db:deploy
pnpm db:seed
```

Apply the existing migrations to the **test database** before running
`pnpm test` or `pnpm verify`. These PowerShell overrides affect only this
terminal session; the last two lines restore normal `.env` behavior.

```powershell
$env:DATABASE_URL = 'postgresql://carwash:carwash_dev_only@localhost:5432/carwash_test'
$env:EXPECTED_DATABASE_NAME = 'carwash_test'
pnpm --filter @carwash/api db:deploy
Remove-Item Env:DATABASE_URL
Remove-Item Env:EXPECTED_DATABASE_NAME
```

Use `db:deploy` to apply checked-in migrations. `pnpm db:migrate` is for
**creating** a migration when you change the Prisma schema, not routine
setup. The tests accept only a loopback `_test` database and leave test
records there; they never use the application database.

### 4. Start the app

```powershell
pnpm dev
```

This starts the API and web server together. Open
[http://localhost:5173](http://localhost:5173). The API listens at
[http://127.0.0.1:3000](http://127.0.0.1:3000); check
[/health](http://127.0.0.1:3000/health) for the process and
[/ready](http://127.0.0.1:3000/ready) for database connectivity. Keep this
terminal open while using the app; press `Ctrl+C` to stop it. For separate
terminals, run `pnpm --filter @carwash/api dev` and
`pnpm --filter @carwash/web dev` from the repository root.

## First Login

The local seed creates the `sparkle` business, owner **Suresh**, example
employees, services, customers, vehicles, and jobs. Use **Owner Login** with
username `suresh` (or `suresh@example.local`) and the random password printed
by the **first** `pnpm db:seed` run. Record it locally; a later seed run with
an existing owner does not print or change that password.

If you lose the local password, set `DEV_SEED_PASSWORD` to a new local-only
password in your untracked `.env`, then rerun `pnpm db:seed`. This resets only
the seeded local owner password. Never use a real stage/production password.

To test **Employee Login**, sign in as owner, open **Employees**, and add an
active employee with a name and Indian mobile number (or use one of the
seeded employees). Sign out, choose Employee Login, and enter that **same**
mobile number. With the copied local `.env`, request a code and enter
`123456`. The local development flag is **local only**. Public stage now uses
its separate, explicitly guarded `DUMMY_OTP` mode with the same test code; no
SMS is sent. Production must select `MSG91` and never set `DUMMY_OTP`.
Employees cannot register themselves.

## Typical Developer Workflow

```powershell
docker compose up -d --wait postgres
pnpm --filter @carwash/api db:deploy
pnpm dev
```

Make changes, then run these from a second PowerShell terminal in the repo
root before committing:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify
```

`pnpm verify` runs lint, typecheck, tests, and build together. After a fresh
database reset, migrate `carwash_test` again using step 3 before testing.

### Reset the local database

**This deletes all local `carwash` and `carwash_test` data.** First confirm you
are in this repo and `.env` points to `localhost:5432/carwash`, never stage or
production. Then run:

```powershell
$dbLine = Get-Content .env | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
$dbUri = [uri]($dbLine -replace '^DATABASE_URL=', '')
if ($env:DATABASE_URL -or $dbUri.Host -notin @('localhost', '127.0.0.1') -or $dbUri.AbsolutePath -ne '/carwash') {
  throw 'Refusing to reset: clear database overrides and use the local carwash .env'
}
docker compose down --volumes
docker compose up -d --wait postgres
pnpm --filter @carwash/api db:deploy
pnpm db:seed
```

Repeat the test-database migration block in step 3. A normal
`docker compose down` (without `--volumes`) preserves your local data.

## Common Problems

| Symptom                                            | What to check                                                                                                                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker command cannot connect                      | Start Docker Desktop, then run `docker compose up -d --wait postgres`.                                                                                                                                            |
| PostgreSQL is not healthy or connection is refused | Run `docker compose ps` and `docker compose logs --tail=50 postgres`. Check the local `DATABASE_URL` and that port 5432 is free.                                                                                  |
| Port 3000, 5173, or 5432 is already in use         | Stop the other server/container. In PowerShell, inspect listeners with `Get-NetTCPConnection -State Listen -LocalPort 3000,5173,5432`. If Vite moves to 5174, `APP_ORIGIN` will not match; free 5173 and restart. |
| Old blue prototype sign-in page appears            | You opened `http://localhost:4321`, the retired prototype server. Stop `node prototype/server.mjs`, run `pnpm dev` from the repo root, and open `http://localhost:5173`. Port 3000 is the API, not a second browser app. |
| Migration fails                                    | Check `docker compose ps`, the database name in `DATABASE_URL`, and `EXPECTED_DATABASE_NAME`. Inspect status with `pnpm --filter @carwash/api exec prisma migrate status`; do not reset a shared database.        |
| Wrong Node or pnpm version                         | Check `node --version` and `pnpm --version`; install Node 22.12+ and run the Corepack commands in step 1.                                                                                                         |
| Missing environment file                           | Run `Copy-Item .env.example .env` from the repo root, then restart `pnpm dev`. The API does not use `.env.local` for this setup.                                                                                  |
| Employee OTP fails locally                         | Check `NODE_ENV=development`, `DEV_OTP_ENABLED=true`, and `DEV_OTP_FIXED_CODE=123456` in `.env`. The mobile must belong to an active owner-created employee; wait if rate-limited.                                |
| Dependencies seem stale                            | Run `pnpm install --frozen-lockfile`, then restart `pnpm dev`.                                                                                                                                                    |
| Need logs                                          | Watch the terminal running `pnpm dev` for API/web errors; use `docker compose logs --tail=50 postgres` for database logs.                                                                                         |

## Do Not Do This

- Do not connect local development or tests to stage/production PostgreSQL.
- Do not commit `.env`, `.env.local`, passwords, OTP/provider keys, or secrets.
- Do not run `db push`, destructive migrations, or reset commands against
  stage/production data.
- Do not run `docker compose down --volumes` without confirming the local
  project and database first.
- Do not deploy from a local machine unless specifically instructed.
- Do not work in `prototype/` assuming it is the current application.

## Architecture at a Glance

- `apps/web`: React/Vite frontend.
- `apps/api`: Fastify API, Prisma migrations, and local seed.
- `packages/shared`: shared types and validation.
- PostgreSQL: application data; local Docker database for development.
- `.local-data/uploads`: gitignored local photo storage, not a production
  storage design.
- AWS/RDS/S3: deployment concerns, separate from local development. See
  [the stage runbook](deploy/k8s-stage/README.md) for stage-only operations.

The old [prototype](prototype/) is retained for UX reference only. It uses
browser sample data and is not a replacement for the API-driven app.

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
