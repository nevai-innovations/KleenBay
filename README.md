# KleenBay

Car wash operations app: track every vehicle through the wash stages, keep customers
updated on WhatsApp, and give owners a live view of their business.

## What's in this repo

| Path | What it is |
|---|---|
| `prototype/` | Clickable UX prototype (static HTML/CSS/JS, sample data, no backend). Deployed to Vercel. |
| `apps/`, `packages/` | Scaffolding for the production app (API, web, shared packages). Work in progress. |
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
