/**
 * RoomManager — manages GameRuntime instances (in-memory; swappable storage later).
 */
const { GameRuntime } = require('../engine/runtime');
const { sanitizeDefinition } = require('../engine/definition');

class RoomManager {
  constructor() {
    this.runtimes = new Map(); // serverId -> GameRuntime
  }

  key(id) { return String(id); }

  getRuntime(serverId) {
    return this.runtimes.get(this.key(serverId));
  }

  ensure(serverId, def, meta) {
    const k = this.key(serverId);
    if (!this.runtimes.has(k)) {
      const d = sanitizeDefinition(def || {});
      this.runtimes.set(k, new GameRuntime(k, d, meta || {}));
    }
    return this.runtimes.get(k);
  }

  /** Load colliders from legacy object rows or definition */
  setColliders(serverId, objects, def) {
    const definition = def || {
      world: { width: 640, height: 360, gravity: 0.5 },
      objects: (objects || []).map((o) => ({
        id: o.id,
        type: o.type,
        x: Number(o.x) || 0,
        y: Number(o.y) || 0,
        w: (Number(o.scale_x) || 1) * 36,
        h: (Number(o.scale_y) || 1) * 20,
        rotation: o.rotation || 0,
        collision: o.collision !== 0,
        props: (() => { try { return JSON.parse(o.props_json || '{}'); } catch { return {}; } })(),
        team: o.team || null
      })),
      rules: { maxPlayers: 10 },
      teams: [], items: [], npcs: [], quests: [], shops: [], scripts: []
    };
    // replace runtime
    const prev = this.runtimes.get(this.key(serverId));
    if (prev) prev.destroy();
    this.runtimes.set(this.key(serverId), new GameRuntime(serverId, sanitizeDefinition(definition), {
      gameId: definition.gameId,
      maxPlayers: definition.rules?.maxPlayers || 10
    }));
  }

  createFromDefinition(serverId, def, meta) {
    const prev = this.runtimes.get(this.key(serverId));
    if (prev) prev.destroy();
    const rt = new GameRuntime(serverId, sanitizeDefinition(def), meta || {});
    this.runtimes.set(this.key(serverId), rt);
    return rt;
  }

  count(serverId) {
    const rt = this.getRuntime(serverId);
    return rt ? rt.count() : 0;
  }

  totalPlayers() {
    let n = 0;
    for (const rt of this.runtimes.values()) n += rt.count();
    return n;
  }

  join(serverId, user, spawn, meta) {
    let rt = this.getRuntime(serverId);
    if (!rt) {
      rt = this.ensure(serverId, meta?.def || {}, meta);
    }
    const view = rt.join(user, meta?.team);
    // Best-effort shared registry (memory or Redis)
    try {
      const reg = this._registry;
      if (reg && user && user.id) reg.addPlayer(serverId, user.id).catch(() => {});
    } catch (_) {}
    return view;
  }

  leave(serverId, userId) {
    const rt = this.getRuntime(serverId);
    if (rt) {
      rt.leave(userId);
      try {
        const reg = this._registry;
        if (reg) reg.removePlayer(serverId, userId).catch(() => {});
      } catch (_) {}
      if (rt.count() === 0) {
        rt.destroy();
        this.runtimes.delete(this.key(serverId));
      }
    }
  }

  async attachRegistry(registry) {
    this._registry = registry;
  }

  getMode() {
    try {
      return require('./roomRegistry').getMode();
    } catch (_) {
      return 'memory';
    }
  }

  applyInput(serverId, userId, input) {
    const rt = this.getRuntime(serverId);
    if (!rt) return null;
    return rt.applyInput(userId, input);
  }

  move() { return null; } // reject client positions

  damage(serverId, userId, amount) {
    const rt = this.getRuntime(serverId);
    if (!rt) return null;
    rt.damage(userId, amount);
    return rt.players.get(userId) ? rt.playerView(rt.players.get(userId)) : null;
  }

  respawn(serverId, userId) {
    const rt = this.getRuntime(serverId);
    if (!rt) return null;
    return rt.respawnPlayer(userId);
  }

  snapshot(serverId) {
    const rt = this.getRuntime(serverId);
    return rt ? rt.snapshot() : [];
  }

  broadcast(serverId, msg, exceptId) {
    const rt = this.getRuntime(serverId);
    if (rt) rt.broadcast(msg, exceptId);
  }

  buy(serverId, userId, shopId, itemId) {
    const rt = this.getRuntime(serverId);
    return rt ? rt.buy(userId, shopId, itemId) : { error: 'NO_ROOM' };
  }

  tickAll() {
    for (const rt of this.runtimes.values()) {
      try { rt.tick(1); } catch (_) {}
    }
  }
}

const defaultManager = new RoomManager();
// global tick
const _tick = setInterval(() => defaultManager.tickAll(), 100);
if (typeof _tick.unref === 'function') _tick.unref();

module.exports = { RoomManager, rooms: defaultManager };
