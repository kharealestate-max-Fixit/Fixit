// FixIt Backend — Node.js / Express + ws + PostgreSQL
// Port of the original Python stdlib server (server.py) — same routes, same WS protocol.
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { pool, query, one, all, initDb } from './db.js';
import {
  stripe, stripeEnabled, STRIPE_WEBHOOK_SECRET, STRIPE_PUBLISHABLE_KEY, PUBLIC_URL, PLATFORM_FEE_CENTS,
} from './stripe.js';
import { VAPID_PUBLIC_KEY, sendPush } from './push.js';
import { hashPassword, verifyPassword, signToken, verifyToken, authRequired, authOptional } from './auth.js';
import { analyzeIssue, activeProvider } from './vision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = parseInt(process.env.PORT || '3001', 10);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

// ─── ANSI colours for pretty logs ────────────────────────────────────────────
const C = { R: '\x1b[91m', G: '\x1b[92m', Y: '\x1b[93m', B: '\x1b[94m', M: '\x1b[95m', C: '\x1b[96m', W: '\x1b[0m' };
const log = (colour, tag, msg) => console.log(`${colour}[${tag}]${C.W} ${msg}`);

// ─── Haversine distance (miles) ──────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dlat = rad(lat2 - lat1);
  const dlng = rad(lng2 - lng1);
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dlng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET — userId → Set<socket>
// ═══════════════════════════════════════════════════════════════════════════
const wsClients = new Map(); // string userId → Set<ws>

function broadcastToUser(userId, payload) {
  const msg = JSON.stringify(payload);
  const set = wsClients.get(String(userId));
  if (!set) return;
  for (const sock of set) {
    try { if (sock.readyState === sock.OPEN) sock.send(msg); } catch { /* ignore */ }
  }
}

async function handleWsMessage(sock, userId, msg) {
  const t = msg.type;
  if (t === 'ping') {
    sock.send(JSON.stringify({ type: 'pong' }));
  } else if (t === 'typing') {
    const roomId = msg.chatRoomId;
    if (roomId) {
      const room = await one('SELECT * FROM chat_rooms WHERE id=$1', [roomId]);
      if (room) {
        const recipient = userId === String(room.homeowner_id) ? room.contractor_id : room.homeowner_id;
        broadcastToUser(recipient, { type: 'typing', chatRoomId: roomId, userId });
      }
    }
  } else if (t === 'mark_read') {
    const roomId = msg.chatRoomId;
    if (roomId) {
      await query(
        'UPDATE messages SET read_at=now() WHERE room_id=$1 AND sender_id<>$2 AND read_at IS NULL',
        [roomId, userId]
      );
    }
  }
}

// Wrap async route handlers so rejected promises become 500s (matches the
// Python server's blanket try/except around every handler).
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  log(C.R, 'ERR', String(e.message || e));
  if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
});

// Mark a booking paid and notify its contractor (shared by the simulated path
// and the Stripe webhook). Idempotent — re-delivered webhooks are harmless.
async function confirmBookingPaid(bookingId, amount) {
  await query("UPDATE bookings SET status='paid', paid_at=now() WHERE id=$1 AND status<>'paid'", [bookingId]);
  const cRow = await one(
    'SELECT c.owner_user_id FROM contractors c JOIN bookings b ON b.contractor_id=c.id WHERE b.id=$1',
    [bookingId]
  );
  if (cRow) {
    broadcastToUser(cRow.owner_user_id, {
      type: 'booking_paid', bookingId,
      message: 'Payment received! Job confirmed.', amount,
    });
    sendPush(cRow.owner_user_id, {
      title: '💰 Payment received',
      body: 'Job confirmed — payment received.',
      tag: `paid-${bookingId}`, url: '/',
    });
  }
}

