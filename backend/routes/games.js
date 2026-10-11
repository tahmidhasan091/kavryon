const express = require('express');
const { uuid } = require('../services/crypto');
const db = require('../database/db');
const { requireAuth, requireDeveloper } = require('../middleware/auth');
const rooms = require('../multiplayer/rooms');

const router = express.Router();
const CATEGORIES = ['Adventure', 'Horror', 'Survival', 'Racing', 'Simulator', 'Strategy', 'RPG', 'Puzzle', 'Platform', 'Casual', 'Arena'];
const TEMPLATES = ['Empty World', 'Arena', 'Racing', 'Survival', 'Platform', 'Obstacle Course'];

router.get('/discover', requireAuth, (req, res) => {
  const cat = req.query.category;
  let sql = `SELECT g.*, u.username as creator FROM games g JOIN users u ON u.id = g.creator_id WHERE g.state = 'PUBLISHED'`;
  const args = [];
  if (cat) {
    sql += ' AND g.category = ?';
    args.push(cat);
  }
  sql += ' ORDER BY g.plays DESC, g.likes DESC';
  const games = db.prepare(sql).all(...args).map(withLive);
  res.json({ games, categories: CATEGORIES });
});

router.get('/mine', requireAuth, (req, res) => {
  const games = db.prepare('SELECT * FROM games WHERE creator_id = ? ORDER BY updated_at DESC').all(req.user.id);
  res.json({ games });
});

router.get('/:id', requireAuth, (req, res) => {
  const g = loadGame(req.params.id);
  if (!g) return res.status(404).json({ error: 'Game not found' });
  if (g.state !== 'PUBLISHED' && g.creator_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not visible' });
  }
  res.json({ game: withLive(g), objects: objects(g.id), scripts: scripts(g.id), servers: servers(g.id) });
});

router.post('/', requireAuth, requireDeveloper, (req, res) => {
  const { name, description, category, template, maxPlayers } = req.body || {};
  if (!name || name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Invalid name' });
  if (!TEMPLATES.includes(template)) return res.status(400).json({ error: 'Invalid template' });
  const cat = CATEGORIES.includes(category) ? category : 'Casual';
  const max = Math.min(50, Math.max(2, Number(maxPlayers) || 8));
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO games (id, creator_id, name, description, category, max_players, template, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`
  ).run(id, req.user.id, name.trim(), String(description || '').slice(0, 500), cat, max, template, now, now);
  seedTemplate(id, template);
  ensureServers(id, max);
  res.json({ game: loadGame(id) });
});

router.put('/:id', requireAuth, requireDeveloper, (req, res) => {
  const g = loadGame(req.params.id);
  if (!g || g.creator_id !== req.user.id) return res.status(403).json({ error: 'Cannot edit this game' });
  const b = req.body || {};
  db.prepare(
    `UPDATE games SET name=?, description=?, category=?, max_players=?, mode=?, public=?, friendly_fire=?, respawn=?, duration_sec=?, updated_at=?
     WHERE id=?`
  ).run(
    (b.name || g.name).slice(0, 40),
    String(b.description ?? g.description).slice(0, 500),
    CATEGORIES.includes(b.category) ? b.category : g.category,
    Math.min(50, Math.max(2, Number(b.maxPlayers ?? g.max_players))),
    b.mode || g.mode,
    b.public === false ? 0 : 1,
    b.friendlyFire ? 1 : 0,
    b.respawn === false ? 0 : 1,
    Number(b.durationSec ?? g.duration_sec),
    new Date().toISOString(),
    g.id
  );
  res.json({ game: loadGame(g.id) });
});

router.put('/:id/objects', requireAuth, requireDeveloper, (req, res) => {
  const g = loadGame(req.params.id);
  if (!g || g.creator_id !== req.user.id) return res.status(403).json({ error: 'Cannot edit' });
  const list = Array.isArray(req.body.objects) ? req.body.objects.slice(0, 200) : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM game_objects WHERE game_id = ?').run(g.id);
    const ins = db.prepare(
      `INSERT INTO game_objects (id, game_id, type, name, x, y, rotation, scale_x, scale_y, collision, visibility, props_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const o of list) {
      ins.run(
        o.id || uuid(),
        g.id,
        String(o.type || 'block').slice(0, 32),
        String(o.name || o.type || 'obj').slice(0, 40),
        Number(o.x) || 0,
        Number(o.y) || 0,
        Number(o.rotation) || 0,
        Number(o.scaleX ?? o.scale_x) || 1,
        Number(o.scaleY ?? o.scale_y) || 1,
        o.collision === false ? 0 : 1,
        o.visibility === false ? 0 : 1,
        JSON.stringify(o.props || {})
      );
    }
    db.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), g.id);
  });
  tx();
  res.json({ objects: objects(g.id) });
});

