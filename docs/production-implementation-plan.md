# KleenBay Production Implementation Plan

## M0 Audit Summary

KleenBay currently has two layers:

- `prototype/` is the approved product and UX reference. It is a zero-build static app with all business behavior in `prototype/app.js`, styling in `prototype/app.css`, and a local static server in `prototype/server.mjs`.
- `apps/api`, `apps/web`, `packages/shared`, and `docker` are production scaffolding. They contain package and TypeScript configuration but no implemented source code yet.

The production build should preserve the prototype's operating model and visual language while moving all business data and sensitive behavior to PostgreSQL-backed API services.

## Existing Prototype Behavior To Preserve

- Owner and employee portals with different visible capabilities.
- Live wash board with stage columns on desktop.
- Mobile stage map and large touch-first stage movement controls.
- One-step forward/back stage transitions.
- Job detail timeline.
- Fast check-in.
- Before/after photos.
- Ready-for-pickup and handover flow.
- Owner-only daily summary, activity feed, team, and service configuration.
- Customer tracking link concept.
- Sky-blue theme, charcoal dark mode, stage colors, rounded cards, compact employee workflows.

## Existing Prototype Behavior To Replace For Production

- `localStorage` and `sessionStorage` business state.
- Demo-only owner and employee login.
- Fixed OTP behavior in the browser.
- Client-only role enforcement.
- Snapshot-based customer tracking URLs.
- In-browser simulated WhatsApp delivery as the only message store.
- Single-service job model.
- One-price-per-service model.
- Photos stored as browser data URLs.
- Financial state stored directly on job objects.

## Architecture Decisions

- Backend: keep the existing Fastify direction already configured in `apps/api`.
- Database: PostgreSQL through Prisma migrations.
- Validation: Zod schemas shared where practical from `packages/shared`.
- Frontend: React, TypeScript, Vite in `apps/web`.
- Auth: secure cookie-backed sessions stored in the database.
- Passwords: Argon2 through `@node-rs/argon2`.
- OTP: provider abstraction with development-only fixed OTP when `DEV_OTP_ENABLED=true`.
- Storage: `StorageProvider` abstraction with local filesystem storage under `.local-data/uploads`.
- Messaging: `MessagingProvider` abstraction with local message logging first.
- Audit: centralized audit service called by all important mutations.
- Tenant isolation: every organization-owned API query must be scoped through authenticated organization membership.

## Shared Domain Model

`packages/shared` should define:

- Role, permission, and portal constants.
- Job workflow stages and allowed transitions.
- Booking, invoice, payment, inspection, inventory, message, and notification enums.
- Indian phone and registration-number normalization helpers.
- Zod schemas for public API DTOs.
- Business invariants that can be reused by API tests and UI validation.

## Backend Module Boundaries

`apps/api/src` should be organized around:

- `config`: environment parsing and runtime mode checks.
- `db`: Prisma client and transaction helpers.
- `auth`: owner password auth, employee OTP auth, sessions, rate limits.
- `tenancy`: organization and branch scoping helpers.
- `audit`: immutable audit logging.
- `modules`: domain routes and services for employees, customers, vehicles, services, bookings, jobs, inspections, files, messages, invoices, payments, expenses, inventory, reports, notifications, and settings.
- `providers`: OTP, messaging, and storage interfaces plus local implementations.
- `http`: Fastify app, error handling, CORS, headers, request ids, health endpoints.
- `scripts`: development seed and operational CLI utilities.

## Frontend Module Boundaries

`apps/web/src` should be organized around:

- `app`: router, providers, auth shell.
- `api`: typed API client and error handling.
- `design`: CSS tokens adapted from `prototype/app.css`.
- `features/auth`: owner and employee login cards.
- `features/board`: live board, mobile stage map, job cards, stage updates.
- `features/check-in`: customer/vehicle/service flow.
- `features/jobs`: job detail, assignment, timeline, notes.
- `features/inspections`: vehicle condition records and damage items.
- `features/photos`: upload and gallery.
- `features/billing`: invoices, payments, outstanding, delivery.
- `features/settings`: business, branches, employees, services, workflow, QC.
- `features/reports`: dashboard, reports, CSV export.
- `features/tracking`: public customer status page.

## Milestone Plan

### M1 - Core Platform

