/**
 * In-memory rate limiter, CORS allowlist, body size helpers.
 * DEVELOPMENT: defaults are permissive for local testing.
 * PRODUCTION: set ALLOWED_ORIGINS and stricter limits via env.
 */
const crypto = require('crypto');

const buckets = new Map();
let operationsSinceSweep = 0;
const MAX_RATE_LIMIT_BUCKETS = 50000;

function sweepBuckets(now) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.start > bucket.windowMs) buckets.delete(key);
  }
  // Prevent unbounded memory growth if an attacker rotates arbitrary keys.
  while (buckets.size > MAX_RATE_LIMIT_BUCKETS) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey === undefined) break;
    buckets.delete(oldestKey);
  }
}

function rateLimit(key, { windowMs = 60_000, max = 30 } = {}) {
  const now = Date.now();
  if (++operationsSinceSweep >= 256) {
    operationsSinceSweep = 0;
    sweepBuckets(now);
  }
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0, windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) {
    const err = new Error('Too many requests. Try again later.');
    err.code = 'RATE_LIMIT';
    err.status = 429;
    throw err;
  }
  return true;
}

function clientIp(req) {
  // Forwarded headers are attacker-controlled unless a trusted reverse proxy
  // is explicitly configured. Default to the TCP peer, not X-Forwarded-For.
  const peer = req.socket?.remoteAddress || req.connection?.remoteAddress;
  if (process.env.TRUST_PROXY === 'true' && peer) {
    const forwarded = (req.headers['x-forwarded-for'] || '')
      .toString().split(',').map((part) => part.trim()).filter(Boolean);
    // Common reverse proxies append the address they observed at the end.
    // Configure TRUST_PROXY only when the edge proxy overwrites/appends safely.
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return peer || 'unknown';
}

function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || 'http://localhost:8080,http://127.0.0.1:8080,http://localhost:3000,capacitor://localhost,http://localhost';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  const list = allowedOrigins();
  if (!origin) return;
  if (list.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (list.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function isOwner(userId) {
  const ownerId = process.env.OWNER_USER_ID || '';
  return !!(ownerId && userId && ownerId === userId);
}

function assertActive(user) {
  if (!user || user.status !== 'active') {
    const e = new Error('Account unavailable');
    e.code = 'ACCOUNT_STATUS';
    e.status = 403;
    throw e;
  }
}

function shortTicket(payload, secret, ttlSec = 60) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function parseTicket(token, secret) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig !== expect) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

module.exports = {
  rateLimit,
  clientIp,
  applyCors,
  allowedOrigins,
  isOwner,
  assertActive,
  shortTicket,
  parseTicket
};
