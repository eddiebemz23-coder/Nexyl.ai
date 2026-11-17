const crypto = require('crypto');
const jwt = require('jsonwebtoken');

let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] JWT_SECRET not set. Using a random secret; sessions reset on restart. Set JWT_SECRET in .env.');
}

const EXPIRES_IN = '7d';

function sign(user) {
  return jwt.sign({ sub: user.id, name: user.name }, SECRET, { expiresIn: EXPIRES_IN });
}

// Returns the signed-in user, or null when the bearer token is missing or invalid.
function verifyHeader(authorization) {
  const token = String(authorization || '').startsWith('Bearer ') ? String(authorization).slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SECRET);
    return { id: payload.sub, name: payload.name };
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!String(header).startsWith('Bearer ')) return res.status(401).json({ error: 'Not signed in' });
  const user = verifyHeader(header);
  if (!user) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  req.user = user;
  next();
}

// Counter shared by both transports: one call per request, keyed by caller + route.
// Fine for a prototype on a single process; use Redis when several isolates must agree.
function limiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs);
  timer.unref?.();

  return (key) => {
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, reset: now + windowMs };
    if (entry.reset < now) {
      entry.count = 0;
      entry.reset = now + windowMs;
    }
    entry.count += 1;
    hits.set(key, entry);
    if (entry.count > max) return { allowed: false, retryAfterSec: Math.ceil((entry.reset - now) / 1000) };
    return { allowed: true };
  };
}

function rateLimit(opts) {
  const limit = limiter(opts);
  return (req, res, next) => {
    const verdict = limit(`${req.ip}:${req.path}`);
    if (!verdict.allowed) {
      res.set('Retry-After', verdict.retryAfterSec);
      return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
    }
    next();
  };
}

module.exports = { sign, verifyHeader, requireAuth, rateLimit, limiter };

