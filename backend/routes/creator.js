const express = require('express');
const db = require('../database/db');
const { requireAuth, requireDeveloper } = require('../middleware/auth');
const wallet = require('../services/wallet');

const router = express.Router();
router.use(requireAuth, requireDeveloper);

router.get('/dashboard', (req, res) => {
  const games = db.prepare('SELECT * FROM games WHERE creator_id = ?').all(req.user.id);
  const totals = games.reduce(
    (a, g) => ({ games: a.games + 1, plays: a.plays + g.plays, likes: a.likes + g.likes }),
    { games: 0, plays: 0, likes: 0 }
  );
  const spent = db
    .prepare(`SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) as s FROM currency_transactions WHERE user_id=? AND type='SPEND'`)
    .get(req.user.id).s;
  const earnings = db.prepare('SELECT * FROM creator_earnings WHERE user_id = ?').all(req.user.id);
  res.json({
    totals,
    vynBalance: wallet.getBalance(req.user.id),
    vynSpent: spent,
    creatorRewards: earnings.reduce((n, e) => n + (e.status === 'paid' ? e.amount : 0), 0),
    earnings,
    games,
    note: 'Creator payouts are platform-controlled. No automatic Vyn generation.'
  });
});

module.exports = router;
