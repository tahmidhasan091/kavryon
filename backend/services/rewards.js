const { uuid } = require('./crypto');
const db = require('../database/db');
const wallet = require('./wallet');
const economy = require('./economy');

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function creatorDayEarned(creatorId) {
  const day = dayKey();
  const row = db.prepare('SELECT creator_earned FROM economy_daily WHERE user_id = ? AND day = ?').get(creatorId, day);
  return row ? row.creator_earned : 0;
}

function gameDayEarned(creatorId, gameId) {
  const day = dayKey();
  const row = db
    .prepare('SELECT earned FROM creator_game_daily WHERE creator_id = ? AND game_id = ? AND day = ?')
    .get(creatorId, gameId, day);
  return row ? row.earned : 0;
}

function bumpDaily(creatorId, gameId, amount) {
  const day = dayKey();
  db.prepare(
    `INSERT INTO economy_daily (user_id, day, gift_sent_amount, gift_sent_count, creator_earned)
     VALUES (?, ?, 0, 0, ?)
     ON CONFLICT(user_id, day) DO UPDATE SET creator_earned = creator_earned + excluded.creator_earned`
  ).run(creatorId, day, amount);
  if (gameId) {
    db.prepare(
      `INSERT INTO creator_game_daily (creator_id, game_id, day, earned)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(creator_id, game_id, day) DO UPDATE SET earned = earned + excluded.earned`
    ).run(creatorId, gameId, day, amount);
  }
}

/**
 * Grant creator reward for a unique server-defined event.
 * Amount is calculated server-side only.
 */
function grantCreatorReward({ creatorId, gameId, eventType, uniqueEventId, amount }) {
  if (!creatorId || !eventType || !uniqueEventId) {
    const e = new Error('Invalid reward request');
    e.code = 'INVALID';
    throw e;
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    const e = new Error('Invalid reward amount');
    e.code = 'INVALID';
    throw e;
  }

  const existing = db.prepare('SELECT * FROM creator_rewards WHERE unique_event_id = ?').get(String(uniqueEventId));
  if (existing) {
    return { duplicate: true, reward: existing, balance: wallet.getBalance(creatorId) };
  }

  // Caps
  const dayTotal = creatorDayEarned(creatorId);
  if (dayTotal + amount > economy.CREATOR_DAILY_CAP) {
    const e = new Error('Creator daily earning cap reached');
    e.code = 'DAILY_CAP';
    throw e;
  }
  if (gameId) {
    const gTotal = gameDayEarned(creatorId, gameId);
    if (gTotal + amount > economy.CREATOR_PER_GAME_DAILY_CAP) {
      const e = new Error('Per-game daily earning cap reached');
      e.code = 'GAME_CAP';
      throw e;
    }
  }

  const creator = db.prepare('SELECT * FROM users WHERE id = ?').get(creatorId);
  if (!creator || !creator.developer_mode || creator.status !== 'active') {
    const e = new Error('Creator not eligible');
    e.code = 'NOT_ELIGIBLE';
    throw e;
  }

  return db.transaction(() => {
    const again = db.prepare('SELECT * FROM creator_rewards WHERE unique_event_id = ?').get(String(uniqueEventId));
    if (again) return { duplicate: true, reward: again, balance: wallet.getBalance(creatorId) };

    const id = uuid();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO creator_rewards (id, creator_id, game_id, event_type, amount, status, unique_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`
    ).run(id, creatorId, gameId || null, eventType, amount, String(uniqueEventId), now);

    wallet.credit(creatorId, amount, 'CREATOR_REWARD', null, `${eventType}:${uniqueEventId}`);
    bumpDaily(creatorId, gameId, amount);

    // Keep legacy creator_earnings row for dashboard
    try {
      db.prepare(
        `INSERT INTO creator_earnings (id, user_id, amount, source, status, created_at) VALUES (?, ?, ?, ?, 'paid', ?)`
      ).run(uuid(), creatorId, amount, eventType, now);
    } catch (_) {}

    return { duplicate: false, rewardId: id, amount, balance: wallet.getBalance(creatorId) };
  })();
}

/** Server-only: reward for publishing (called from publish endpoint). */
function onGamePublished(creatorId, gameId) {
  return grantCreatorReward({
    creatorId,
    gameId,
    eventType: 'publish',
    uniqueEventId: `publish:${gameId}`,
    amount: economy.REWARD_PUBLISH
  });
}

/** Server-only: engagement reward when a unique player plays (rate-limited by unique event id). */
function onUniquePlayEngagement(creatorId, gameId, playerId) {
  if (!creatorId || !gameId || !playerId) return { skipped: true };
  if (creatorId === playerId) return { skipped: true, reason: 'self' };
  const uniqueEventId = `play:${gameId}:${playerId}`;
  try {
    return grantCreatorReward({
      creatorId,
      gameId,
      eventType: 'play_engagement',
      uniqueEventId,
      amount: economy.REWARD_PLAY_MILESTONE
    });
  } catch (e) {
    if (e.code === 'DAILY_CAP' || e.code === 'GAME_CAP') return { capped: true };
    throw e;
  }
}

function listRewards(creatorId, limit = 50) {
  return db
    .prepare('SELECT * FROM creator_rewards WHERE creator_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(creatorId, Math.min(100, limit));
}

module.exports = { grantCreatorReward, onGamePublished, onUniquePlayEngagement, onLikeMilestone, listRewards };


/** Like milestones: 1, 10, 50, 100, 500 — each once per game (idempotent). */
function onLikeMilestone(creatorId, gameId, likerId) {
  if (!creatorId || !gameId || !likerId) return { skipped: true };
  if (creatorId === likerId) return { skipped: true, reason: 'self' };
  const likes = db.prepare('SELECT likes FROM games WHERE id = ?').get(gameId);
  const count = likes ? likes.likes : 0;
  const milestones = [
    { at: 1, key: 'like_1', amount: economy.REWARD_LIKE_MILESTONE },
    { at: 10, key: 'like_10', amount: economy.REWARD_LIKE_MILESTONE * 2 },
    { at: 50, key: 'like_50', amount: economy.REWARD_LIKE_MILESTONE * 4 },
    { at: 100, key: 'like_100', amount: economy.REWARD_LIKE_MILESTONE * 8 },
    { at: 500, key: 'like_500', amount: economy.REWARD_LIKE_MILESTONE * 16 }
  ];
  const hit = milestones.filter((m) => count >= m.at);
  let last = { skipped: true };
  for (const m of hit) {
    try {
      last = grantCreatorReward({
        creatorId,
        gameId,
        eventType: 'like_milestone',
        uniqueEventId: `${m.key}:${gameId}`,
        amount: m.amount
      });
    } catch (e) {
      if (e.code === 'DAILY_CAP' || e.code === 'GAME_CAP') return { capped: true };
      if (e.message && e.message.includes('UNIQUE')) continue;
      throw e;
    }
  }
  return last;
}

module.exports.onLikeMilestone = onLikeMilestone;
