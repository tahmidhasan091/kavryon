const express = require('express');
const { uuid } = require('../services/crypto');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

const REASONS = ['Inappropriate content', 'Harassment', 'Cheating', 'Scam', 'Copyright complaint', 'Exploit', 'Other'];

router.post('/', requireAuth, (req, res) => {
  const { targetType, targetId, reason, details } = req.body || {};
  if (!['user', 'game', 'item'].includes(targetType)) return res.status(400).json({ error: 'Invalid target' });
  if (!REASONS.includes(reason)) return res.status(400).json({ error: 'Invalid reason' });
  db.prepare(
    `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(uuid(), req.user.id, targetType, String(targetId), reason, String(details || '').slice(0, 500), new Date().toISOString());
  res.json({ ok: true });
});

module.exports = router;
