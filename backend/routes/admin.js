const express = require('express');
const { uuid } = require('../services/crypto');
const db = require('../database/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const wallet = require('../services/wallet');
const rooms = require('../multiplayer/rooms');

const router = express.Router();
router.use(requireAuth, requireAdmin);

function log(adminId, action, target, details) {
  db.prepare(
    `INSERT INTO admin_actions (id, admin_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuid(), adminId, action, target || null, details || null, new Date().toISOString());
}

router.get('/overview', (req, res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    games: db.prepare('SELECT COUNT(*) as c FROM games').get().c,
    reports: db.prepare(`SELECT COUNT(*) as c FROM reports WHERE status='open'`).get().c,
    purchases: db.prepare('SELECT COUNT(*) as c FROM purchases').get().c,
    livePlayers: rooms.totalPlayers()
  });
});

router.get('/users', (req, res) => {
  res.json({ users: db.prepare('SELECT id, username, display_name, status, role, developer_mode, created_at FROM users').all() });
});

router.post('/users/:id/status', (req, res) => {
  const status = req.body.status === 'suspended' ? 'suspended' : 'active';
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  log(req.user.id, 'user_status', req.params.id, status);
  res.json({ ok: true });
});

router.get('/games', (req, res) => {
  res.json({ games: db.prepare('SELECT id, name, state, creator_id, plays FROM games').all() });
});

router.post('/games/:id/state', (req, res) => {
  const state = ['SUSPENDED', 'PUBLISHED', 'PRIVATE', 'DRAFT'].includes(req.body.state) ? req.body.state : 'SUSPENDED';
  db.prepare('UPDATE games SET state = ? WHERE id = ?').run(state, req.params.id);
  log(req.user.id, 'game_state', req.params.id, state);
  res.json({ ok: true });
});

router.get('/reports', (req, res) => {
  res.json({ reports: db.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT 200').all() });
});

router.post('/reports/:id/close', (req, res) => {
  db.prepare(`UPDATE reports SET status='closed' WHERE id=?`).run(req.params.id);
  log(req.user.id, 'close_report', req.params.id, '');
  res.json({ ok: true });
});

router.get('/transactions', (req, res) => {
  res.json({ transactions: db.prepare('SELECT * FROM currency_transactions ORDER BY created_at DESC LIMIT 200').all() });
});

router.post('/adjust', (req, res) => {
  const { userId, amount, note } = req.body || {};
  const n = Number(amount);
  if (!userId || !Number.isInteger(n) || n === 0) return res.status(400).json({ error: 'Invalid adjustment' });
  if (n > 0) wallet.credit(userId, n, 'ADMIN_ADJUSTMENT', null, note || 'admin');
  else wallet.debit(userId, Math.abs(n), 'ADMIN_ADJUSTMENT', note || 'admin');
  log(req.user.id, 'adjust_balance', userId, `${n} ${note || ''}`);
  res.json({ balance: wallet.getBalance(userId) });
});

router.get('/actions', (req, res) => {
  res.json({ actions: db.prepare('SELECT * FROM admin_actions ORDER BY created_at DESC LIMIT 200').all() });
});

module.exports = router;
