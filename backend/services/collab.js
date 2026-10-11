/**
 * Team Studio — project membership, invites, revision lock foundation.
 * All permission checks are server-side. Roles: owner | editor | viewer
 */
const db = require('../database/db');
const { uuid } = require('./crypto');

const ROLES = new Set(['owner', 'editor', 'viewer']);
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

function logActivity(gameId, userId, action, detail) {
  try {
    db.prepare(
      `INSERT INTO project_activity (id, game_id, user_id, action, detail, created_at) VALUES (?,?,?,?,?,?)`
    ).run(uuid(), gameId, userId || null, action, detail ? String(detail).slice(0, 500) : null, new Date().toISOString());
  } catch (_) {}
}

function ensureOwnerRow(gameId, ownerId) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO project_members (game_id, user_id, role, created_at, updated_at) VALUES (?,?, 'owner', ?,?)`
  ).run(gameId, ownerId, now, now);
  db.prepare(
    `INSERT OR IGNORE INTO project_revisions (game_id, revision, updated_at) VALUES (?,1,?)`
  ).run(gameId, now);
}

function getGame(gameId) {
  return db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
}

/** Effective role for user on project */
function getRole(gameId, userId) {
  if (!userId) return null;
  const g = getGame(gameId);
  if (!g) return null;
  if (g.creator_id === userId) return 'owner';
  const m = db.prepare('SELECT role FROM project_members WHERE game_id=? AND user_id=?').get(gameId, userId);
  return m ? m.role : null;
}

function canView(gameId, userId) {
  const r = getRole(gameId, userId);
  return !!r;
}

function canEdit(gameId, userId) {
  const r = getRole(gameId, userId);
  return r === 'owner' || r === 'editor';
}

function canPublish(gameId, userId) {
  return getRole(gameId, userId) === 'owner';
}

function canManageMembers(gameId, userId) {
  return getRole(gameId, userId) === 'owner';
}

function listMembers(gameId) {
  const g = getGame(gameId);
  if (!g) return [];
  ensureOwnerRow(gameId, g.creator_id);
  const rows = db.prepare(
    `SELECT pm.user_id, pm.role, pm.updated_at, u.username, u.display_name
     FROM project_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.game_id=?`
  ).all(gameId);
  // Ensure owner present
  if (!rows.some((r) => r.user_id === g.creator_id)) {
    const o = db.prepare('SELECT username, display_name FROM users WHERE id=?').get(g.creator_id);
    rows.unshift({
      user_id: g.creator_id,
      role: 'owner',
      username: o?.username,
      display_name: o?.display_name,
      updated_at: g.updated_at
    });
  }
  return rows.map((r) => ({
    userId: r.user_id,
    role: r.role,
    username: r.username,
    displayName: r.display_name,
    updatedAt: r.updated_at
  }));
}

function invite({ gameId, inviterId, inviteeUsername, role }) {
  if (!canManageMembers(gameId, inviterId)) {
    const e = new Error('Only the owner can invite collaborators');
    e.code = 'FORBIDDEN';
    throw e;
  }
  const g = getGame(gameId);
  if (!g) {
    const e = new Error('Project not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const r = role === 'viewer' ? 'viewer' : 'editor';
  if (r === 'owner') {
    const e = new Error('Cannot invite as owner');
    e.code = 'BAD_ROLE';
    throw e;
  }
  const invitee = db.prepare('SELECT id, username FROM users WHERE username=? COLLATE NOCASE AND status=\'active\'').get(String(inviteeUsername || '').trim());
  if (!invitee) {
    const e = new Error('User not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (invitee.id === inviterId || invitee.id === g.creator_id) {
    const e = new Error('User already has access');
    e.code = 'EXISTS';
    throw e;
  }
  const existing = db.prepare('SELECT role FROM project_members WHERE game_id=? AND user_id=?').get(gameId, invitee.id);
  if (existing) {
    const e = new Error('Already a collaborator');
    e.code = 'EXISTS';
    throw e;
  }
  const pending = db.prepare(
    `SELECT id FROM project_invites WHERE game_id=? AND invitee_id=? AND status='pending'`
  ).get(gameId, invitee.id);
  if (pending) {
    const e = new Error('Invite already pending');
    e.code = 'PENDING';
    throw e;
  }
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO project_invites (id, game_id, inviter_id, invitee_id, role, status, created_at) VALUES (?,?,?,?,?,'pending',?)`
  ).run(id, gameId, inviterId, invitee.id, r, now);
  logActivity(gameId, inviterId, 'invite_sent', `@${invitee.username} as ${r}`);
  // Notification if table exists
  try {
    db.prepare(
      `INSERT INTO notifications (id, user_id, type, title, body, data_json, created_at, read) VALUES (?,?,?,?,?,?,?,0)`
    ).run(
      uuid(),
      invitee.id,
      'collab_invite',
      'Project invite',
      `You were invited to collaborate on ${g.name}`,
      JSON.stringify({ inviteId: id, gameId, role: r }),
      now
    );
  } catch (_) {}
  return { inviteId: id, invitee: invitee.username, role: r, status: 'pending' };
}

