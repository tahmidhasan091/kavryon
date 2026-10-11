/**
 * Game Pass economy — 60% creator / 40% platform. Server-authoritative.
 */
const db = require('../database/db');
const { uuid } = require('./crypto');

const CREATOR_SHARE_BPS = 6000; // 60.00%
const PLATFORM_SHARE_BPS = 4000; // 40.00%
const PLATFORM_USER = process.env.PLATFORM_USER_ID || null;

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_passes (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      icon TEXT DEFAULT '',
      price_kavx INTEGER NOT NULL,
      benefits_json TEXT DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_passes_game ON game_passes(game_id, active);

    CREATE TABLE IF NOT EXISTS game_pass_purchases (
      id TEXT PRIMARY KEY,
      pass_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      price_kavx INTEGER NOT NULL,
      creator_share INTEGER NOT NULL,
      platform_share INTEGER NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      UNIQUE(pass_id, buyer_id)
    );

    CREATE TABLE IF NOT EXISTS platform_ledger (
      id TEXT PRIMARY KEY,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      ref TEXT,
      created_at TEXT NOT NULL
    );
  `);
}
ensureTables();

function splitRevenue(price) {
  const p = Math.floor(Number(price));
  if (!Number.isInteger(p) || p < 1) throw Object.assign(new Error('Invalid price'), { code: 'BAD_PRICE' });
  const creatorShare = Math.floor((p * CREATOR_SHARE_BPS) / 10000);
  const platformShare = p - creatorShare; // remainder ensures exact sum
  return { creatorShare, platformShare };
}

function createPass({ userId, gameId, name, description, icon, priceKavx, benefits }) {
  const g = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!g || g.creator_id !== userId) throw Object.assign(new Error('Not your game'), { code: 'FORBIDDEN' });
  if (!name || String(name).trim().length < 2) throw Object.assign(new Error('Name required'), { code: 'BAD' });
  const price = Math.floor(Number(priceKavx));
  if (!Number.isInteger(price) || price < 1 || price > 1000000) {
    throw Object.assign(new Error('Price must be 1–1000000 Kavx'), { code: 'BAD_PRICE' });
  }
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO game_passes (id,game_id,creator_id,name,description,icon,price_kavx,benefits_json,active,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,?,?)`
  ).run(id, gameId, userId, String(name).slice(0, 80), String(description || '').slice(0, 500), String(icon || '').slice(0, 200), price, JSON.stringify(benefits || {}), now, now);
  return getPass(id);
}

function getPass(id) {
  const row = db.prepare('SELECT * FROM game_passes WHERE id=?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    gameId: row.game_id,
    creatorId: row.creator_id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    priceKavx: row.price_kavx,
    benefits: (() => { try { return JSON.parse(row.benefits_json || '{}'); } catch { return {}; } })(),
    active: !!row.active,
    createdAt: row.created_at
  };
}

function listPasses(gameId, { includeInactive } = {}) {
  const rows = includeInactive
    ? db.prepare('SELECT * FROM game_passes WHERE game_id=? ORDER BY created_at DESC').all(gameId)
    : db.prepare('SELECT * FROM game_passes WHERE game_id=? AND active=1 ORDER BY created_at DESC').all(gameId);
  return rows.map((row) => getPass(row.id));
}

function setPassActive({ userId, passId, active }) {
  const row = db.prepare('SELECT * FROM game_passes WHERE id=?').get(passId);
  if (!row || row.creator_id !== userId) throw Object.assign(new Error('Not your pass'), { code: 'FORBIDDEN' });
  db.prepare('UPDATE game_passes SET active=?, updated_at=? WHERE id=?').run(active ? 1 : 0, new Date().toISOString(), passId);
  return getPass(passId);
}

/**
 * Atomic purchase: 60% creator / 40% platform.
 * Price is always read from DB at purchase time (immutable for this tx).
 */
