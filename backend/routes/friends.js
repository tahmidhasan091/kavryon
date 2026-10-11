const express = require('express');
const { uuid } = require('../services/crypto');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const presence = require('../multiplayer/presence');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const friends = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_id, f.created_at
       FROM friends f JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ?`
    )
    .all(req.user.id)
    .map((f) => ({ ...f, presence: presence.get(f.id) }));
  const incoming = db
    .prepare(
      `SELECT r.id, u.id as user_id, u.username, u.display_name
       FROM friend_requests r JOIN users u ON u.id = r.from_user_id
       WHERE r.to_user_id = ? AND r.status = 'pending'`
    )
    .all(req.user.id);
  const outgoing = db
    .prepare(
      `SELECT r.id, u.id as user_id, u.username, u.display_name, r.status
       FROM friend_requests r JOIN users u ON u.id = r.to_user_id
       WHERE r.from_user_id = ? AND r.status = 'pending'`
    )
    .all(req.user.id);
  res.json({ friends, incoming, outgoing });
});

router.post('/request', requireAuth, (req, res) => {
  const username = String(req.body.username || '').replace(/^@/, '');
  const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });
  const already = db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(req.user.id, target.id);
  if (already) return res.status(409).json({ error: 'Already friends' });
  const pending = db
    .prepare('SELECT * FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = ?')
    .get(req.user.id, target.id, 'pending');
  if (pending) return res.json({ status: 'pending', message: 'Friend Request Sent' });
  const reverse = db
    .prepare('SELECT * FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = ?')
    .get(target.id, req.user.id, 'pending');
  if (reverse) {
    acceptPair(target.id, req.user.id);
    db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').run('accepted', reverse.id);
    return res.json({ status: 'accepted' });
  }
  db.prepare(
    `INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)`
  ).run(uuid(), req.user.id, target.id, new Date().toISOString());
  res.json({ status: 'pending', message: 'Friend Request Sent' });
});

router.post('/accept', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM friend_requests WHERE id = ? AND to_user_id = ? AND status = ?').get(req.body.requestId, req.user.id, 'pending');
  if (!row) return res.status(404).json({ error: 'Request not found' });
  acceptPair(row.from_user_id, row.to_user_id);
  db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').run('accepted', row.id);
  res.json({ ok: true });
});

router.post('/decline', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM friend_requests WHERE id = ? AND to_user_id = ?').get(req.body.requestId, req.user.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').run('declined', row.id);
  res.json({ ok: true });
});

router.post('/remove', requireAuth, (req, res) => {
  const friendId = req.body.userId;
  db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(req.user.id, friendId);
  db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(friendId, req.user.id);
  res.json({ ok: true });
});

function acceptPair(a, b) {
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').run(a, b, now);
  db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').run(b, a, now);
}

module.exports = router;