router.put('/:id/scripts', requireAuth, requireDeveloper, (req, res) => {
  const g = loadGame(req.params.id);
  if (!g || g.creator_id !== req.user.id) return res.status(403).json({ error: 'Cannot edit' });
  const allowed = new Set(['onGameStart', 'onPlayerJoin', 'onPlayerLeave', 'onPlayerTouch', 'onPlayerDeath', 'onPlayerRespawn', 'onPlayerWin']);
  const list = Array.isArray(req.body.scripts) ? req.body.scripts : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM game_scripts WHERE game_id = ?').run(g.id);
    const ins = db.prepare('INSERT INTO game_scripts (id, game_id, event_name, source) VALUES (?, ?, ?, ?)');
    for (const s of list) {
      if (!allowed.has(s.event)) continue;
      const src = sanitizeScript(String(s.source || ''));
      ins.run(uuid(), g.id, s.event, src.slice(0, 4000));
    }
  });
  tx();
  res.json({ scripts: scripts(g.id) });
});

router.post('/:id/publish', requireAuth, requireDeveloper, (req, res) => {
  const g = loadGame(req.params.id);
  if (!g || g.creator_id !== req.user.id) return res.status(403).json({ error: 'Cannot publish' });
  if (!g.name || !g.description) return res.status(400).json({ error: 'Name and description required' });
  const objs = objects(g.id);
  if (objs.length < 1) return res.status(400).json({ error: 'Add at least one object' });
  db.prepare(`UPDATE games SET state='PUBLISHED', updated_at=? WHERE id=?`).run(new Date().toISOString(), g.id);
  ensureServers(g.id, g.max_players);
  res.json({ game: loadGame(g.id) });
});

router.post('/:id/like', requireAuth, (req, res) => {
  db.prepare('UPDATE games SET likes = likes + 1 WHERE id = ? AND state = ?').run(req.params.id, 'PUBLISHED');
  res.json({ ok: true });
});

router.post('/:id/favorite', requireAuth, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, game_id, created_at) VALUES (?, ?, ?)').run(req.user.id, req.params.id, new Date().toISOString());
  res.json({ ok: true });
});

router.post('/:id/play', requireAuth, (req, res) => {
  const g = loadGame(req.params.id);
  if (!g || (g.state !== 'PUBLISHED' && g.creator_id !== req.user.id)) return res.status(404).json({ error: 'Unavailable' });
  db.prepare('UPDATE games SET plays = plays + 1 WHERE id = ?').run(g.id);
  const serverId = req.body.serverId;
  const srv = serverId
    ? db.prepare('SELECT * FROM game_servers WHERE id = ? AND game_id = ?').get(serverId, g.id)
    : db.prepare('SELECT * FROM game_servers WHERE game_id = ? AND is_test = 0 ORDER BY name').all(g.id).find((s) => rooms.count(s.id) < s.max_players);
  if (!srv) return res.status(409).json({ error: 'No open servers' });
  if (rooms.count(srv.id) >= srv.max_players) return res.status(409).json({ error: 'FULL' });
  res.json({ serverId: srv.id, wsPath: `/ws/game/${g.id}?server=${srv.id}` });
});

