/**
 * Platform extensions: marketplace, assets, cloud saves, private servers, follows, groups, avatar.
 * Server-authoritative; no client-trusted balances.
 */
const db = require('../database/db');
const { uuid } = require('./crypto');
const { getBalance, credit, debit } = require('./wallet');

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price_kavx INTEGER NOT NULL DEFAULT 0,
      data_json TEXT NOT NULL DEFAULT '{}',
      thumbnail TEXT DEFAULT '',
      moderation TEXT NOT NULL DEFAULT 'pending',
      version INTEGER NOT NULL DEFAULT 1,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner_id);
    CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type, moderation);

    CREATE TABLE IF NOT EXISTS asset_purchases (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      price_kavx INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(asset_id, buyer_id)
    );

    CREATE TABLE IF NOT EXISTS cloud_saves (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      slot INTEGER NOT NULL DEFAULT 0,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, game_id, slot)
    );

    CREATE TABLE IF NOT EXISTS private_servers (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      max_players INTEGER NOT NULL DEFAULT 8,
      access_code TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS private_server_members (
      server_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (server_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (follower_id, following_id)
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      owner_id TEXT NOT NULL,
      icon TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      reward_kavx INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scheduled',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_sessions_stats (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
}
ensureTables();

function listMarketplace({ type, q, limit = 40 }) {
  let sql = `SELECT a.id, a.type, a.name, a.description, a.price_kavx, a.thumbnail, a.version, a.usage_count, a.created_at,
    u.username as creator FROM assets a JOIN users u ON u.id=a.owner_id WHERE a.moderation='approved'`;
  const params = [];
  if (type) { sql += ' AND a.type=?'; params.push(type); }
  if (q) { sql += ' AND (a.name LIKE ? OR a.description LIKE ?)'; params.push('%'+q+'%','%'+q+'%'); }
  sql += ' ORDER BY a.usage_count DESC, a.created_at DESC LIMIT ?';
  params.push(Math.min(100, Number(limit) || 40));
  return db.prepare(sql).all(...params);
}

function publishAsset({ userId, type, name, description, priceKavx, dataJson, thumbnail }) {
  const allowed = new Set(['model','map','prop','npc','weapon','item','ui','sound','animation','material','effect','template']);
  if (!allowed.has(type)) throw Object.assign(new Error('Invalid asset type'), { code: 'BAD_TYPE' });
  if (!name || name.length < 2) throw Object.assign(new Error('Name required'), { code: 'BAD' });
  const price = Math.max(0, Math.min(100000, Math.floor(Number(priceKavx) || 0)));
  const id = uuid();
  const now = new Date().toISOString();
  // Free assets auto-approved for MVP; paid pending moderation
  const mod = price === 0 ? 'approved' : 'pending';
  db.prepare(
    `INSERT INTO assets (id,owner_id,type,name,description,price_kavx,data_json,thumbnail,moderation,version,usage_count,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,0,?,?)`
  ).run(id, userId, type, String(name).slice(0,80), String(description||'').slice(0,500), price, JSON.stringify(dataJson||{}), String(thumbnail||'').slice(0,200), mod, now, now);
  return db.prepare('SELECT id,type,name,price_kavx,moderation,created_at FROM assets WHERE id=?').get(id);
}

function buyAsset({ userId, assetId, idempotencyKey }) {
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
  if (!asset || asset.moderation !== 'approved') throw Object.assign(new Error('Asset unavailable'), { code: 'NOT_FOUND' });
  if (asset.owner_id === userId) throw Object.assign(new Error('Already own'), { code: 'OWN' });

  const buyer = db.prepare('SELECT status FROM users WHERE id=?').get(userId);
  const seller = db.prepare('SELECT status FROM users WHERE id=?').get(asset.owner_id);
  if (!buyer || buyer.status !== 'active') throw Object.assign(new Error('Buyer unavailable'), { code: 'RESTRICTED' });
  if (!seller || seller.status !== 'active') throw Object.assign(new Error('Seller unavailable'), { code: 'RESTRICTED' });

  const key = String(idempotencyKey || ('asset_' + assetId + '_' + userId)).slice(0, 120);

  // Idempotency table
  db.exec(`CREATE TABLE IF NOT EXISTS economy_idempotency (
    key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  const prior = db.prepare('SELECT result_json FROM economy_idempotency WHERE key=?').get(key);
  if (prior) {
    try {
      const prev = JSON.parse(prior.result_json);
      return { ...prev, duplicate: true, kavxGranted: 0 };
    } catch (_) {}
  }

  const owned = db.prepare('SELECT 1 FROM asset_purchases WHERE asset_id=? AND buyer_id=?').get(assetId, userId);
  if (owned || asset.price_kavx === 0) {
    const result = { ok: true, owned: true, price: 0, duplicate: !!owned };
    if (!owned && asset.price_kavx === 0) {
      const run = db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO asset_purchases (id,asset_id,buyer_id,price_kavx,created_at) VALUES (?,?,?,?,?)')
          .run(uuid(), assetId, userId, 0, new Date().toISOString());
        db.prepare('UPDATE assets SET usage_count=usage_count+1 WHERE id=?').run(assetId);
        db.prepare('INSERT OR IGNORE INTO economy_idempotency (key,user_id,result_json,created_at) VALUES (?,?,?,?)')
          .run(key, userId, JSON.stringify(result), new Date().toISOString());
      });
      run();
    }
    return result;
  }

  const price = asset.price_kavx;
  if (!Number.isInteger(price) || price <= 0) throw Object.assign(new Error('Invalid price'), { code: 'BAD' });
  const creatorShare = Math.floor(price * 0.7);
  const platformShare = price - creatorShare;

  let result;
  try {
    const run = db.transaction(() => {
      // Re-check ownership inside transaction
      if (db.prepare('SELECT 1 FROM asset_purchases WHERE asset_id=? AND buyer_id=?').get(assetId, userId)) {
        result = { ok: true, owned: true, price: 0, duplicate: true };
        return;
      }
      const row = db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(userId);
      if (!row || row.balance < price) {
        const err = new Error('Insufficient Kavx');
        err.code = 'FUNDS';
        throw err;
      }
      db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id=?').run(price, userId);
      db.prepare(
        `INSERT INTO currency_transactions (transaction_id, user_id, type, amount, currency, purchase_id, status, note, created_at)
         VALUES (?,?,?,?,?,NULL,'completed',?,?)`
      ).run(uuid(), userId, 'asset_purchase', -price, 'KAVX', 'asset:' + assetId, new Date().toISOString());
      if (creatorShare > 0) {
        db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id=?').run(creatorShare, asset.owner_id);
        db.prepare(
          `INSERT INTO currency_transactions (transaction_id, user_id, type, amount, currency, purchase_id, status, note, created_at)
           VALUES (?,?,?,?,?,NULL,'completed',?,?)`
        ).run(uuid(), asset.owner_id, 'asset_sale', creatorShare, 'KAVX', 'asset:' + assetId, new Date().toISOString());
      }
      db.prepare('INSERT INTO asset_purchases (id,asset_id,buyer_id,price_kavx,created_at) VALUES (?,?,?,?,?)')
        .run(uuid(), assetId, userId, price, new Date().toISOString());
      db.prepare('UPDATE assets SET usage_count=usage_count+1 WHERE id=?').run(assetId);
      const bal = db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(userId).balance;
      result = { ok: true, owned: true, price, balance: bal, creatorShare, platformShare };
      db.prepare('INSERT OR IGNORE INTO economy_idempotency (key,user_id,result_json,created_at) VALUES (?,?,?,?)')
        .run(key, userId, JSON.stringify(result), new Date().toISOString());
    });
    run();
  } catch (e) {
    if (e.code === 'FUNDS') throw Object.assign(new Error('Insufficient Kavx'), { code: 'FUNDS' });
    throw e;
  }
  return result;
}

function myAssets(userId) {
  return db.prepare('SELECT id,type,name,price_kavx,moderation,usage_count,created_at FROM assets WHERE owner_id=? ORDER BY created_at DESC').all(userId);
}

function ownedAssets(userId) {
  return db.prepare(
    `SELECT a.id,a.type,a.name,a.price_kavx FROM asset_purchases p JOIN assets a ON a.id=p.asset_id WHERE p.buyer_id=?`
  ).all(userId);
}

function cloudSave({ userId, gameId, slot, data }) {
  const g = db.prepare('SELECT id,state FROM games WHERE id=?').get(gameId);
  if (!g || g.state !== 'PUBLISHED') throw Object.assign(new Error('Game unavailable'), { code: 'GAME' });
  const s = Math.max(0, Math.min(3, Math.floor(Number(slot) || 0)));
  // Size limit ~64KB
  const json = JSON.stringify(data || {});
  if (json.length > 65536) throw Object.assign(new Error('Save too large'), { code: 'SIZE' });
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM cloud_saves WHERE user_id=? AND game_id=? AND slot=?').get(userId, gameId, s);
  if (existing) {
    db.prepare('UPDATE cloud_saves SET data_json=?, updated_at=? WHERE id=?').run(json, now, existing.id);
    return { id: existing.id, slot: s, updatedAt: now };
  }
  const id = uuid();
  db.prepare('INSERT INTO cloud_saves (id,user_id,game_id,slot,data_json,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, gameId, s, json, now);
  return { id, slot: s, updatedAt: now };
}

function cloudLoad({ userId, gameId, slot }) {
  const s = Math.max(0, Math.min(3, Math.floor(Number(slot) || 0)));
  const row = db.prepare('SELECT data_json, updated_at FROM cloud_saves WHERE user_id=? AND game_id=? AND slot=?').get(userId, gameId, s);
  if (!row) return { data: null };
  return { data: JSON.parse(row.data_json), updatedAt: row.updated_at };
}

function createPrivateServer({ userId, gameId, name, maxPlayers, accessCode }) {
  const g = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!g || g.state !== 'PUBLISHED') throw Object.assign(new Error('Game unavailable'), { code: 'GAME' });
  if (['SUSPENDED','REMOVED','BANNED'].includes(g.state)) throw Object.assign(new Error('Game unavailable'), { code: 'GAME' });
  const id = uuid();
  const now = new Date().toISOString();
  const max = Math.min(32, Math.max(2, Number(maxPlayers)||8));
  const code = accessCode ? String(accessCode).slice(0, 32) : null;
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO private_servers (id,game_id,owner_id,name,max_players,access_code,status,created_at) VALUES (?,?,?,?,?,?, 'open',?)`
    ).run(id, gameId, userId, String(name||'Private').slice(0,40), max, code, now);
    db.prepare('INSERT INTO private_server_members (server_id,user_id,role) VALUES (?,?,?)').run(id, userId, 'owner');
    // Link to multiplayer: private server ID is also a game_servers row (is_test=0, private)
    try {
      const cols = db.prepare('PRAGMA table_info(game_servers)').all().map(c => c.name);
      if (!cols.includes('is_private')) db.exec('ALTER TABLE game_servers ADD COLUMN is_private INTEGER DEFAULT 0');
    } catch (_) {}
    db.prepare(
      `INSERT INTO game_servers (id, game_id, name, region, max_players, is_test, status, created_at) VALUES (?,?,?,'private',?,0,'online',?)`
    ).run(id, gameId, String(name||'Private').slice(0,40), max, now);
    try {
      db.prepare('UPDATE game_servers SET is_private=1 WHERE id=?').run(id);
    } catch (_) {}
  });
  run();
  return { id, name: String(name||'Private').slice(0,40), maxPlayers: max, accessCodeRequired: !!code };
}

