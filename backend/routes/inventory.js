const express = require('express');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const items = db
    .prepare(
      `SELECT i.id, i.name, i.kind, i.data_json, inv.qty
       FROM inventory inv JOIN items i ON i.id = inv.item_id
       WHERE inv.user_id = ?`
    )
    .all(req.user.id);
  res.json({ items });
});

module.exports = router;