function listIncomingInvites(userId) {
  return db
    .prepare(
      `SELECT i.*, g.name as game_name, u.username as inviter_username
       FROM project_invites i
       JOIN games g ON g.id = i.game_id
       JOIN users u ON u.id = i.inviter_id
       WHERE i.invitee_id=? AND i.status='pending'
       ORDER BY i.created_at DESC`
    )
    .all(userId)
    .map((i) => ({
      id: i.id,
      gameId: i.game_id,
      gameName: i.game_name,
      role: i.role,
      inviter: i.inviter_username,
      createdAt: i.created_at
    }));
}

function respondInvite({ inviteId, userId, accept }) {
  const inv = db.prepare('SELECT * FROM project_invites WHERE id=?').get(inviteId);
  if (!inv || inv.invitee_id !== userId) {
    const e = new Error('Invite not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (inv.status !== 'pending') {
    const e = new Error('Invite already handled');
    e.code = 'HANDLED';
    throw e;
  }
  const now = new Date().toISOString();
  if (!accept) {
    db.prepare(`UPDATE project_invites SET status='declined', responded_at=? WHERE id=?`).run(now, inviteId);
    logActivity(inv.game_id, userId, 'invite_declined', inviteId);
    return { ok: true, status: 'declined' };
  }
  db.prepare(`UPDATE project_invites SET status='accepted', responded_at=? WHERE id=?`).run(now, inviteId);
  db.prepare(
    `INSERT OR REPLACE INTO project_members (game_id, user_id, role, created_at, updated_at) VALUES (?,?,?,?,?)`
  ).run(inv.game_id, userId, inv.role, now, now);
  logActivity(inv.game_id, userId, 'invite_accepted', inv.role);
  return { ok: true, status: 'accepted', gameId: inv.game_id, role: inv.role };
}

function cancelInvite({ inviteId, userId }) {
  const inv = db.prepare('SELECT * FROM project_invites WHERE id=?').get(inviteId);
  if (!inv) {
    const e = new Error('Not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (inv.inviter_id !== userId && !canManageMembers(inv.game_id, userId)) {
    const e = new Error('Forbidden');
    e.code = 'FORBIDDEN';
    throw e;
  }
  db.prepare(`UPDATE project_invites SET status='cancelled', responded_at=? WHERE id=?`).run(new Date().toISOString(), inviteId);
  return { ok: true };
}

function setRole({ gameId, ownerId, targetUserId, role }) {
  if (!canManageMembers(gameId, ownerId)) {
    const e = new Error('Forbidden');
    e.code = 'FORBIDDEN';
    throw e;
  }
  const g = getGame(gameId);
  if (targetUserId === g.creator_id) {
    const e = new Error('Cannot change owner role here');
    e.code = 'BAD';
    throw e;
  }
  if (!ROLES.has(role) || role === 'owner') {
    const e = new Error('Invalid role');
    e.code = 'BAD_ROLE';
    throw e;
  }
  const m = db.prepare('SELECT 1 FROM project_members WHERE game_id=? AND user_id=?').get(gameId, targetUserId);
  if (!m) {
    const e = new Error('Not a member');
    e.code = 'NOT_FOUND';
    throw e;
  }
  db.prepare(`UPDATE project_members SET role=?, updated_at=? WHERE game_id=? AND user_id=?`).run(
    role,
    new Date().toISOString(),
    gameId,
    targetUserId
  );
  logActivity(gameId, ownerId, 'role_change', `${targetUserId}:${role}`);
  return { ok: true, role };
}

function removeMember({ gameId, actorId, targetUserId }) {
  if (!canManageMembers(gameId, actorId) && actorId !== targetUserId) {
    const e = new Error('Forbidden');
    e.code = 'FORBIDDEN';
    throw e;
  }
  const g = getGame(gameId);
  if (targetUserId === g.creator_id) {
    const e = new Error('Cannot remove owner');
    e.code = 'BAD';
    throw e;
  }
  db.prepare('DELETE FROM project_members WHERE game_id=? AND user_id=?').run(gameId, targetUserId);
  logActivity(gameId, actorId, 'member_removed', targetUserId);
  return { ok: true };
}

function getRevision(gameId) {
  const g = getGame(gameId);
  if (!g) return null;
  ensureOwnerRow(gameId, g.creator_id);
  let row = db.prepare('SELECT revision, updated_at FROM project_revisions WHERE game_id=?').get(gameId);
  if (!row) {
    db.prepare(`INSERT INTO project_revisions (game_id, revision, updated_at) VALUES (?,1,?)`).run(
      gameId,
      new Date().toISOString()
    );
    row = { revision: 1, updated_at: new Date().toISOString() };
  }
  return row;
}

/**
 * Apply serialized edit: client must send baseRevision; server increments on success.
 * Rejects stale baseRevision (conflict).
 */
function bumpRevision(gameId, userId, baseRevision) {
  if (!canEdit(gameId, userId)) {
    const e = new Error('Forbidden');
    e.code = 'FORBIDDEN';
    throw e;
  }
  const cur = getRevision(gameId);
  if (baseRevision != null && Number(baseRevision) !== Number(cur.revision)) {
    const e = new Error('Revision conflict — reload project');
    e.code = 'CONFLICT';
    e.currentRevision = cur.revision;
    throw e;
  }
  const next = Number(cur.revision) + 1;
  const now = new Date().toISOString();
  db.prepare(`UPDATE project_revisions SET revision=?, updated_at=? WHERE game_id=?`).run(next, now, gameId);
  logActivity(gameId, userId, 'edit', `rev ${next}`);
  return { revision: next, updatedAt: now };
}

function activity(gameId, limit = 40) {
  return db
    .prepare(
      `SELECT a.*, u.username FROM project_activity a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.game_id=? ORDER BY a.created_at DESC LIMIT ?`
    )
    .all(gameId, Math.min(100, limit))
    .map((a) => ({
      action: a.action,
      detail: a.detail,
      username: a.username,
      createdAt: a.created_at
    }));
}

function projectsForUser(userId) {
  const owned = db.prepare('SELECT id, name, state, updated_at FROM games WHERE creator_id=?').all(userId);
  const collab = db
    .prepare(
      `SELECT g.id, g.name, g.state, g.updated_at, pm.role
       FROM project_members pm JOIN games g ON g.id = pm.game_id
       WHERE pm.user_id=? AND g.creator_id != ?`
    )
    .all(userId, userId);
  return { owned, collab };
}

module.exports = {
  ensureOwnerRow,
  getRole,
  canView,
  canEdit,
  canPublish,
  canManageMembers,
  listMembers,
  invite,
  listIncomingInvites,
  respondInvite,
  cancelInvite,
  setRole,
  removeMember,
  getRevision,
  bumpRevision,
  activity,
  projectsForUser,
  logActivity
};