router.post('/:id/test-server', requireAuth, requireDeveloper, (req, res) => {
  const g = loadGame(req.params.id);
  if (!g || g.creator_id !== req.user.id) return res.status(403).json({ error: 'Cannot test' });
  let srv = db.prepare('SELECT * FROM game_servers WHERE game_id = ? AND is_test = 1').get(g.id);
  if (!srv) {
    const id = uuid();
    db.prepare(
      `INSERT INTO game_servers (id, game_id, name, region, max_players, is_test, status, created_at)
       VALUES (?, ?, 'TEST SERVER', 'local', ?, 1, 'online', ?)`
    ).run(id, g.id, g.max_players, new Date().toISOString());
    srv = db.prepare('SELECT * FROM game_servers WHERE id = ?').get(id);
  }
  res.json({ server: srv, wsPath: `/ws/game/${g.id}?server=${srv.id}` });
});

function loadGame(id) {
  return db.prepare('SELECT g.*, u.username as creator FROM games g JOIN users u ON u.id = g.creator_id WHERE g.id = ?').get(id);
}
function objects(id) {
  return db.prepare('SELECT * FROM game_objects WHERE game_id = ?').all(id);
}
function scripts(id) {
  return db.prepare('SELECT event_name as event, source FROM game_scripts WHERE game_id = ?').all(id);
}
function servers(id) {
  return db.prepare('SELECT * FROM game_servers WHERE game_id = ?').all(id).map((s) => ({
    ...s,
    players: rooms.count(s.id),
    full: rooms.count(s.id) >= s.max_players
  }));
}
function withLive(g) {
  const sv = servers(g.id);
  const current = sv.reduce((n, s) => n + s.players, 0);
  return { ...g, currentPlayers: current, servers: sv };
}
function ensureServers(gameId, max) {
  const n = db.prepare('SELECT COUNT(*) as c FROM game_servers WHERE game_id = ? AND is_test = 0').get(gameId).c;
  if (n === 0) {
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        `INSERT INTO game_servers (id, game_id, name, region, max_players, is_test, status, created_at)
         VALUES (?, ?, ?, 'local', ?, 0, 'online', ?)`
      ).run(uuid(), gameId, `Server ${i}`, max, new Date().toISOString());
    }
  }
}
function seedTemplate(gameId, template) {
  const add = (type, name, x, y) => {
    db.prepare(
      `INSERT INTO game_objects (id, game_id, type, name, x, y, rotation, scale_x, scale_y, collision, visibility, props_json)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, 1, 1, '{}')`
    ).run(uuid(), gameId, type, name, x, y);
  };
  add('spawn', 'Spawn A', 80, 220);
  add('spawn', 'Spawn B', 520, 220);
  add('block', 'Floor', 300, 340);
  if (template === 'Arena') add('hazard', 'Pit', 300, 180);
  if (template === 'Racing') add('goal', 'Finish', 560, 120);
  if (template === 'Platform') add('platform', 'Lift', 300, 200);
  if (template === 'Obstacle Course') {
    add('hazard', 'Spike', 240, 260);
    add('checkpoint', 'CP1', 400, 260);
    add('goal', 'End', 560, 260);
  }
  if (template === 'Survival') add('coin', 'Cache', 300, 160);
}

function sanitizeScript(src) {
  const banned = [/require\s*\(/i, /process\./i, /child_process/i, /fs\./i, /net\./i, /eval\s*\(/i, /Function\s*\(/i, /fetch\s*\(/i, /XMLHttpRequest/i, /WebSocket/i, /localStorage/i, /indexedDB/i];
  let out = src;
  for (const b of banned) out = out.replace(b, '/*blocked*/');
  return out;
}

module.exports = router;
module.exports.sanitizeScript = sanitizeScript;
