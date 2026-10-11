const { uuid } = require('./crypto');
const db = require('../database/db');
const economy = require('./economy');

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getDaily(userId) {
  const day = dayKey();
  let row = db.prepare('SELECT * FROM economy_daily WHERE user_id = ? AND day = ?').get(userId, day);
  if (!row) {
    db.prepare(
      'INSERT OR IGNORE INTO economy_daily (user_id, day, gift_sent_amount, gift_sent_count, creator_earned) VALUES (?, ?, 0, 0, 0)'
    ).run(userId, day);
    row = { user_id: userId, day, gift_sent_amount: 0, gift_sent_count: 0, creator_earned: 0 };
  }
  return row;
}

/**
 * Atomic gift transfer with idempotency.
 * Client cannot set final amount outside validation; server enforces limits.
 */
function sendGift({ senderId, recipientUsername, amount, idempotencyKey }) {
  if (!senderId) {
    const e = new Error('Unauthorized');
    e.code = 'AUTH';
    throw e;
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    const e = new Error('Amount must be a positive integer');
    e.code = 'INVALID_AMOUNT';
    throw e;
  }
  if (amount > economy.GIFT_MAX) {
    const e = new Error('Amount exceeds gift limit');
    e.code = 'LIMIT';
    throw e;
  }
  if (amount < economy.GIFT_MIN) {
    const e = new Error('Amount below minimum');
    e.code = 'INVALID_AMOUNT';
    throw e;
  }
  if (!idempotencyKey || String(idempotencyKey).length < 8 || String(idempotencyKey).length > 128) {
    const e = new Error('Valid idempotency key required');
    e.code = 'IDEMPOTENCY';
    throw e;
  }

  const existing = db.prepare('SELECT * FROM gifts WHERE idempotency_key = ?').get(String(idempotencyKey));
  if (existing) {
    return { duplicate: true, gift: existing, balance: getBalance(senderId) };
  }

  const recipient = db
    .prepare(`SELECT * FROM users WHERE username = ? AND status = 'active'`)
    .get(String(recipientUsername || '').replace(/^@/, ''));
  if (!recipient) {
    const e = new Error('Recipient not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (recipient.id === senderId) {
    const e = new Error('Cannot gift yourself');
    e.code = 'SELF';
    throw e;
  }

  const daily = getDaily(senderId);
  if (daily.gift_sent_count >= economy.GIFT_DAILY_COUNT_LIMIT) {
    const e = new Error('Daily gift count limit reached');
    e.code = 'DAILY_LIMIT';
    throw e;
  }
  if (daily.gift_sent_amount + amount > economy.GIFT_DAILY_SEND_LIMIT) {
    const e = new Error('Daily gift amount limit reached');
    e.code = 'DAILY_LIMIT';
    throw e;
  }

  const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(senderId);
  if (!sender || sender.status !== 'active') {
    const e = new Error('Account restricted');
    e.code = 'RESTRICTED';
    throw e;
  }

  const result = db.transaction(() => {
    // Re-check idempotency inside tx
    const again = db.prepare('SELECT * FROM gifts WHERE idempotency_key = ?').get(String(idempotencyKey));
    if (again) return { duplicate: true, gift: again };

    const bal = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(senderId);
    if (!bal || bal.balance < amount) {
      const e = new Error('Insufficient Kavx');
      e.code = 'INSUFFICIENT';
      throw e;
    }

    db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').run(amount, senderId);
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(amount, recipient.id);

    const senderTx = uuid();
    const recipientTx = uuid();
    const now = new Date().toISOString();
    const giftId = uuid();

    db.prepare(
      `INSERT INTO currency_transactions
       (transaction_id, user_id, type, amount, currency, purchase_id, status, note, created_at)
       VALUES (?, ?, 'GIFT_SENT', ?, 'KAVX', NULL, 'completed', ?, ?)`
    ).run(senderTx, senderId, -amount, 'gift to @' + recipient.username, now);

    db.prepare(
      `INSERT INTO currency_transactions
       (transaction_id, user_id, type, amount, currency, purchase_id, status, note, created_at)
       VALUES (?, ?, 'GIFT_RECEIVED', ?, 'KAVX', NULL, 'completed', ?, ?)`
    ).run(recipientTx, recipient.id, amount, 'gift from @' + sender.username, now);

    db.prepare(
      `INSERT INTO gifts (id, sender_id, recipient_id, amount, status, idempotency_key, sender_tx_id, recipient_tx_id, created_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)`
    ).run(giftId, senderId, recipient.id, amount, String(idempotencyKey), senderTx, recipientTx, now);

    const day = dayKey();
    db.prepare(
      `INSERT INTO economy_daily (user_id, day, gift_sent_amount, gift_sent_count, creator_earned)
       VALUES (?, ?, ?, 1, 0)
       ON CONFLICT(user_id, day) DO UPDATE SET
         gift_sent_amount = gift_sent_amount + excluded.gift_sent_amount,
         gift_sent_count = gift_sent_count + 1`
    ).run(senderId, day, amount);

    const notifId = uuid();
    db.prepare(
      `INSERT INTO notifications (id, user_id, type, title, body, data_json, read, created_at)
       VALUES (?, ?, 'gift', 'Kavx gift received', ?, ?, 0, ?)`
    ).run(
      notifId,
      recipient.id,
      `You received ${amount} Kavx from @${sender.username}.`,
      JSON.stringify({ giftId, from: sender.username, amount }),
      now
    );

    return {
      duplicate: false,
      gift: { id: giftId, amount, recipient: recipient.username, created_at: now },
      balance: bal.balance - amount
    };
  })();

  return result;
}

function getBalance(userId) {
  const row = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId);
  return row ? row.balance : 0;
}

function history(userId, limit = 20, offset = 0) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 20));
  const off = Math.max(0, Number(offset) || 0);
  const sent = db
    .prepare(
      `SELECT g.id, g.amount, g.status, g.created_at, 'sent' as direction, u.username as counterpart
       FROM gifts g JOIN users u ON u.id = g.recipient_id
       WHERE g.sender_id = ?`
    )
    .all(userId);
  const received = db
    .prepare(
      `SELECT g.id, g.amount, g.status, g.created_at, 'received' as direction, u.username as counterpart
       FROM gifts g JOIN users u ON u.id = g.sender_id
       WHERE g.recipient_id = ?`
    )
    .all(userId);
  return sent
    .concat(received)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(off, off + lim);
}

module.exports = { sendGift, history, getDaily };
