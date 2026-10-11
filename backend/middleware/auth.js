/**
 * LEGACY Express middleware — not used by backend/server.js (mini framework).
 * If mounted, never use a hardcoded production secret.
 */
const db = require('../database/db');

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET required in production');
    }
    return process.env.JWT_SECRET || 'dev-only-not-for-production-use';
  }
  return s;
}

function requireAuth(req, res, next) {
  let jwt;
  try { jwt = require('jsonwebtoken'); } catch {
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    const payload = jwt.verify(token, getSecret());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Account unavailable' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Login expired' });
  }
}

/** Creator Mode is free — this only ensures developer_mode flag is set. */
function requireDeveloper(req, res, next) {
  if (!req.user.developer_mode) {
    try {
      db.prepare('UPDATE users SET developer_mode = 1 WHERE id = ?').run(req.user.id);
      req.user.developer_mode = 1;
    } catch (_) {
      return res.status(403).json({ error: 'Creator Mode unavailable' });
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = { requireAuth, requireDeveloper, requireAdmin };
