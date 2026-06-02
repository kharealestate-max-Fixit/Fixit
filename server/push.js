// FixIt — Web Push (web-push + VAPID)
// VAPID keys come from env in production; in dev they are generated once and
// persisted to .vapid.json so existing browser subscriptions survive restarts.
import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, query } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAPID_FILE = path.join(__dirname, '.vapid.json');
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@fixit.app';

function loadOrCreateKeys() {
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv) return { publicKey: pub, privateKey: priv };

  if (fs.existsSync(VAPID_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (saved.publicKey && saved.privateKey) return saved;
    } catch { /* regenerate below */ }
  }
  const keys = webpush.generateVAPIDKeys();
  try { fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2)); } catch { /* read-only fs */ }
  return keys;
}

const { publicKey, privateKey } = loadOrCreateKeys();
webpush.setVapidDetails(SUBJECT, publicKey, privateKey);

export const VAPID_PUBLIC_KEY = publicKey;

// Send a push to every subscription for a user; prune ones the browser has
// expired (404/410). Best-effort — never throws into the caller.
export async function sendPush(userId, payload) {
  let subs;
  try {
    subs = await all('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id=$1', [userId]);
  } catch {
    return;
  }
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, body);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        try { await query('DELETE FROM push_subs WHERE endpoint=$1', [s.endpoint]); } catch { /* ignore */ }
      }
    }
  }));
}