function assertPrivateServerAccess(userId, serverId, accessCode) {
  const s = db.prepare('SELECT * FROM private_servers WHERE id=?').get(serverId);
  if (!s) throw Object.assign(new Error('Private server not found'), { code: 'NOT_FOUND' });
  if (s.status !== 'open') throw Object.assign(new Error('Server closed'), { code: 'CLOSED' });
  const g = db.prepare('SELECT state FROM games WHERE id=?').get(s.game_id);
  if (!g || g.state !== 'PUBLISHED') throw Object.assign(new Error('Game unavailable'), { code: 'GAME' });
  const member = db.prepare('SELECT role FROM private_server_members WHERE server_id=? AND user_id=?').get(serverId, userId);
  if (member) return { server: s, role: member.role };
  if (s.access_code) {
    if (!accessCode || accessCode !== s.access_code) {
      throw Object.assign(new Error('Not authorized for private server'), { code: 'FORBIDDEN' });
    }
    let role = 'member';
    const run = db.transaction(() => {
      const existing = db.prepare('SELECT role FROM private_server_members WHERE server_id=? AND user_id=?').get(serverId, userId);
      if (existing) { role = existing.role; return; }
      const members = db.prepare('SELECT COUNT(*) as c FROM private_server_members WHERE server_id=?').get(serverId).c;
      if (members >= s.max_players) {
        const e = new Error('Private server is full');
        e.code = 'FULL';
        throw e;
      }
      db.prepare('INSERT OR IGNORE INTO private_server_members (server_id,user_id,role) VALUES (?,?,?)').run(serverId, userId, 'member');
    });
    run();
    return { server: s, role };
  }
  throw Object.assign(new Error('Not authorized for private server'), { code: 'FORBIDDEN' });
}

