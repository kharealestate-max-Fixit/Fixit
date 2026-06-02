// FixIt — authentication (bcrypt password hashing + JWT sessions)
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.join(__dirname, '.jwt-secret');
const TOKEN_TTL = '30d';

// Stable secret: env in prod; in dev generate once and persist so tokens
// survive restarts.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_FILE)) {
    try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch { /* regen */ }
  }
  const s = crypto.randomBytes(48).toString('hex');
  try { fs.writeFileSync(SECRET_FILE, s); } catch { /* read-only fs */ }
  return s;
}
const JWT_SECRET = loadSecret();

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    return { id: p.sub, role: p.role, email: p.email };
  } catch {
    return null;
  }
}

function tokenFromReq(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

// Require a valid token → sets req.user, else 401.
export function authRequired(req, res, next) {
  const user = verifyToken(tokenFromReq(req));
  if (!user) return res.status(401).json({ error: 'authentication required' });
  req.user = user;
  next();
}

// Attach req.user if a valid token is present; otherwise continue as anonymous.
export function authOptional(req, res, next) {
  req.user = verifyToken(tokenFromReq(req));
  next();
}
