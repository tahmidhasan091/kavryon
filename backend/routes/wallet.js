/**
 * LEGACY Express wallet routes — NOT mounted by backend/server.js.
 * Kept for reference only. Canonical API is in backend/server.js.
 * Creator Mode is FREE. Do not charge for developer_mode.
 */
const express = require('express');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const wallet = require('../services/wallet');
const { KAVX_PACKAGES } = require('../services/products');
const { grantVerifiedPurchase, mintSandboxToken, parseSandboxToken } = require('../payments/verify');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  res.json({
    balance: wallet.getBalance(req.user.id),
    currency: 'KAVX',
    transactions: wallet.history(req.user.id),
    purchases: db.prepare('SELECT id, provider, product_id, status, verified_at, created_at FROM purchases WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id)
  });
});

router.get('/packages', requireAuth, (_req, res) => {
  res.json({ packages: KAVX_PACKAGES, note: 'Displayed prices come from store configuration, not the client.' });
});

router.post('/developer-mode', requireAuth, (req, res) => {
  if (!req.user.developer_mode) {
    db.prepare('UPDATE users SET developer_mode = 1 WHERE id = ?').run(req.user.id);
  }
  res.json({ already: true, developer_mode: true, free: true, balance: wallet.getBalance(req.user.id) });
});

module.exports = router;