function closePrivateServer({ userId, serverId }) {
  const s = db.prepare('SELECT * FROM private_servers WHERE id=?').get(serverId);
  if (!s) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
  if (s.owner_id !== userId) throw Object.assign(new Error('Owner only'), { code: 'FORBIDDEN' });
  db.prepare(`UPDATE private_servers SET status='closed' WHERE id=?`).run(serverId);
  try { db.prepare(`UPDATE game_servers SET status='offline' WHERE id=?`).run(serverId); } catch (_) {}
  return { ok: true };
}

function kickPrivateMember({ ownerId, serverId, userId }) {
  const s = db.prepare('SELECT * FROM private_servers WHERE id=?').get(serverId);
  if (!s || s.owner_id !== ownerId) throw Object.assign(new Error('Owner only'), { code: 'FORBIDDEN' });
  if (userId === ownerId) throw Object.assign(new Error('Cannot kick owner'), { code: 'BAD' });
  db.prepare('DELETE FROM private_server_members WHERE server_id=? AND user_id=?').run(serverId, userId);
  return { ok: true };
}


function joinPrivateServer({ userId, serverId, accessCode }) {
  const { server: s } = assertPrivateServerAccess(userId, serverId, accessCode);
  // assertPrivateServerAccess already enforces capacity on new memberships
  const members = db.prepare('SELECT COUNT(*) as c FROM private_server_members WHERE server_id=?').get(serverId).c;
  if (members > s.max_players) {
    // Defensive: should not happen if assert is correct
    throw Object.assign(new Error('Full'), { code: 'FULL' });
  }
  return { ok: true, gameId: s.game_id, serverId: s.id, private: true };
}

