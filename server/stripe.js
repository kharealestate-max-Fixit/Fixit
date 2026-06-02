// FixIt — Stripe client + helpers (real payments via Stripe Connect)
// When STRIPE_SECRET_KEY is unset, `stripe` is null and callers fall back to
// the simulated payment path — so the app runs end-to-end with zero config.
import Stripe from 'stripe';

// Only treat it as a real key if it looks like one — guards against a blank or
// placeholder value accidentally enabling (and breaking) live payments.
const SECRET = (process.env.STRIPE_SECRET_KEY || '').trim();
const SECRET_VALID = SECRET.startsWith('sk_');
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
// Publishable key — safe to expose to the browser for Stripe.js / Elements.
export const STRIPE_PUBLISHABLE_KEY = (process.env.STRIPE_PUBLISHABLE_KEY || '').trim();

// Public origin used to build Connect onboarding return/refresh URLs.
// RENDER_EXTERNAL_URL is auto-set when deployed on Render.
export const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${process.env.PORT || 3001}`;

// Platform fee taken per booking, in cents ($9.99). Matches the homeowner fee.
export const PLATFORM_FEE_CENTS = parseInt(process.env.PLATFORM_FEE_CENTS || '999', 10);

export const stripe = SECRET_VALID
  ? new Stripe(SECRET, { apiVersion: '2024-06-20' })
  : null;

export const stripeEnabled = () => stripe !== null;