Deliver database schema and migration foundation for organizations, branches, users, employee profiles, sessions, OTP challenges, and audit logs. Implement Fastify app bootstrap, health endpoints, secure headers, CORS, structured errors, owner auth, employee OTP auth, owner-managed employee creation, authorization guards, seed data, and core auth tests.

Exit criteria:

- Migrations run from an empty database.
- Seed creates Sparkle Car Wash, Suresh owner, and Ravi/Salim/Anu employees.
- Owner can login with username/email and password.
- Owner can add/deactivate employees.
- Employee can only login via mobile OTP when active and owner-created.
- Unknown/inactive employee login fails.
- Auth and employee mutations create audit logs.

### M2 - Customer, Vehicle, Services

Implement customers, vehicles, services, service pricing by vehicle category/branch, duplicate prevention, search, and history foundation.

Exit criteria:

- Customers are searchable by name/mobile/vehicle number.
- Indian plates including BH series normalize consistently.
- Vehicle belongs to a customer and organization.
- Service price snapshots can be used by jobs without later mutation.

### M3 - Job Operations

Implement check-in, jobs, job services, assignments, stage history, board APIs, employee mobile workflow, and React board using real API data.

Exit criteria:

- Walk-in check-in creates customer/vehicle/job as needed.
- Multiple employees can be assigned.
- Board persists and reloads from PostgreSQL.
- Stage changes are one-step and audited.
- Employee role cannot access financial board data.

### M4 - Inspection, Photos, Tracking

Implement vehicle condition records, immutable finalized inspections, local file storage, photo metadata, and secure tracking tokens/pages.

Exit criteria:

- Inspection supports required views and damage items.
- File upload validates type and size.
- Tracking link is non-guessable and exposes only customer-safe data.

### M5 - Messaging

Implement messaging provider abstraction, local provider, templates, message store, and event-triggered non-blocking notifications.

Exit criteria:

- Stage changes and invoice/payment events create message records.
- Messaging failures do not roll back business mutations.

### M6 - Billing

Implement invoices, invoice items, discounts, taxes, add-ons/products, payments, partial payments, credit/pay-later, outstanding, delivery checks, and printable invoice view.

Exit criteria:

- Issued invoice totals are immutable.
- Multiple payments can settle one invoice.
- Outstanding is derived from invoice and payment records.
- Delivery respects business payment settings.

### M7 - Bookings and QC

Implement bookings, rescheduling, capacity checks, arrival conversion, configurable QC checklist, and optional QC-before-ready enforcement.

Exit criteria:

- Walk-ins remain possible.
- Booking conversion creates a job.
- QC blocks ready state only when setting is enabled.

### M8 - Business Management

Implement expenses, inventory items, inventory transactions, low-stock notifications, CRM tags/follow-ups, and service reminders.

Exit criteria:

- Inventory stock only changes through transactions.
- Expenses and stock mutations are audited.
- Customers due for follow-up are visible to owner.

### M9 - Analytics

Implement dashboards, reports, employee performance, branch comparison, and CSV exports.

Exit criteria:

- Metrics derive from database records.
- Reports filter by date, branch, employee, and service.
- Financial reports distinguish invoiced, collected, outstanding, and expenses.

### M10 - AI Foundation

Add read-only AI assistant boundaries behind a disabled-by-default feature flag if core data is complete.

Exit criteria:

- AI cannot mutate business records.
- AI answers use authoritative database queries.

### M11 - Production Readiness Audit

Run lint, typecheck, tests, build, migration-from-empty test, seed test, local integration test, access-control review, security review, and desktop/mobile UI verification.

Exit criteria:

- Local app works without AWS or Vercel.
- Known deployment prerequisites are documented separately.
- No deployment is performed.

## First Implementation Cut For M1

1. Add Prisma schema and initial migration.
2. Add shared enums and validation schemas.
3. Add Fastify app factory with `/health` and `/ready`.
4. Add environment parser and local development guards.
5. Add Prisma client.
6. Add audit service.
7. Add session service.
8. Add owner login/logout/me.
9. Add employee CRUD for owners.
10. Add employee OTP request/verify with development OTP provider.
11. Add seed script.
12. Add Vitest API tests around authentication and tenant isolation.

## Non-Goals During M1

- Do not modify the prototype.
- Do not deploy.
- Do not add AWS resources.
- Do not build billing, reporting, inventory, or AI before core auth and tenancy are verified.