function follow({ followerId, followingUsername }) {
  const t = db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(followingUsername);
  if (!t) throw Object.assign(new Error('User not found'), { code: 'NOT_FOUND' });
  if (t.id === followerId) throw Object.assign(new Error('Cannot follow self'), { code: 'SELF' });
  db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?,?,?)')
    .run(followerId, t.id, new Date().toISOString());
  return { ok: true };
}

function unfollow({ followerId, followingId }) {
  db.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').run(followerId, followingId);
  return { ok: true };
}

function updateAvatar({ userId, body, head, hair, face, outfit, accessory, colors }) {
  const fields = { body, head, hair, face, outfit, accessory };
  const cur = db.prepare('SELECT * FROM profiles WHERE user_id=?').get(userId);
  if (!cur) db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(userId);
  const next = {
    body: String(body || cur?.body || 'core').slice(0, 32),
    head: String(head || cur?.head || 'round').slice(0, 32),
    hair: String(hair || cur?.hair || 'short').slice(0, 32),
    face: String(face || cur?.face || 'calm').slice(0, 32),
    outfit: String(outfit || cur?.outfit || 'trailcoat').slice(0, 32),
    accessory: String(accessory || cur?.accessory || 'none').slice(0, 32)
  };
  db.prepare(`UPDATE profiles SET body=?, head=?, hair=?, face=?, outfit=?, accessory=? WHERE user_id=?`)
    .run(next.body, next.head, next.hair, next.face, next.outfit, next.accessory, userId);
  if (colors && typeof colors === 'object') {
    try {
      db.prepare(`UPDATE profiles SET bio=COALESCE(bio,'') WHERE user_id=?`).run(userId);
      // store colors in a safe JSON column if exists - use accessory field expansion via separate table
      db.exec(`CREATE TABLE IF NOT EXISTS avatar_colors (user_id TEXT PRIMARY KEY, colors_json TEXT NOT NULL)`);
      db.prepare('INSERT OR REPLACE INTO avatar_colors (user_id, colors_json) VALUES (?,?)').run(userId, JSON.stringify(colors).slice(0, 500));
    } catch (_) {}
  }
  return getAvatar(userId);
}

