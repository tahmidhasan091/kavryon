/**
 * Shared multiplayer room registry.
 *
 * Local (default): in-memory Map — fine for single process.
 * Production: set REDIS_URL — room membership/metadata shared across instances.
 *
 * Game simulation (GameRuntime) remains process-local; use sticky sessions OR
 * accept that only the owning instance runs physics for a room (documented).
 *
 * Persistent data stays in SQLite/Postgres — never only in Redis.
 */
const crypto = require('crypto');

const INSTANCE_ID = process.env.INSTANCE_ID || crypto.randomBytes(4).toString('hex');

class MemoryBackend {
  constructor() {
    this.rooms = new Map(); // serverId -> { meta, players: Set, updatedAt }
  }
  async get(serverId) {
    return this.rooms.get(String(serverId)) || null;
  }
  async set(serverId, data) {
    this.rooms.set(String(serverId), { ...data, updatedAt: Date.now() });
  }
  async del(serverId) {
    this.rooms.delete(String(serverId));
  }
  async addPlayer(serverId, userId) {
    const r = (await this.get(serverId)) || { players: new Set(), meta: {} };
    if (!(r.players instanceof Set)) r.players = new Set(r.players || []);
    r.players.add(String(userId));
    await this.set(serverId, r);
    return r.players.size;
  }
  async removePlayer(serverId, userId) {
    const r = await this.get(serverId);
    if (!r) return 0;
    if (!(r.players instanceof Set)) r.players = new Set(r.players || []);
    r.players.delete(String(userId));
    if (r.players.size === 0) await this.del(serverId);
    else await this.set(serverId, r);
    return r.players.size;
  }
  async playerCount(serverId) {
    const r = await this.get(serverId);
    if (!r) return 0;
    if (r.players instanceof Set) return r.players.size;
    return (r.players || []).length;
  }
  async listRooms() {
    return [...this.rooms.keys()];
  }
}

class RedisBackend {
  constructor(redis) {
    this.redis = redis;
    this.prefix = process.env.REDIS_PREFIX || 'kavryon:room:';
  }
  key(id) { return this.prefix + String(id); }
  async get(serverId) {
    const raw = await this.redis.get(this.key(serverId));
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      data.players = new Set(data.players || []);
      return data;
    } catch { return null; }
  }
  async set(serverId, data) {
    const payload = {
      meta: data.meta || {},
      players: [...(data.players instanceof Set ? data.players : data.players || [])],
      ownerInstance: data.ownerInstance || INSTANCE_ID,
      updatedAt: Date.now()
    };
    await this.redis.set(this.key(serverId), JSON.stringify(payload), 'EX', Number(process.env.ROOM_TTL_SEC || 3600));
  }
  async del(serverId) {
    await this.redis.del(this.key(serverId));
  }
  async addPlayer(serverId, userId) {
    const r = (await this.get(serverId)) || { players: new Set(), meta: {}, ownerInstance: INSTANCE_ID };
    r.players.add(String(userId));
    await this.set(serverId, r);
    return r.players.size;
  }
  async removePlayer(serverId, userId) {
    const r = await this.get(serverId);
    if (!r) return 0;
    r.players.delete(String(userId));
    if (r.players.size === 0) await this.del(serverId);
    else await this.set(serverId, r);
    return r.players.size;
  }
  async playerCount(serverId) {
    const r = await this.get(serverId);
    return r ? r.players.size : 0;
  }
  async listRooms() {
    const keys = await this.redis.keys(this.prefix + '*');
    return keys.map((k) => k.slice(this.prefix.length));
  }
}

let backend = null;
let mode = 'memory';

async function initRegistry() {
  if (backend) return backend;
  const url = process.env.REDIS_URL;
  if (url && process.env.MULTIPLAYER_MODE === 'redis') {
    try {
      // Optional dependency — only required in redis mode
      const Redis = require('ioredis');
      const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
      await redis.connect();
      await redis.ping();
      backend = new RedisBackend(redis);
      mode = 'redis';
      console.log('[multiplayer] Redis room registry connected', INSTANCE_ID);
      return backend;
    } catch (e) {
      if (process.env.NODE_ENV === 'production' && process.env.MULTIPLAYER_REQUIRE_REDIS === 'true') {
        console.error('[multiplayer] REDIS required but unavailable:', e.message);
        process.exit(1);
      }
      console.warn('[multiplayer] Redis unavailable, falling back to memory:', e.message);
    }
  }
  backend = new MemoryBackend();
  mode = 'memory';
  if (process.env.NODE_ENV === 'production' && process.env.MULTIPLAYER_REQUIRE_REDIS === 'true') {
    console.error('[multiplayer] MULTIPLAYER_REQUIRE_REDIS=true but REDIS_URL not set');
    process.exit(1);
  }
  return backend;
}

function getMode() {
  return mode;
}

function getInstanceId() {
  return INSTANCE_ID;
}

module.exports = {
  initRegistry,
  getMode,
  getInstanceId,
  MemoryBackend,
  RedisBackend
};
