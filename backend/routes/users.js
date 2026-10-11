const express = require('express');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('./auth');

const router = express.Router();

router.get('/search', requireAuth, (req, res) => {
  let q = String(req.query.username || '').replace(/^@/, '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const rows = db
    .prepare(
      `SELECT id, username, display_name, avatar_id FROM users
       WHERE username LIKE ? COLLATE NOCASE AND status = 'active' LIMIT 20`
    )
    .all(`%${q}%`);
  res.json({ users: rows });
});

router.get('/:id', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE id = ? OR username = ? COLLATE NOCASE').get(req.params.id, req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ user: publicUser(u.id) });
});

router.put('/me/profile', requireAuth, (req, res) => {
  const allowed = ['bio', 'body', 'head', 'hair', 'face', 'outfit', 'accessory', 'display_name'];
  const p = req.body || {};
  if (p.display_name) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(p.display_name).slice(0, 32), req.user.id);
  }
  const cur = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id);
  const next = { ...cur };
  for (const k of ['bio', 'body', 'head', 'hair', 'face', 'outfit', 'accessory']) {
    if (p[k] !== undefined) next[k] = String(p[k]).slice(0, 80);
  }
  db.prepare(
    `UPDATE profiles SET bio=?, body=?, head=?, hair=?, face=?, outfit=?, accessory=? WHERE user_id=?`
  ).run(next.bio, next.body, next.head, next.hair, next.face, next.outfit, next.accessory, req.user.id);
  res.json({ user: publicUser(req.user.id) });
});

module.exports = router;
