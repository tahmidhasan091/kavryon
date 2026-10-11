/**
 * Atomic game publish with validation.
 * Ensures: definition + immutable version + PUBLISHED state or full rollback.
 */
const db = require('../database/db');
const { uuid } = require('./crypto');
const { sanitizeDefinition } = require('../engine/definition');
const { ACTION_TYPES } = require('../engine/definition');

function ensurePublishColumns() {
  try {
    const cols = db.prepare('PRAGMA table_info(games)').all().map((c) => c.name);
    if (!cols.includes('published_at')) db.exec("ALTER TABLE games ADD COLUMN published_at TEXT");
    if (!cols.includes('published_version')) db.exec('ALTER TABLE games ADD COLUMN published_version INTEGER DEFAULT 0');
  } catch (_) {}
  try {
    const vcols = db.prepare('PRAGMA table_info(game_versions)').all().map((c) => c.name);
    if (!vcols.includes('scripts_json')) db.exec("ALTER TABLE game_versions ADD COLUMN scripts_json TEXT DEFAULT '[]'");
    if (!vcols.includes('objects_json')) db.exec("ALTER TABLE game_versions ADD COLUMN objects_json TEXT DEFAULT '[]'");
    if (!vcols.includes('publisher_id')) db.exec('ALTER TABLE game_versions ADD COLUMN publisher_id TEXT');
  } catch (_) {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_games_state_pub ON games(state, published_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_games_plays ON games(state, plays)');
  } catch (_) {}
}

function validateForPublish(gameId) {
  const errors = [];
  const warnings = [];
  const g = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!g) return { ok: false, errors: ['Game not found'], warnings: [] };
  if (!g.name || String(g.name).trim().length < 2) errors.push('Name must be at least 2 characters');
  if (!g.description || String(g.description).trim().length < 3) errors.push('Description required');
  if (!g.max_players || g.max_players < 2) errors.push('max_players must be >= 2');
  if (g.max_players > 32) warnings.push('High player limit may strain mobile devices');

  let def = null;
  const defRow = db.prepare('SELECT definition_json FROM game_definitions WHERE game_id=?').get(gameId);
  try {
    if (defRow) def = sanitizeDefinition(JSON.parse(defRow.definition_json));
  } catch {
    errors.push('Invalid game definition JSON');
  }
  const objects = db.prepare('SELECT * FROM game_objects WHERE game_id=?').all(gameId);
  if (!objects.length && !(def && def.objects && def.objects.length)) {
    errors.push('Add at least one object (spawn recommended)');
  }
  const objs = def?.objects?.length ? def.objects : objects.map((o) => ({ type: o.type, name: o.name }));
  if (!objs.some((o) => o.type === 'spawn')) errors.push('Missing spawn point');
  if (objs.length > 200) errors.push('Too many objects (max 200)');
  if (objs.length > 120) warnings.push('High object count may hurt mobile performance');

  if (def) {
    if ((def.scripts || []).length > 60) errors.push('Too many scripts');
    for (const sc of def.scripts || []) {
      for (const a of sc.actions || []) {
        if (!ACTION_TYPES.has(a.type)) errors.push(`Unsafe or unknown script action: ${a.type}`);
      }
    }
    if (def.teams && def.teams.length > 8) errors.push('Too many teams');
    if (def.dimension === '3d' && objs.length > 100) warnings.push('3D mode with many objects is heavy on low-end devices');
  }

  const servers = db.prepare('SELECT COUNT(*) as c FROM game_servers WHERE game_id=? AND is_test=0').get(gameId);
  if (!servers || servers.c < 1) warnings.push('No live servers — will create one on publish');

  return { ok: errors.length === 0, errors, warnings, game: g, def, objects };
}