function getAvatar(userId) {
  const p = db.prepare('SELECT * FROM profiles WHERE user_id=?').get(userId) || {};
  let colors = {};
  try {
    const c = db.prepare('SELECT colors_json FROM avatar_colors WHERE user_id=?').get(userId);
    if (c) colors = JSON.parse(c.colors_json);
  } catch (_) {}
  return {
    body: p.body || 'core',
    head: p.head || 'round',
    hair: p.hair || 'short',
    face: p.face || 'calm',
    outfit: p.outfit || 'trailcoat',
    accessory: p.accessory || 'none',
    colors
  };
}

function creatorAnalytics(userId) {
  const games = db.prepare('SELECT id, name, plays, likes, state FROM games WHERE creator_id=?').all(userId);
  const totalPlays = games.reduce((n, g) => n + (g.plays || 0), 0);
  const totalLikes = games.reduce((n, g) => n + (g.likes || 0), 0);
  const favs = db.prepare(
    `SELECT COUNT(*) as c FROM favorites f JOIN games g ON g.id=f.game_id WHERE g.creator_id=?`
  ).get(userId).c;
  let earned = 0;
  try {
    earned = db.prepare(
      `SELECT COALESCE(SUM(amount),0) as s FROM currency_transactions WHERE user_id=? AND amount>0 AND type IN ('creator_reward','asset_sale')`
    ).get(userId).s;
  } catch (_) {}
  return {
    games: games.length,
    totalPlays,
    totalLikes,
    favorites: favs,
    kavxEarned: earned,
    gamesDetail: games
  };
}

function createGroup({ userId, name, description }) {
  if (!name || name.length < 2) throw Object.assign(new Error('Name required'), { code: 'BAD' });
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO groups (id,name,description,owner_id,created_at) VALUES (?,?,?,?,?)')
    .run(id, String(name).slice(0,40), String(description||'').slice(0,300), userId, now);
  db.prepare('INSERT INTO group_members (group_id,user_id,role,joined_at) VALUES (?,?,?,?)').run(id, userId, 'owner', now);
  return { id, name: String(name).slice(0,40) };
}

function listGroups(userId) {
  return db.prepare(
    `SELECT g.id,g.name,g.description,g.owner_id,gm.role FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.user_id=?`
  ).all(userId);
}

/**
 * Session analytics — requires auth (caller), published/playable game,
 * reasonable duration, daily caps, optional session ticket binding.
 */
