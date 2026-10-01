# KleenBay database placement

This document records the requested target and the 2026-10-01 stage rollout.
Only `kleenbay_stage` and its dedicated stage roles have been created. The
KleenBay production database and roles remain unprovisioned.

The user owns `kleenbay.com` and chose `stage.kleenbay.com` for staging. The
stage DNS records resolve, and its ACM certificate was issued on 2026-10-01.
Production hostname, certificate, and rollout are separate decisions.

## Placement and boundaries

Use the existing PostgreSQL instance **`brickview-postgres-stage`** for both
KleenBay environments, with distinct databases and identities:

| Environment         | Database         | Runtime role         | Migration role            | Secrets                                |
| ------------------- | ---------------- | -------------------- | ------------------------- | -------------------------------------- |
| KleenBay production | `kleenbay`       | `kleenbay_prod_app`  | `kleenbay_prod_migrator`  | Separate runtime and migration secrets |
| KleenBay staging    | `kleenbay_stage` | `kleenbay_stage_app` | `kleenbay_stage_migrator` | Separate runtime and migration secrets |

These roles must not be members of BrickView roles or of each other. No KleenBay
tables belong in a BrickView database or schema. PostgreSQL roles are scoped to
the _instance_, so separate database names alone do not guarantee isolation.
Before provisioning, a DBA must audit existing `PUBLIC` database/schema/table
privileges and inherited role grants, including on BrickView databases. The
stage audit found that the new stage role can connect to `brickview_stage` via
that database's existing `PUBLIC CONNECT` grant, but cannot read or write its
64 audited tables. This is table-level isolation, not a connection-level ban;
revoke that grant only after a separate BrickView impact review. Any
change to BrickView privileges requires its own impact review; do not blindly
revoke grants on an existing application database.

For each new KleenBay database, the DBA should remove unnecessary `PUBLIC`
database and schema privileges, grant only `CONNECT` to its app role, and grant
schema `USAGE` plus required table DML and sequence permissions. The environment's
migration role owns its database/schema objects and can perform DDL there; it
must not receive `rds_superuser`, `CREATEDB`, or `CREATEROLE`. Grant app-role
access to existing objects after the first migration and set migration-role
default privileges for future tables/sequences. Exclude or revoke app access
to Prisma's `_prisma_migrations` ledger. Review views, functions, and
extensions individually before granting access. Verify privileges from each
role, including failed attempts to connect to the other KleenBay database and
BrickView databases. Avoid changing the RDS master user or BrickView identities.

## Application contract

- Each API runtime receives `DATABASE_URL` from its own secret, using only the
  corresponding runtime role. Production receives `EXPECTED_DATABASE_NAME=kleenbay`;
  staging receives `EXPECTED_DATABASE_NAME=kleenbay_stage`.
- Public staging runs with `NODE_ENV=production`, `STAGING_MODE=true`, secure
  cookies, and `DEV_OTP_ENABLED=false`. Until a real OTP provider is configured,
  employee login returns unavailable. Messaging failures are recorded instead
  of being reported as delivered. Photo storage uses a persistent stage volume.
- The one-off migration process receives a _different_ `DATABASE_URL` secret for
  that environment's migration role and the same expected database name. Run
  `pnpm --filter @carwash/api db:deploy` once per release/environment with
  concurrency controlled by the release process. Review migration SQL first.
- Both environments use the same checked-in `apps/api/prisma/migrations` history.
  Prisma's migration ledger lives independently in each database. Never run
  `prisma migrate dev`, `prisma db push`, `prisma migrate reset`, the development
  seed, or automated tests against either shared-RDS database.
- The runtime and Prisma migration configuration reject a `DATABASE_URL` whose
  database name differs from `EXPECTED_DATABASE_NAME`; production also requires
  that expectation. This is a guard against mistakes, **not** a substitute for
  database permissions, separate secrets, and change control.
- Use the RDS endpoint and verified TLS (`sslmode=verify-full` with the trusted
  RDS CA certificate) for both runtime and migration connections. URL-encode
  credentials in the connection string. Never commit URLs containing credentials.
  Keep secrets out of logs and only inject them into the intended workload.
- Retain `DATABASE_URL` as the application connection contract. Moving KleenBay
  later to its own RDS requires a planned data migration and secret/URL change,
  not a domain-code change.

## Release and safety gates

1. Obtain a capacity, security, and restore review of the chosen shared instance
   before accepting production traffic. Read-only inspection on 2026-10-01
   showed PostgreSQL 16.14 on `db.t4g.micro`, Single-AZ, 20 GB gp3, seven-day
   automated backup retention, and no configured storage autoscaling. Both
   KleenBay environments would share instance-level capacity and failures with
   BrickView staging. Separate databases do **not** provide separate HA.
2. Define and rehearse a **KleenBay-only** logical backup/restore process. RDS
   automated snapshots restore an instance, not an individual database in place;
   recovery of one environment must not overwrite BrickView or the other
   KleenBay environment. Set retention and recovery targets explicitly.
3. Stage-only provisioning was authorized and completed on 2026-10-01:
   `kleenbay_stage`, `kleenbay_stage_app`, and `kleenbay_stage_migrator` with
   separate Kubernetes secrets. Ten migrations applied successfully. The app
   role has application-table DML but no schema CREATE or migration-ledger
   access. Provisioning of the production database and roles needs a separate
   release decision after the reviews above. Do not expose RDS publicly.
4. Check target database, role identity, and migration state before each release.
   Run migrations with the migration identity, then verify the runtime identity
   cannot perform DDL or access another environment's data.

This shared stage instance is a cost decision with a production availability
trade-off. The current instance settings are **not** a production-readiness
approval; production traffic needs explicit risk acceptance or remediation.