// ─── Stripe webhook (raw body, signature-verified) ────────────────────────────
async function stripeWebhook(req, res) {
  if (!stripeEnabled()) return res.status(503).json({ error: 'stripe not configured' });
  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      // No signing secret set (e.g. local CLI without --print-secret) — parse unverified.
      event = JSON.parse(req.body.toString('utf8'));
      log(C.Y, 'PAY', 'webhook received WITHOUT signature verification (set STRIPE_WEBHOOK_SECRET)');
    }
  } catch (e) {
    log(C.R, 'PAY', `webhook signature failed: ${e.message || e}`);
    return res.status(400).send(`Webhook Error: ${e.message || e}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const bookingId = parseInt(intent.metadata?.bookingId || '0', 10);
    if (bookingId) {
      await confirmBookingPaid(bookingId, intent.amount);
      log(C.G, 'PAY', `payment_intent.succeeded → booking ${bookingId} marked paid`);
    }
  }
  res.json({ received: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPRESS APP
// ═══════════════════════════════════════════════════════════════════════════
const app = express();
app.use(cors());
// Stripe webhook must read the raw body for signature verification, so it is
// mounted with express.raw BEFORE the global JSON parser.
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), h(stripeWebhook));
app.use(express.json({ limit: '10mb' }));

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: Date.now() / 1000, ws_users: wsClients.size });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════
const publicUser = (u) => ({
  id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name,
  role: u.role, phone: u.phone, contractorId: u.contractor_id ?? null,
});

app.post('/api/auth/signup', h(async (req, res) => {
  const b = req.body || {};
  const email = (b.email || '').trim().toLowerCase();
  const password = b.password || '';
  const firstName = (b.firstName || '').trim();
  const lastName = (b.lastName || '').trim();
  const role = b.role === 'contractor' ? 'contractor' : 'homeowner';

  if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  if (!firstName || !lastName) return res.status(400).json({ error: 'first and last name required' });

  const existing = await one('SELECT id FROM users WHERE lower(email)=$1', [email]);
  if (existing) return res.status(409).json({ error: 'email already registered' });

  const password_hash = await hashPassword(password);
  const user = await one(`
    INSERT INTO users (email, phone, first_name, last_name, role, password_hash)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
  `, [email, b.phone || null, firstName, lastName, role, password_hash]);

  // Contractors get a business profile so they show up in search immediately.
  if (role === 'contractor') {
    const avatar = (firstName[0] || '?').toUpperCase() + (lastName[0] || '').toUpperCase();
    const specialties = Array.isArray(b.specialties) && b.specialties.length ? b.specialties : ['General Repair'];
    const c = await one(`
      INSERT INTO contractors (owner_user_id, business_name, avatar, specialties, base_price, lat, lng, verified, licensed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,0) RETURNING id
    `, [
      user.id,
      (b.businessName || `${firstName} ${lastName}`).trim(),
      avatar,
      JSON.stringify(specialties),
      Number(b.basePrice) || 150,
      Number(b.lat) || 34.0522,
      Number(b.lng) || -118.2437,
    ]);
    user.contractor_id = c.id;
  }

  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

app.post('/api/auth/login', h(async (req, res) => {
  const b = req.body || {};
  const email = (b.email || '').trim().toLowerCase();
  const password = b.password || '';
  const user = await one('SELECT * FROM users WHERE lower(email)=$1', [email]);
  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'invalid email or password' });
  }
  const c = user.role === 'contractor'
    ? await one('SELECT id FROM contractors WHERE owner_user_id=$1', [user.id])
    : null;
  user.contractor_id = c?.id ?? null;
  res.json({ token: signToken(user), user: publicUser(user) });
}));

app.get('/api/auth/me', authRequired, h(async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const c = user.role === 'contractor'
    ? await one('SELECT id FROM contractors WHERE owner_user_id=$1', [user.id])
    : null;
  user.contractor_id = c?.id ?? null;
  res.json({ user: publicUser(user) });
}));

// ─── Contractors nearby ───────────────────────────────────────────────────────
app.get('/api/contractors/nearby', h(async (req, res) => {
  let lat, lng, radius, category;
  try {
    lat = parseFloat(req.query.lat ?? '34.052');
    lng = parseFloat(req.query.lng ?? '-118.248');
    radius = parseFloat(req.query.radius ?? '10');
    category = req.query.category ?? null;
    if ([lat, lng, radius].some(Number.isNaN)) throw new Error('NaN');
  } catch {
    return res.status(400).json({ error: 'invalid params' });
  }

  const rows = await all(
    "SELECT c.*, u.first_name||' '||u.last_name AS owner_name, u.phone FROM contractors c JOIN users u ON c.owner_user_id=u.id WHERE c.status <> 'offline'"
  );

  const results = [];
  for (const r of rows) {
    const d = haversine(lat, lng, r.lat, r.lng);
    if (d > radius) continue;
    const specs = JSON.parse(r.specialties);
    if (category && !specs.includes(category)) continue;
    const etaMin = Math.max(15, Math.trunc(d * 2 * 60)); // rough: 30mph
    results.push({
      id: r.id, business_name: r.business_name,
      avatar: r.avatar, rating: r.rating,
      review_count: r.review_count, verified: Boolean(r.verified),
      licensed: Boolean(r.licensed), status: r.status,
      base_price: r.base_price, specialties: specs,
      distance_miles: Math.round(d * 10) / 10,
      eta_human: etaMin < 60 ? `~${etaMin}min` : `~${Math.trunc(etaMin / 60)}h`,
      owner_name: r.owner_name, phone: r.phone,
      jobs_done: r.jobs_done,
    });
  }

  results.sort((a, b) => {
    const sa = a.status === 'available' ? 0 : 1;
    const sb = b.status === 'available' ? 0 : 1;
    return sa - sb || a.distance_miles - b.distance_miles;
  });
  res.json({ contractors: results, count: results.length });
}));

// ─── Single contractor ────────────────────────────────────────────────────────
app.get('/api/contractors/:id(\\d+)', h(async (req, res) => {
  const cid = parseInt(req.params.id, 10);
  const row = await one(
    "SELECT c.*, u.first_name||' '||u.last_name AS owner_name FROM contractors c JOIN users u ON c.owner_user_id=u.id WHERE c.id=$1",
    [cid]
  );
  if (!row) return res.status(404).json({ error: 'not found' });
  row.specialties = JSON.parse(row.specialties);
  res.json(row);
}));

// ─── Reviews ──────────────────────────────────────────────────────────────────
app.get('/api/contractors/:id(\\d+)/reviews', h(async (req, res) => {
  const cid = parseInt(req.params.id, 10);
  const rows = await all(`
    SELECT rv.id, rv.rating, rv.comment, rv.created_at,
      u.first_name||' '||SUBSTR(u.last_name,1,1)||'.' AS reviewer
    FROM reviews rv JOIN users u ON rv.homeowner_id=u.id
    WHERE rv.contractor_id=$1 ORDER BY rv.created_at DESC
  `, [cid]);
  res.json(rows);
}));

// Homeowner leaves a review for a paid booking (once).
app.post('/api/reviews', authRequired, h(async (req, res) => {
  if (req.user.role !== 'homeowner') return res.status(403).json({ error: 'only homeowners can review' });
  const b = req.body || {};
  const rating = Math.max(1, Math.min(5, parseInt(b.rating, 10) || 0));
  if (!rating) return res.status(400).json({ error: 'rating 1-5 required' });

  const booking = await one('SELECT * FROM bookings WHERE id=$1', [b.bookingId]);
  if (!booking) return res.status(404).json({ error: 'booking not found' });
  if (booking.homeowner_id !== req.user.id) return res.status(403).json({ error: 'not your booking' });
  if (booking.status !== 'paid') return res.status(400).json({ error: 'you can review after the job is paid' });

  const dup = await one('SELECT id FROM reviews WHERE booking_id=$1', [booking.id]);
  if (dup) return res.status(409).json({ error: 'already reviewed' });

  await query(`
    INSERT INTO reviews (booking_id, contractor_id, homeowner_id, rating, comment)
    VALUES ($1,$2,$3,$4,$5)
  `, [booking.id, booking.contractor_id, req.user.id, rating, (b.comment || '').trim() || null]);

  // Recompute the contractor's rating + count from real reviews.
  const agg = await one(
    'SELECT ROUND(AVG(rating)::numeric,1)::float AS avg, COUNT(*)::int AS cnt FROM reviews WHERE contractor_id=$1',
    [booking.contractor_id]
  );
  await query('UPDATE contractors SET rating=$1, review_count=$2 WHERE id=$3',
    [agg.avg, agg.cnt, booking.contractor_id]);

  res.status(201).json({ success: true, rating: agg.avg, review_count: agg.cnt });
}));

// ─── Create booking ───────────────────────────────────────────────────────────
app.post('/api/bookings', authOptional, h(async (req, res) => {
  const b = req.body || {};
  const homeownerId = req.user?.id ?? b.homeownerId ?? 4;
  const booking = await one(`
    INSERT INTO bookings (homeowner_id, contractor_id, category, description, est_price, scheduled_at)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
  `, [homeownerId, b.contractorId, b.category, b.description, b.estPrice, b.scheduledAt]);

  const ownerRow = await one('SELECT owner_user_id FROM contractors WHERE id=$1', [b.contractorId]);
  const room = await one(`
    INSERT INTO chat_rooms (booking_id, homeowner_id, contractor_id)
    VALUES ($1,$2,$3) RETURNING id
  `, [booking.id, homeownerId, ownerRow?.owner_user_id]);
  const roomId = room.id;

  if (ownerRow) {
    broadcastToUser(ownerRow.owner_user_id, {
      type: 'new_lead',
      booking: { ...booking, chatRoomId: roomId },
      message: 'New job request!',
    });
    sendPush(ownerRow.owner_user_id, {
      title: '🔧 New job request',
      body: `${booking.category || 'Repair'}: ${(booking.description || '').slice(0, 80)}`,
      tag: `lead-${booking.id}`, url: '/',
    });
  }

  res.status(201).json({ booking, chatRoomId: roomId });
}));

// ─── Get bookings ─────────────────────────────────────────────────────────────
app.get('/api/bookings', authOptional, h(async (req, res) => {
  const role = req.user?.role ?? req.query.role ?? 'homeowner';
  const userId = req.user?.id ?? parseInt(req.query.userId ?? '4', 10);
  const where = role === 'contractor' ? 'c.owner_user_id=$1' : 'b.homeowner_id=$1';
  const rows = await all(`
    SELECT b.*, c.business_name AS contractor_name,
      u.first_name||' '||u.last_name AS homeowner_name,
      cr.id AS chat_room_id,
      (rv.id IS NOT NULL) AS reviewed
    FROM bookings b
    JOIN contractors c ON b.contractor_id=c.id
    JOIN users u ON b.homeowner_id=u.id
    LEFT JOIN chat_rooms cr ON cr.booking_id=b.id
    LEFT JOIN reviews rv ON rv.booking_id=b.id
    WHERE ${where} ORDER BY b.created_at DESC
  `, [userId]);
  res.json(rows);
}));

// ─── Stripe payment (real if STRIPE_SECRET_KEY set, else simulated) ───────────
app.post('/api/payments/create-intent', h(async (req, res) => {
  const b = req.body || {};
  const contractorId = b.contractorId;
  const bookingId = b.bookingId;
  const amount = b.amount ?? 0;

  if (stripeEnabled()) {
    const contractorRow = await one('SELECT stripe_account FROM contractors WHERE id=$1', [contractorId]);
    const stripeAcct = contractorRow ? contractorRow.stripe_account : null;
    const params = {
      amount,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: { bookingId: String(bookingId ?? ''), contractorId: String(contractorId ?? '') },
    };
    // Destination charge: platform keeps the $9.99 fee, the rest is routed to
    // the contractor's connected account. Only possible once they've onboarded.
    if (stripeAcct) {
      params.application_fee_amount = PLATFORM_FEE_CENTS;
      params.transfer_data = { destination: stripeAcct };
    }
    const intent = await stripe.paymentIntents.create(params);
    await query('UPDATE bookings SET stripe_intent=$1 WHERE id=$2', [intent.id, bookingId]);
    // NOTE: booking stays "pending" until payment_intent.succeeded arrives via webhook.
    return res.json({
      clientSecret: intent.client_secret,
      intentId: intent.id,
      connected: Boolean(stripeAcct),
    });
  }

  // Simulated intent (no Stripe key set) — confirms synchronously for the demo.
  const rand = () => Math.trunc(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const intentId = `pi_demo_${rand()}${rand()}`;
  const fakeSecret = `${intentId}_secret_${rand()}${rand()}`;
  await query('UPDATE bookings SET stripe_intent=$1 WHERE id=$2', [intentId, bookingId]);
  await confirmBookingPaid(bookingId, amount);

  res.json({
    clientSecret: fakeSecret, simulated: true,
    note: 'Set STRIPE_SECRET_KEY env var for real payments',
  });
}));

// Frontend asks this to decide between the real Stripe card form and the demo flow.
app.get('/api/payments/config', (req, res) => {
  res.json({
    enabled: stripeEnabled() && Boolean(STRIPE_PUBLISHABLE_KEY),
    publishableKey: STRIPE_PUBLISHABLE_KEY,
  });
});

// Called after the browser confirms a card payment — verifies the PaymentIntent
// with Stripe and marks the booking paid (so we don't depend on the webhook).
app.post('/api/payments/confirm', authOptional, h(async (req, res) => {
  const bookingId = req.body?.bookingId;
  const booking = await one('SELECT * FROM bookings WHERE id=$1', [bookingId]);
  if (!booking) return res.status(404).json({ error: 'booking not found' });
  if (booking.status === 'paid') return res.json({ status: 'paid' });

  if (stripeEnabled() && booking.stripe_intent) {
    const intent = await stripe.paymentIntents.retrieve(booking.stripe_intent);
    if (intent.status === 'succeeded') {
      await confirmBookingPaid(bookingId, intent.amount);
      return res.json({ status: 'paid' });
    }
    return res.json({ status: intent.status });
  }
  res.json({ status: booking.status });
}));

// ─── Stripe Connect onboarding (contractors get paid out) ─────────────────────
// Creates/reuses an Express connected account for a contractor and returns a
// hosted onboarding link. The contractor's account id is stored on the row.
app.post('/api/connect/onboard', h(async (req, res) => {
  if (!stripeEnabled()) {
    return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' });
  }
  const contractorId = req.body?.contractorId;
  const contractor = await one(
    'SELECT c.*, u.email FROM contractors c JOIN users u ON c.owner_user_id=u.id WHERE c.id=$1',
    [contractorId]
  );
  if (!contractor) return res.status(404).json({ error: 'contractor not found' });

  let acctId = contractor.stripe_account;
  if (!acctId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: contractor.email || undefined,
      business_type: 'individual',
      business_profile: { name: contractor.business_name },
      capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
      metadata: { contractorId: String(contractorId) },
    });
    acctId = account.id;
    await query('UPDATE contractors SET stripe_account=$1 WHERE id=$2', [acctId, contractorId]);
  }

  const link = await stripe.accountLinks.create({
    account: acctId,
    refresh_url: `${PUBLIC_URL}/?connect=refresh&contractorId=${contractorId}`,
    return_url: `${PUBLIC_URL}/?connect=done&contractorId=${contractorId}`,
    type: 'account_onboarding',
  });

  res.json({ accountId: acctId, onboardingUrl: link.url });
}));

// Connect account status — whether the contractor can accept charges / payouts.
app.get('/api/connect/status', h(async (req, res) => {
  if (!stripeEnabled()) {
    return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' });
  }
  const contractorId = parseInt(req.query.contractorId ?? '0', 10);
  const contractor = await one('SELECT stripe_account FROM contractors WHERE id=$1', [contractorId]);
  if (!contractor) return res.status(404).json({ error: 'contractor not found' });
  if (!contractor.stripe_account) {
    return res.json({ onboarded: false, chargesEnabled: false, payoutsEnabled: false });
  }
  const acct = await stripe.accounts.retrieve(contractor.stripe_account);
  res.json({
    onboarded: acct.details_submitted,
    chargesEnabled: acct.charges_enabled,
    payoutsEnabled: acct.payouts_enabled,
    accountId: acct.id,
  });
}));

// ─── Chat messages ────────────────────────────────────────────────────────────
app.get('/api/chat/:roomId(\\d+)/messages', h(async (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const limit = parseInt(req.query.limit ?? '50', 10);
  const rows = await all(`
    SELECT m.*, u.first_name||' '||u.last_name AS sender_name
    FROM messages m JOIN users u ON m.sender_id=u.id
    WHERE m.room_id=$1 ORDER BY m.created_at DESC LIMIT $2
  `, [roomId, limit]);
  res.json(rows.reverse());
}));

app.post('/api/chat/:roomId(\\d+)/messages', authOptional, h(async (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const b = req.body || {};
  const senderId = req.user?.id ?? b.senderId ?? 4;
  const text = (b.text ?? '').trim();
  const msgType = b.type ?? 'text';

  if (!text && msgType === 'text') {
    return res.status(400).json({ error: 'empty message' });
  }

  const inserted = await one(`
    INSERT INTO messages (room_id, sender_id, text, msg_type)
    VALUES ($1,$2,$3,$4) RETURNING id
  `, [roomId, senderId, text, msgType]);

  const msg = await one(`
    SELECT m.*, u.first_name||' '||u.last_name AS sender_name
    FROM messages m JOIN users u ON m.sender_id=u.id WHERE m.id=$1
  `, [inserted.id]);

  const room = await one('SELECT * FROM chat_rooms WHERE id=$1', [roomId]);
  if (room) {
    const recipient = senderId === room.homeowner_id ? room.contractor_id : room.homeowner_id;
    broadcastToUser(recipient, { type: 'new_message', chatRoomId: roomId, message: msg });
    sendPush(recipient, {
      title: `💬 ${msg.sender_name}`,
      body: msgType === 'text' ? text.slice(0, 120) : '[attachment]',
      tag: `chat-${roomId}`, url: '/',
    });
  }

  res.status(201).json(msg);
}));

// ─── Push subscriptions ───────────────────────────────────────────────────────
// Frontend fetches this to subscribe the browser to web push.
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', authOptional, h(async (req, res) => {
  const b = req.body || {};
  const sub = b.subscription || {};
  const userId = req.user?.id ?? b.userId ?? 4;
  await query(`
    INSERT INTO push_subs (user_id, endpoint, p256dh, auth)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (endpoint) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      p256dh  = EXCLUDED.p256dh,
      auth    = EXCLUDED.auth
  `, [userId, sub.endpoint, sub.keys?.p256dh, sub.keys?.auth]);
  res.json({ success: true });
}));

// ─── AI photo analysis (Gemini / Claude / mock) ───────────────────────────────
// Tells the frontend which provider is active (so it can label "AI" vs "demo").
app.get('/api/analyze/config', (req, res) => {
  res.json({ provider: activeProvider() });
});

app.post('/api/analyze', h(async (req, res) => {
  const b = req.body || {};
  const category = b.category || 'General';
  const description = b.description || '';

  // Accept an image as a data URL ("data:image/jpeg;base64,...") or raw base64.
  let image = null;
  if (b.image && typeof b.image === 'string') {
    const m = b.image.match(/^data:([^;]+);base64,(.*)$/);
    if (m) image = { mediaType: m[1], data: m[2] };
    else image = { mediaType: 'image/jpeg', data: b.image };
  }

  const result = await analyzeIssue({ category, description, image });
  res.json(result);
}));

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', h(async (req, res) => {
  const bookings = (await one('SELECT COUNT(*)::int AS c FROM bookings')).c;
  const msgs = (await one('SELECT COUNT(*)::int AS c FROM messages')).c;
  const users = (await one('SELECT COUNT(*)::int AS c FROM users')).c;
  let conns = 0;
  for (const set of wsClients.values()) conns += set.size;
  res.json({ bookings, messages: msgs, users, ws_connections: conns });
}));

// ─── Static frontend (serves "/" → index.html and /icon.png) ──────────────────
app.use(express.static(PUBLIC_DIR));

// ─── 404 fallback (JSON, matching the Python server) ──────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// ═══════════════════════════════════════════════════════════════════════════
// HTTP + WEBSOCKET SERVER (shared port 3001)
// ═══════════════════════════════════════════════════════════════════════════
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (sock, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Prefer an authenticated token; fall back to the legacy userId query param.
  const tokenUser = verifyToken(url.searchParams.get('token'));
  const userId = tokenUser?.id ?? url.searchParams.get('userId') ?? '0';
  const uid = String(userId);

  if (!wsClients.has(uid)) wsClients.set(uid, new Set());
  wsClients.get(uid).add(sock);
  log(C.C, 'WS', `User ${uid} connected (${url.pathname})`);

  sock.send(JSON.stringify({ type: 'connected', userId }));

  sock.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      sock.send(JSON.stringify({ type: 'error', message: String(e.message || e) }));
      return;
    }
    try {
      await handleWsMessage(sock, uid, msg);
    } catch (e) {
      sock.send(JSON.stringify({ type: 'error', message: String(e.message || e) }));
    }
  });

  sock.on('close', () => {
    const set = wsClients.get(uid);
    if (set) set.delete(sock);
    log(C.Y, 'WS', `User ${uid} disconnected`);
  });

  sock.on('error', () => {});
});

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  await initDb();
  log(C.G, 'DB', 'PostgreSQL ready');
  server.listen(PORT, () => {
    log(C.G, 'UP', `FixIt backend → http://localhost:${PORT}`);
    log(C.B, 'API', `Health: http://localhost:${PORT}/api/health`);
    log(C.B, 'API', `Contractors: http://localhost:${PORT}/api/contractors/nearby?lat=34.052&lng=-118.248`);
    log(C.Y, 'WS', `WebSocket: ws://localhost:${PORT}?userId=1`);
    const prov = activeProvider();
    log(prov !== 'mock' ? C.M : C.Y, 'AI', prov === 'gemini' ? 'Vision AI: Google Gemini' : prov === 'claude' ? 'Vision AI: Anthropic Claude' : 'Vision AI: mock (set GEMINI_API_KEY or ANTHROPIC_API_KEY)');
    log(stripeEnabled() ? C.M : C.Y, 'PAY', stripeEnabled() ? 'Stripe: LIVE (real payments + Connect)' : 'Stripe: simulated (set STRIPE_SECRET_KEY)');
    log(C.W, '---', 'Press Ctrl+C to stop\n');
  });
}

main().catch((e) => {
  log(C.R, 'FATAL', String(e.message || e));
  process.exit(1);
});