function purchasePass({ userId, passId, idempotencyKey }) {
  ensureTables();
  const key = String(idempotencyKey || ('pass_' + passId + '_' + userId)).slice(0, 120);

  // Idempotency hit
  const prior = db.prepare('SELECT * FROM game_pass_purchases WHERE idempotency_key=?').get(key);
  if (prior) {
    return {
      duplicate: true,
      purchaseId: prior.id,
      priceKavx: prior.price_kavx,
      creatorShare: prior.creator_share,
      platformShare: prior.platform_share,
      balance: db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(userId)?.balance || 0
    };
  }

  const already = db.prepare('SELECT * FROM game_pass_purchases WHERE pass_id=? AND buyer_id=?').get(passId, userId);
  if (already) {
    return {
      duplicate: true,
      purchaseId: already.id,
      priceKavx: already.price_kavx,
      creatorShare: already.creator_share,
      platformShare: already.platform_share,
      balance: db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(userId)?.balance || 0
    };
  }

  let result;
  const run = db.transaction(() => {
    const pass = db.prepare('SELECT * FROM game_passes WHERE id=?').get(passId);
    if (!pass || !pass.active) {
      const e = new Error('Pass unavailable');
      e.code = 'NOT_FOUND';
      throw e;
    }
    const game = db.prepare('SELECT * FROM games WHERE id=?').get(pass.game_id);
    if (!game || game.state === 'SUSPENDED' || game.state === 'REMOVED') {
      const e = new Error('Game unavailable');
      e.code = 'GAME';
      throw e;
    }
    if (pass.creator_id === userId) {
      const e = new Error('Cannot buy your own game pass');
      e.code = 'SELF';
      throw e;
    }
    const buyer = db.prepare('SELECT status FROM users WHERE id=?').get(userId);
    if (!buyer || buyer.status !== 'active') {
      const e = new Error('Account restricted');
      e.code = 'RESTRICTED';
      throw e;
    }

    const price = pass.price_kavx;
    const { creatorShare, platformShare } = splitRevenue(price);

    const bal = db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(userId);
    if (!bal || bal.balance < price) {
      const e = new Error('Insufficient Kavx');
      e.code = 'FUNDS';
      throw e;
    }

    // Debit buyer
    db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id=?').run(price, userId);
    db.prepare(
      `INSERT INTO currency_transactions (transaction_id, user_id, type, amount, currency, purchase_id, status, note, created_at)
       VALUES (?,?,?,?,?,NULL,'completed',?,?)`
    ).run(uuid(), userId, 'game_pass_purchase', -price, 'KAVX', 'pass:' + passId, new Date().toISOString());

    // Credit creator 60%
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id=?').run(creatorShare, pass.creator_id);
    db.prepare(
      `INSERT INTO currency_transactions (transaction_id, user_id, type, amount, currency, purchase_id, status, note, created_at)
       VALUES (?,?,?,?,?,NULL,'completed',?,?)`
    ).run(uuid(), pass.creator_id, 'game_pass_sale', creatorShare, 'KAVX', 'pass:' + passId, new Date().toISOString());

    // Platform 40% — ledger + optional platform user wallet
    const platId = uuid();
    db.prepare('INSERT INTO platform_ledger (id, amount, type, ref, created_at) VALUES (?,?,?,?,?)')
      .run(platId, platformShare, 'game_pass_fee', passId, new Date().toISOString());
    if (PLATFORM_USER) {
      try {
        db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id=?').run(platformShare, PLATFORM_USER);
        db.prepare(
          `INSERT INTO currency_transactions (transaction_id, user_id, type, amount, currency, purchase_id, status, note, created_at)
           VALUES (?,?,?,?,?,NULL,'completed',?,?)`
        ).run(uuid(), PLATFORM_USER, 'platform_fee', platformShare, 'KAVX', 'pass:' + passId, new Date().toISOString());
      } catch (_) {}
    }

    const purchaseId = uuid();
    db.prepare(
      `INSERT INTO game_pass_purchases (id,pass_id,game_id,buyer_id,creator_id,price_kavx,creator_share,platform_share,idempotency_key,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(purchaseId, passId, pass.game_id, userId, pass.creator_id, price, creatorShare, platformShare, key, new Date().toISOString());

    const newBal = db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(userId).balance;
    result = {
      duplicate: false,
      purchaseId,
      priceKavx: price,
      creatorShare,
      platformShare,
      balance: newBal
    };
  });
  run();
  return result;
}

function creatorPassStats(userId) {
  const sales = db.prepare(
    `SELECT COALESCE(SUM(price_kavx),0) as gross, COALESCE(SUM(creator_share),0) as creator, COALESCE(SUM(platform_share),0) as platform, COUNT(*) as sales
     FROM game_pass_purchases WHERE creator_id=?`
  ).get(userId);
  const passes = db.prepare('SELECT COUNT(*) as c FROM game_passes WHERE creator_id=?').get(userId).c;
  return {
    passCount: passes,
    sales: sales.sales,
    grossSales: sales.gross,
    creatorEarnings: sales.creator,
    platformShare: sales.platform,
    split: { creatorPercent: 60, platformPercent: 40 }
  };
}

function ownsPass(userId, passId) {
  return !!db.prepare('SELECT 1 FROM game_pass_purchases WHERE pass_id=? AND buyer_id=?').get(passId, userId);
}

module.exports = {
  createPass,
  getPass,
  listPasses,
  setPassActive,
  purchasePass,
  creatorPassStats,
  ownsPass,
  splitRevenue,
  ensureTables,
  CREATOR_SHARE_BPS,
  PLATFORM_SHARE_BPS
};
