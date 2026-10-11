/**
 * Game invitations — friends only. Server validates friendship, game, server, ticket.
 */
const db = require('../database/db');
const { uuid } = require('./crypto');
const presence = require('../multiplayer/presence');
const crypto = require('crypto');

function ensureTable() {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS game_invites (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      server_id TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_invites_receiver ON game_invites(receiver_id, status)');
  } catch (_) {}
}
ensureTable();

function areFriends(a, b) {
  const row = db.prepare(
    'SELECT 1 FROM friends WHERE user_id=? AND friend_id=?'
  ).get(a, b);
  return !!row;
}

function sendInvite({ senderId, receiverUsername, gameId, serverId }) {
  ensureTable();
  if (!receiverUsername) {
    const e = new Error('Recipient required'); e.code = 'BAD'; throw e;
  }
  const receiver = db.prepare('SELECT id, username, status FROM users WHERE username = ? COLLATE NOCASE').get(String(receiverUsername).trim());
  if (!receiver) { const e = new Error('User not found'); e.code = 'NOT_FOUND'; throw e; }
  if (receiver.id === senderId) { const e = new Error('Cannot invite yourself'); e.code = 'SELF'; throw e; }
  if (receiver.status !== 'active') { const e = new Error('User unavailable'); e.code = 'RESTRICTED'; throw e; }

  // REQUIRED: mutual friendship check (Invite Friends)
  if (!areFriends(senderId, receiver.id)) {
    const e = new Error('You can only invite friends'); e.code = 'NOT_FRIENDS'; throw e;
  }

  const game = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!game || game.state !== 'PUBLISHED') { const e = new Error('Game unavailable'); e.code = 'GAME'; throw e; }

  if (serverId) {
    const srv = db.prepare('SELECT * FROM game_servers WHERE id=? AND game_id=? AND is_test=0').get(serverId, gameId);
    if (!srv) { const e = new Error('Invalid server'); e.code = 'SERVER'; throw e; }
  }

  const now = new Date();
  const expires = new Date(now.getTime() + 15 * 60 * 1000);

  const existing = db.prepare(
    `SELECT id FROM game_invites WHERE sender_id=? AND receiver_id=? AND game_id=? AND status='PENDING' AND expires_at > ?`
  ).get(senderId, receiver.id, gameId, now.toISOString());
  if (existing) {
    return { id: existing.id, duplicate: true, receiver: receiver.username };
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO game_invites (id, sender_id, receiver_id, game_id, server_id, status, created_at, expires_at)
     VALUES (?,?,?,?,?,'PENDING',?,?)`
  ).run(id, senderId, receiver.id, gameId, serverId || null, now.toISOString(), expires.toISOString());

  const sender = db.prepare('SELECT username FROM users WHERE id=?').get(senderId);
  db.prepare(
    `INSERT INTO notifications (id, user_id, type, title, body, data_json, read, created_at)
     VALUES (?,?,?,?,?,?,0,?)`
  ).run(
    uuid(),
    receiver.id,
    'GAME_INVITE',
    'Game invite',
    `@${sender.username} invited you to join ${game.name}.`,
    JSON.stringify({ inviteId: id, gameId, serverId: serverId || null, gameName: game.name, from: sender.username }),
    now.toISOString()
  );

  return { id, receiver: receiver.username, expiresAt: expires.toISOString() };
}

/**
 * Accept/decline. On accept: validate capacity then mark ACCEPTED and return join info.
 * Ticket issuance is done by the API layer with shortTicket so secrets stay in server.js.
 */
function respondInvite({ userId, inviteId, action }) {
  ensureTable();
  const inv = db.prepare('SELECT * FROM game_invites WHERE id=?').get(inviteId);
  if (!inv) { const e = new Error('Invite not found'); e.code = 'NOT_FOUND'; throw e; }
  if (inv.receiver_id !== userId) { const e = new Error('Not your invite'); e.code = 'FORBIDDEN'; throw e; }
  if (inv.status !== 'PENDING') { const e = new Error('Invite already handled'); e.code = 'USED'; throw e; }
  if (new Date(inv.expires_at) < new Date()) {
    db.prepare(`UPDATE game_invites SET status='EXPIRED' WHERE id=?`).run(inv.id);
    const e = new Error('Invite expired'); e.code = 'EXPIRED'; throw e;
  }
  if (action === 'decline') {
    db.prepare(`UPDATE game_invites SET status='DECLINED' WHERE id=?`).run(inv.id);
    return { status: 'DECLINED' };
  }
  if (action !== 'accept') { const e = new Error('Invalid action'); e.code = 'BAD'; throw e; }

  const game = db.prepare('SELECT * FROM games WHERE id=?').get(inv.game_id);
  if (!game || game.state !== 'PUBLISHED') {
    db.prepare(`UPDATE game_invites SET status='CANCELLED' WHERE id=?`).run(inv.id);
    const e = new Error('Game no longer available'); e.code = 'GAME'; throw e;
  }

  const rooms = require('../multiplayer/rooms');
  const servers = db.prepare('SELECT * FROM game_servers WHERE game_id=? AND is_test=0 AND status!=\'offline\'').all(game.id);
  let serverId = inv.server_id;
  if (serverId) {
    const srv = servers.find((s) => s.id === serverId);
    if (!srv || rooms.count(serverId) >= srv.max_players) {
      serverId = null;
    }
  }
  if (!serverId) {
    const open = servers.find((s) => rooms.count(s.id) < s.max_players);
    if (!open) {
      // do NOT accept — leave PENDING so user can retry, or cancel
      const e = new Error('All servers full'); e.code = 'FULL'; throw e;
    }
    serverId = open.id;
  }

  // Mark accepted only after capacity check
  db.prepare(`UPDATE game_invites SET status='ACCEPTED', server_id=? WHERE id=? AND status='PENDING'`).run(serverId, inv.id);
  const updated = db.prepare('SELECT * FROM game_invites WHERE id=?').get(inv.id);
  if (!updated || updated.status !== 'ACCEPTED') {
    const e = new Error('Invite could not be accepted'); e.code = 'RACE'; throw e;
  }

  return { status: 'ACCEPTED', gameId: game.id, serverId, gameName: game.name };
}

function listFriendsForInvite(userId) {
  const friends = db.prepare(
    `SELECT users.id, users.username, users.display_name, users.avatar_id
     FROM friends JOIN users ON users.id=friends.friend_id WHERE friends.user_id=?`
  ).all(userId);
  return friends.map((f) => {
    const p = presence.get(f.id) || { status: 'offline' };
    return { ...f, presence: p };
  });
}

module.exports = { sendInvite, respondInvite, listFriendsForInvite, ensureTable, areFriends };
