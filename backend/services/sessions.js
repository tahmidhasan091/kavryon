const crypto = require('crypto');
const { uuid } = require('./crypto');
const db = require('../database/db');
const { jwtSign, jwtVerify } = require('../core/mini');

const SECRET = () => process.env.JWT_SECRET || 'CHANGE_ME_DEV_ONLY';
const ACCESS_TTL = Number(process.env.ACCESS_TOKEN_TTL_SEC || 3600);
const REFRESH_TTL = Number(process.env.REFRESH_TOKEN_TTL_SEC || 7 * 24 * 3600);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function ensureSessionColumns() {
  try {
    const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    if (!cols.includes('refresh_token_hash')) db.exec('ALTER TABLE sessions ADD COLUMN refresh_token_hash TEXT');
    if (!cols.includes('revoked_at')) db.exec('ALTER TABLE sessions ADD COLUMN revoked_at TEXT');
    if (!cols.includes('last_used_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_used_at TEXT');
  } catch (_) {}
}
ensureSessionColumns();

function createSession(userId) {
  ensureSessionColumns();
  const sessionId = uuid();
  const jti = uuid();
  const refreshPlain = crypto.randomBytes(32).toString('hex');
  const refreshHash = hashToken(refreshPlain);
  const now = new Date();
  const expires = new Date(now.getTime() + REFRESH_TTL * 1000);
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_jti, refresh_token_hash, created_at, expires_at, revoked_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(sessionId, userId, jti, refreshHash, now.toISOString(), expires.toISOString(), now.toISOString());
  const access = jwtSign({ sub: userId, jti, sid: sessionId, typ: 'access' }, SECRET(), ACCESS_TTL);
  return { accessToken: access, refreshToken: refreshPlain, expiresIn: ACCESS_TTL, jti, sessionId };
}

function verifyAccess(token) {
  const payload = jwtVerify(token, SECRET());
  if (payload.typ && payload.typ !== 'access') {
    const e = new Error('Invalid token type'); e.code = 'INVALID'; throw e;
  }
  if (!payload.jti) { const e = new Error('Invalid token'); e.code = 'INVALID'; throw e; }
  const row = db.prepare('SELECT * FROM sessions WHERE token_jti = ?').get(payload.jti);
  if (!row || row.revoked_at) { const e = new Error('Session revoked'); e.code = 'REVOKED'; throw e; }
  if (new Date(row.expires_at) < new Date()) { const e = new Error('Session expired'); e.code = 'EXPIRED'; throw e; }
  try { db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id); } catch (_) {}
  return payload;
}

function revokeByJti(jti) {
  if (!jti) return;
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE token_jti = ?`).run(new Date().toISOString(), jti);
}

function revokeAllForUser(userId) {
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), userId);
}

function refreshSession(refreshToken) {
  ensureSessionColumns();
  if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.length < 16) {
    const e = new Error('Invalid refresh token'); e.code = 'INVALID'; throw e;
  }
  const h = hashToken(refreshToken);
  const row = db.prepare('SELECT * FROM sessions WHERE refresh_token_hash = ?').get(h);
  if (!row) {
    const e = new Error('Invalid refresh token'); e.code = 'INVALID'; throw e;
  }
  if (row.revoked_at) {
    revokeAllForUser(row.user_id);
    const e = new Error('Session revoked'); e.code = 'REVOKED'; throw e;
  }
  if (new Date(row.expires_at) < new Date()) {
    const e = new Error('Session expired'); e.code = 'EXPIRED'; throw e;
  }
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);
  return createSession(row.user_id);
}

module.exports = { createSession, verifyAccess, revokeByJti, revokeAllForUser, refreshSession, hashToken, ACCESS_TTL };
