# FixIt — AI Home Repair Marketplace

Full-stack app: Python backend + React 19 frontend.  
**Zero npm install required.**

## Quick Start

```bash
# 1. Unzip and enter the folder
unzip fixit-app.zip && cd fixit-app

# 2. Run (that's it)
python3 run.py

# 3. Open in browser
# The launcher opens it automatically, or go to:
# file:///path/to/fixit-app/public/index.html
```

## With Real AI + Payments

```bash
ANTHROPIC_API_KEY=sk-ant-...  \
STRIPE_SECRET_KEY=sk_test_... \
python3 run.py
```

## What's Running

| Component | Tech | Port |
|-----------|------|------|
| API server | Python stdlib (zero deps) | 3001 |
| WebSocket | RFC 6455 (pure Python) | 3001 |
| Database | SQLite (built into Python) | file |
| Frontend | React 19 (pre-installed) | file:// |

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
```

## Upgrading to Production

| Swap | With |
|------|------|
| SQLite | PostgreSQL + PostGIS (geo queries) |
| Simulated Stripe | Real `stripe` npm package |
| Mock push | `web-push` npm package + VAPID keys |
| `file://` frontend | Next.js / Vercel deployment |
| Python stdlib WS | `ws` npm package or socket.io |

## Database Location

`server/db/fixit.db` — SQLite file, auto-created on first run.  
Delete it to reset all data.

## Seed Data

3 contractors pre-loaded:
- Martinez Pro Plumbing (available, 4.9★)
- BlueRidge Electric (busy, 4.7★)  
- QuickFix Handyman (available, 4.5★)

1 homeowner: Alex Johnson (used for demo bookings)