function publishGame(userId, gameId, opts = {}) {
  const collab = require('./collab');

  ensurePublishColumns();
  const v = validateForPublish(gameId);
  if (!v.ok) {
    const e = new Error(v.errors.join('; '));
    e.code = 'VALIDATION';
    e.errors = v.errors;
    e.warnings = v.warnings;
    throw e;
  }
  if (v.warnings.length && !opts.confirmWarnings) {
    const e = new Error('Warnings require confirmation');
    e.code = 'WARNINGS';
    e.errors = [];
    e.warnings = v.warnings;
    throw e;
  }
  const g = v.game;
  if (g.creator_id !== userId) {
    const e = new Error('Cannot publish');
    e.code = 'FORBIDDEN';
    throw e;
  }
  // Moderation lock — creator cannot republish suspended/removed/banned games
  const blocked = new Set(['SUSPENDED', 'REMOVED', 'BANNED', 'MODERATION_HOLD']);
  if (blocked.has(String(g.state || '').toUpperCase())) {
    const e = new Error('Game is under moderation and cannot be published');
    e.code = 'MODERATION_LOCK';
    throw e;
  }
  // Optional explicit moderation_status column
  try {
    const cols = db.prepare('PRAGMA table_info(games)').all().map(c => c.name);
    if (cols.includes('moderation_status')) {
      const ms = String(g.moderation_status || 'ok').toLowerCase();
      if (ms !== 'ok' && ms !== 'approved' && ms !== '') {
        const e = new Error('Game is under moderation and cannot be published');
        e.code = 'MODERATION_LOCK';
        throw e;
      }
    }
  } catch (e) {
    if (e.code === 'MODERATION_LOCK') throw e;
  }

  const wasPublished = g.state === 'PUBLISHED';
  const maxVer = db.prepare('SELECT MAX(version) as m FROM game_versions WHERE game_id=?').get(g.id);
  const nextFromHistory = (maxVer && maxVer.m != null) ? maxVer.m + 1 : 1;
  const ver = Math.max(nextFromHistory, (g.version || 0) + 1);
  const now = new Date().toISOString();

  let pubDef = v.def;
  if (!pubDef) {
    pubDef = sanitizeDefinition({
      objects: v.objects.map((o) => ({
        id: o.id,
        type: o.type,
        name: o.name,
        x: o.x,
        y: o.y,
        w: (o.scale_x || 1) * 36,
        h: (o.scale_y || 1) * 20,
        rotation: o.rotation,
        collision: !!o.collision
      })),
      scripts: [],
      rules: { maxPlayers: g.max_players || 10 }
    });
  }
  pubDef.rules = pubDef.rules || {};
  pubDef.rules.maxPlayers = g.max_players || pubDef.rules.maxPlayers || 10;

  const scripts = db.prepare('SELECT event_name as event, source FROM game_scripts WHERE game_id=?').all(g.id);
  const versionId = uuid();

  const run = db.transaction(() => {
    // ensure at least one non-test server
    const sc = db.prepare('SELECT COUNT(*) as c FROM game_servers WHERE game_id=? AND is_test=0').get(g.id);
    if (!sc || sc.c < 1) {
      for (let i = 1; i <= 3; i++) {
        db.prepare(
          `INSERT INTO game_servers (id, game_id, name, region, max_players, is_test, status, created_at) VALUES (?,?,?,'local',?,0,'online',?)`
        ).run(uuid(), g.id, 'Server ' + i, g.max_players || 10, now);
      }
    }

    db.prepare(
      `INSERT INTO game_versions (id, game_id, version, data_json, scripts_json, objects_json, publisher_id, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      versionId,
      g.id,
      ver,
      JSON.stringify({ name: g.name, description: g.description, definition: pubDef }),
      JSON.stringify(scripts),
      JSON.stringify(v.objects),
      userId,
      now
    );

    db.prepare(`INSERT OR REPLACE INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`).run(
      g.id,
      JSON.stringify(pubDef),
      now
    );

    db.prepare(
      `UPDATE games SET state='PUBLISHED', version=?, published_version=?, published_at=?, updated_at=? WHERE id=?`
    ).run(ver, ver, now, now, g.id);
  });
  run();

  return {
    game: db.prepare('SELECT * FROM games WHERE id=?').get(g.id),
    versionId,
    version: ver,
    wasPublished,
    warnings: v.warnings
  };
}

function unpublishGame(userId, gameId) {
  const collab = require('./collab');

  const g = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!g || g.creator_id !== userId) {
    const e = new Error('Cannot unpublish');
    e.code = 'FORBIDDEN';
    throw e;
  }
  const blocked = new Set(['SUSPENDED', 'REMOVED', 'BANNED', 'MODERATION_HOLD']);
  if (blocked.has(String(g.state || '').toUpperCase())) {
    const e = new Error('Moderated games cannot be changed by the creator');
    e.code = 'MODERATION_LOCK';
    throw e;
  }
  if (g.state !== 'PUBLISHED') {
    const e = new Error('Game is not published');
    e.code = 'STATE';
    throw e;
  }
  db.prepare(`UPDATE games SET state='DRAFT', updated_at=? WHERE id=?`).run(new Date().toISOString(), gameId);
  return db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
}

/** Admin-only: suspend game (locks publish). */
function suspendGame(adminId, gameId, reason) {
  const g = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!g) {
    const e = new Error('Not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const now = new Date().toISOString();
  db.prepare(`UPDATE games SET state='SUSPENDED', updated_at=? WHERE id=?`).run(now, gameId);
  try {
    db.prepare(`INSERT INTO admin_actions (id, admin_id, action, target_type, target_id, details, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(require('./crypto').uuid(), adminId, 'suspend_game', 'game', gameId, String(reason||'').slice(0,200), now);
  } catch (_) {}
  return db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
}

/** Admin-only: restore to DRAFT (creator must publish again). */
function unsuspendGame(adminId, gameId) {
  const g = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!g) {
    const e = new Error('Not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (g.state !== 'SUSPENDED' && g.state !== 'MODERATION_HOLD') {
    const e = new Error('Game is not suspended');
    e.code = 'STATE';
    throw e;
  }
  const now = new Date().toISOString();
  db.prepare(`UPDATE games SET state='DRAFT', updated_at=? WHERE id=?`).run(now, gameId);
  try {
    db.prepare(`INSERT INTO admin_actions (id, admin_id, action, target_type, target_id, details, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(require('./crypto').uuid(), adminId, 'unsuspend_game', 'game', gameId, '', now);
  } catch (_) {}
  return db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
}

module.exports = { validateForPublish, publishGame, unpublishGame, suspendGame, unsuspendGame, ensurePublishColumns };
