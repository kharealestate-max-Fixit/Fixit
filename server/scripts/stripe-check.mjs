// Live Stripe smoke test. Run once you have a test key:
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-check.mjs
//
// It makes REAL calls to Stripe test mode (no charges) to confirm your key and
// Connect settings work: creates a PaymentIntent, an Express connected account,
// and an onboarding link. Nothing is persisted to your DB.
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key || !key.startsWith('sk_test_')) {
  console.error('✗ Set STRIPE_SECRET_KEY to a test key (sk_test_...) first.');
  process.exit(1);
}
const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

try {
  console.log('→ Creating a $194.99 PaymentIntent (platform charge)…');
  const pi = await stripe.paymentIntents.create({
    amount: 19499, currency: 'usd',
    automatic_payment_methods: { enabled: true },
    metadata: { test: 'fixit-stripe-check' },
  });
  console.log(`  ✓ PaymentIntent ${pi.id} (status: ${pi.status})`);

  console.log('→ Creating an Express connected account…');
  const acct = await stripe.accounts.create({
    type: 'express',
    capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
  });
  console.log(`  ✓ Account ${acct.id}`);

  console.log('→ Creating an onboarding link…');
  const link = await stripe.accountLinks.create({
    account: acct.id,
    refresh_url: 'http://localhost:3001/?connect=refresh',
    return_url: 'http://localhost:3001/?connect=done',
    type: 'account_onboarding',
  });
  console.log(`  ✓ Onboarding URL: ${link.url}`);

  console.log('\n✅ Stripe key + Connect are working. You can run the app with this key for real payments.');
} catch (e) {
  console.error(`\n✗ Stripe error: ${e.message}`);
  if (/Connect/i.test(e.message) || e.code === 'account_invalid') {
    console.error('  → Enable Connect at https://dashboard.stripe.com/test/connect/accounts/overview');
  }
  process.exit(1);
}