function recordSession({ userId, gameId, durationSec, sessionId, playTicketHash }) {
  ensureTables();
  const g = db.prepare('SELECT id, state, creator_id FROM games WHERE id=?').get(gameId);
  if (!g) {
    const e = new Error('Game not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (g.state === 'SUSPENDED' || g.state === 'REMOVED' || g.state === 'BANNED') {
    const e = new Error('Game unavailable');
    e.code = 'GAME';
    throw e;
  }
  // Prefer ticket-bound sessions when client provides playTicketHash
  if (playTicketHash) {
    try {
      const th = String(playTicketHash).slice(0, 128);
      const tick = db.prepare('SELECT user_id, game_id, expires_at FROM ws_tickets WHERE ticket_hash=?').get(th);
      if (!tick || tick.user_id !== userId || tick.game_id !== gameId) {
        const e = new Error('Invalid play session ticket');
        e.code = 'TICKET';
        throw e;
      }
    } catch (e) {
      if (e.code === 'TICKET') throw e;
    }
  }
  // Only published games or own drafts generate public analytics
  if (g.state !== 'PUBLISHED' && g.creator_id !== userId) {
    const e = new Error('Cannot record session for this game');
    e.code = 'FORBIDDEN';
    throw e;
  }
  let d = Math.floor(Number(durationSec));
  if (!Number.isFinite(d) || d < 5) {
    // ignore sub-5s noise
    return { ok: true, ignored: true, reason: 'too_short' };
  }
  if (d > 14400) d = 14400; // max 4 hours per report
  // Daily per-user-per-game cap: max 12 hours recorded
  const day = new Date().toISOString().slice(0, 10);
  db.exec(`CREATE TABLE IF NOT EXISTS session_stat_daily (
    user_id TEXT NOT NULL, game_id TEXT NOT NULL, day TEXT NOT NULL, total_sec INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, game_id, day)
  )`);
  const row = db.prepare('SELECT total_sec FROM session_stat_daily WHERE user_id=? AND game_id=? AND day=?').get(userId, gameId, day);
  const already = row ? row.total_sec : 0;
  if (already >= 43200) {
    return { ok: true, ignored: true, reason: 'daily_cap' };
  }
  const allowed = Math.min(d, 43200 - already);
  // Optional: if sessionId provided, reject duplicates
  if (sessionId) {
    const sid = String(sessionId).slice(0, 64);
    db.exec(`CREATE TABLE IF NOT EXISTS session_stat_ids (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`);
    const dup = db.prepare('SELECT 1 FROM session_stat_ids WHERE id=?').get(sid);
    if (dup) return { ok: true, duplicate: true };
    db.prepare('INSERT INTO session_stat_ids (id, created_at) VALUES (?,?)').run(sid, new Date().toISOString());
  }
  const run = db.transaction(() => {
    db.prepare('INSERT INTO game_sessions_stats (id,game_id,user_id,duration_sec,created_at) VALUES (?,?,?,?,?)')
      .run(uuid(), gameId, userId, allowed, new Date().toISOString());
    db.prepare(
      `INSERT INTO session_stat_daily (user_id, game_id, day, total_sec) VALUES (?,?,?,?)
       ON CONFLICT(user_id, game_id, day) DO UPDATE SET total_sec = total_sec + excluded.total_sec`
    ).run(userId, gameId, day, allowed);
  });
  run();
  return { ok: true, recordedSec: allowed };
}

module.exports = {
  ensureTables,
  listMarketplace,
  publishAsset,
  buyAsset,
  myAssets,
  ownedAssets,
  cloudSave,
  cloudLoad,
  createPrivateServer,
  assertPrivateServerAccess,
  closePrivateServer,
  kickPrivateMember,
  joinPrivateServer,
  follow,
  unfollow,
  updateAvatar,
  getAvatar,
  creatorAnalytics,
  createGroup,
  listGroups,
  recordSession
};
