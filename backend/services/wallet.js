const { uuid } = require('./crypto');
const db = require('../database/db');
const economy = require('./economy');

const CURRENCY = economy.CURRENCY;

function getBalance(userId) {
  const row = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId);
  return row ? row.balance : 0;
}

function credit(userId, amount, type, purchaseId, note) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Credit amount must be positive integer');
  const tx = db.transaction(() => {
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(amount, userId);
    const id = uuid();
    db.prepare(
      `INSERT INTO currency_transactions
       (transaction_id, user_id, type, amount, currency, purchase_id, status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)`
    ).run(id, userId, type, amount, CURRENCY, purchaseId || null, note || null, new Date().toISOString());
    return id;
  });
  return tx();
}

function debit(userId, amount, type, note) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Debit amount must be positive integer');
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId);
    if (!row || row.balance < amount) {
      const err = new Error('Insufficient Kavx');
      err.code = 'INSUFFICIENT';
      throw err;
    }
    db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').run(amount, userId);
    const id = uuid();
    db.prepare(
      `INSERT INTO currency_transactions
       (transaction_id, user_id, type, amount, currency, purchase_id, status, note, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'completed', ?, ?)`
    ).run(id, userId, type, -amount, CURRENCY, note || null, new Date().toISOString());
    return { id, balance: row.balance - amount };
  });
  return tx();
}

function history(userId, limit = 50, offset = 0) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  return db
    .prepare(
      `SELECT * FROM currency_transactions WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(userId, lim, off);
}

module.exports = { getBalance, credit, debit, history, CURRENCY };
