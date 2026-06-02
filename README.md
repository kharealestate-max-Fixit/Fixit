# FixIt — AI Home Repair Marketplace

Full-stack app: Node.js/Express backend + React frontend.

## Quick Start (local dev — zero database setup)

```bash
# 1. Install backend deps (once)
cd server && npm install

# 2. Run — boots a self-contained embedded PostgreSQL + the server
npm run dev          # → http://localhost:3001

# 3. Open in browser
# http://localhost:3001  (frontend is served by the backend)
```

`npm run dev` downloads/launches a portable PostgreSQL (via `embedded-postgres`)
into `server/.pgdata` — no system Postgres install required. Delete `.pgdata`
to reset all data.

## Production (managed PostgreSQL)

Point `DATABASE_URL` at any managed Postgres (Railway, Render, Neon, Supabase)
and use `npm start` (SSL is auto-enabled for non-local hosts):

```bash
cd server
DATABASE_URL=postgres://user:pass@host:5432/fixit \
ANTHROPIC_API_KEY=sk-ant-...  \
STRIPE_SECRET_KEY=sk_test_... \
npm start
```

## What's Running

| Component | Tech | Port |
|-----------|------|------|
| API server | Node.js / Express | 3001 |
| WebSocket | `ws` (shares the HTTP port) | 3001 |
| Database | PostgreSQL (`pg`) | 5432 (prod) / 5433 (embedded dev) |
| Frontend | React (served at `/`) | 3001 |

> The original pure-Python backend is kept at `server/server.py` for reference.

## API Endpoints

```
GET  /api/health
GET  /api/contractors/nearby?lat=&lng=&radius=
GET  /api/contractors/:id
POST /api/bookings
GET  /api/bookings?role=contractor&userId=
POST /api/payments/create-intent
GET  /api/chat/:roomId/messages
POST /api/chat/:roomId/messages
POST /api/push/subscribe
POST /api/analyze
GET  /api/stats
WS   ws://localhost:3001?userId=

# Stripe (real payments + Connect)
POST /api/connect/onboard          # → { onboardingUrl } for a contractor
GET  /api/connect/status?contractorId=
POST /api/webhooks/stripe          # payment_intent.succeeded → booking paid
```

## Stripe setup (real payments)

Payments are **simulated** until you add a key, so the app works out of the box.
To enable real Stripe test-mode payments with Connect split payouts:

1. **Get a test secret key** — create a free account, then copy `sk_test_...`
   from <https://dashboard.stripe.com/test/apikeys>.
2. **Enable Connect** — <https://dashboard.stripe.com/test/connect/accounts/overview>
   (needed for contractor payouts / split payments).
3. **Verify your key** (makes real test-mode calls, no charges):
   ```bash
   STRIPE_SECRET_KEY=sk_test_... npm run stripe:check
   ```
4. **Run with payments live.** Copy `.env.example` → `.env`, set `STRIPE_SECRET_KEY`,
   then for webhooks run the [Stripe CLI](https://stripe.com/docs/stripe-cli):
   ```bash
   stripe listen --forward-to localhost:3001/api/webhooks/stripe
   # copy the printed whsec_... into STRIPE_WEBHOOK_SECRET in .env
   npm run dev
   ```

How it works: each booking creates a PaymentIntent with `application_fee_amount`
($9.99 platform fee) and `transfer_data.destination` (the contractor's connected
account). The booking is marked **paid** only when the signed
`payment_intent.succeeded` webhook arrives — production-correct confirmation.
Contractors onboard via `POST /api/connect/onboard` (hosted Stripe Express flow).

## Upgrading to Production

| Swap | With | Status |
|------|------|--------|
| Python backend | Node.js / Express | ✅ done |
| SQLite | PostgreSQL (`pg`) | ✅ done |
| Simulated Stripe | Real `stripe` SDK + Connect | ✅ done |
| Mock push | `web-push` + VAPID | ✅ done |
| Local only | One-click cloud deploy | ✅ ready |

## Deploy (Render — free, web service + Postgres)

The repo includes [`render.yaml`](./render.yaml), a Render Blueprint that
provisions the Node web service **and** a managed PostgreSQL in one shot.

1. Push this repo to GitHub.
2. At <https://dashboard.render.com> → **New +** → **Blueprint** → pick the repo.
3. Render reads `render.yaml`, creates `fixit-db` (Postgres) + the web service,
   wires `DATABASE_URL`, and deploys. Health check: `/api/health`.
4. (Optional) In the service's **Environment** tab, add `ANTHROPIC_API_KEY` /
   `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` to switch AI + payments live.

The frontend is served by the same service (same-origin), so there's nothing
separate to deploy. Push notifications work automatically on the HTTPS URL.
A `Procfile` is also included for Railway/Heroku-style hosts.

## Database

- **Dev:** embedded PostgreSQL in `server/.pgdata` (auto-created by `npm run dev`). Delete the folder to reset.
- **Prod:** set `DATABASE_URL`. Schema + seed are applied idempotently on startup.
- **Push notifications:** VAPID keys auto-generate into `server/.vapid.json` in dev; set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` in prod to keep them stable.

## Seed Data

3 contractors pre-loaded:
- Martinez Pro Plumbing (available, 4.9★)
- BlueRidge Electric (busy, 4.7★)  
- QuickFix Handyman (available, 4.5★)

1 homeowner: Alex Johnson (used for demo bookings)
