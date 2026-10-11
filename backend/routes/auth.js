const express = require('express');
const jwt = require('jsonwebtoken');
const { uuid, hashPassword, verifyPassword } = require('../services/crypto');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const RESERVED = new Set(['admin', 'vyntrix', 'kavryon', 'system', 'moderator', 'support', 'official']);

function validUsername(u) {
  if (!u || typeof u !== 'string') return false;
  if (u.length < 3 || u.length > 20) return false;
  if (!/^[A-Za-z0-9_]+$/.test(u)) return false;
  if (RESERVED.has(u.toLowerCase())) return false;
  return true;
}

router.post('/signup', (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: 'Invalid username' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (exists) return res.status(409).json({ error: 'Username taken' });
  const id = uuid();
  const now = new Date().toISOString();
  const hash = hashPassword(password);
  const display = (displayName || username).slice(0, 32);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, display_name, avatar_id, created_at)
       VALUES (?, ?, ?, ?, 'default', ?)`
    ).run(id, username, hash, display, now);
    db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(id);
    db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 0)').run(id);
  });
  tx();
  const token = jwt.sign({ sub: id, u: username }, process.env.JWT_SECRET || 'dev-secret-change', { expiresIn: '7d' });
  res.json({ token, user: publicUser(id) });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username || '');
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.status !== 'active') return res.status(403).json({ error: 'Account suspended' });
  const token = jwt.sign({ sub: user.id, u: user.username }, process.env.JWT_SECRET || 'dev-secret-change', { expiresIn: '7d' });
  res.json({ token, user: publicUser(user.id) });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user.id) });
});

router.post('/logout', requireAuth, (_req, res) => {
  res.json({ ok: true });
});

function publicUser(id) {
  const u = db.prepare('SELECT id, username, display_name, avatar_id, developer_mode, status, role, created_at FROM users WHERE id = ?').get(id);
  const w = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(id);
  const p = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(id);
  return { ...u, developer_mode: !!u.developer_mode, kavx: w.balance, balance: w.balance, profile: p };
}

module.exports = router;
module.exports.publicUser = publicUser;
module.exports.validUsername = validUsername;
