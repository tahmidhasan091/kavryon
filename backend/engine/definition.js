/**
 * Game definition schema — structured JSON for worlds, entities, rules, scripts (DSL).
 * Validated server-side before publish/runtime.
 */
const LIMITS = {
  maxObjects: 200,
  maxNpcs: 40,
  maxItems: 80,
  maxQuests: 40,
  maxShops: 20,
  maxScripts: 60,
  maxActionsPerScript: 20,
  maxTeams: 8,
  maxNameLen: 48,
  maxDescLen: 2000
};

const OBJECT_TYPES = new Set([
  'block', 'platform', 'wall', 'floor', 'spawn', 'checkpoint', 'finish',
  'hazard', 'trigger', 'door', 'teleport', 'bed', 'generator', 'shop',
  'npc', 'enemy', 'boss', 'item_pickup', 'zone', 'decoration'
]);

const ACTION_TYPES = new Set([
  'broadcast', 'message', 'setHealth', 'damage', 'heal', 'kill', 'respawn',
  'teleport', 'setCheckpoint', 'giveItem', 'takeItem', 'addScore', 'addXp',
  'setTeam', 'eliminateTeam', 'startRound', 'endRound', 'win', 'lose',
  'setTimer', 'openShop', 'grantQuest', 'completeObjective', 'spawnEntity',
  'setVar', 'incVar', 'ifVar', 'addCurrency', 'takeCurrency', 'spectate'
]);

function clampNum(n, a, b, d = 0) {
  n = Number(n);
  if (!Number.isFinite(n)) return d;
  return Math.max(a, Math.min(b, n));
}

function sanitizeDefinition(raw) {
  const def = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  const out = {
    version: 1,
    template: String(def.template || 'Empty').slice(0, 40),
    dimension: def.dimension === '3d' ? '3d' : '2d',
    world: {
      width: clampNum(def.world?.width, 320, 2000, 640),
      height: clampNum(def.world?.height, 240, 1200, 360),
      gravity: clampNum(def.world?.gravity, 0.1, 2, 0.5),
      background: String(def.world?.background || '#0a1428').slice(0, 20)
    },
    teams: [],
    objects: [],
    items: [],
    npcs: [],
    quests: [],
    shops: [],
    rules: {
      maxPlayers: clampNum(def.rules?.maxPlayers, 1, 32, 10),
      lives: clampNum(def.rules?.lives, 0, 99, 0),
      respawnDelayMs: clampNum(def.rules?.respawnDelayMs, 0, 15000, 1500),
      matchDurationSec: clampNum(def.rules?.matchDurationSec, 0, 3600, 0),
      friendlyFire: !!def.rules?.friendlyFire,
      eliminateOnBedBreak: !!def.rules?.eliminateOnBedBreak,
      winCondition: String(def.rules?.winCondition || 'lastStanding').slice(0, 40),
      startingItems: Array.isArray(def.rules?.startingItems) ? def.rules.startingItems.slice(0, 20) : []
    },
    scripts: [],
    vars: {}
  };

  for (const t of (def.teams || []).slice(0, LIMITS.maxTeams)) {
    out.teams.push({
      id: String(t.id || t.name || 'team').slice(0, 24),
      name: String(t.name || t.id || 'Team').slice(0, 32),
      color: String(t.color || '#5eead4').slice(0, 16)
    });
  }

  for (const o of (def.objects || []).slice(0, LIMITS.maxObjects)) {
    const type = OBJECT_TYPES.has(o.type) ? o.type : 'block';
    out.objects.push({
      id: String(o.id || `o_${Math.random().toString(36).slice(2, 9)}`).slice(0, 40),
      type,
      x: clampNum(o.x, -100, out.world.width + 100, 100),
      y: clampNum(o.y, -100, out.world.height + 100, 200),
      w: clampNum(o.w ?? (o.scale_x || 1) * 36, 4, 400, 36),
      h: clampNum(o.h ?? (o.scale_y || 1) * 20, 4, 400, 20),
      rotation: clampNum(o.rotation, 0, 360, 0),
      collision: o.collision !== 0 && o.collision !== false,
      props: typeof o.props === 'object' && o.props ? o.props : {},
      team: o.team ? String(o.team).slice(0, 24) : null,
      label: String(o.label || '').slice(0, 40)
    });
  }

  for (const it of (def.items || []).slice(0, LIMITS.maxItems)) {
    out.items.push({
      id: String(it.id).slice(0, 40),
      name: String(it.name || it.id).slice(0, 40),
      type: String(it.type || 'misc').slice(0, 24),
      stack: clampNum(it.stack, 1, 999, 1),
      damage: clampNum(it.damage, 0, 500, 0),
      armor: clampNum(it.armor, 0, 100, 0),
      price: clampNum(it.price, 0, 1e6, 0),
      currency: String(it.currency || 'coins').slice(0, 24),
      rarity: String(it.rarity || 'common').slice(0, 16),
      meta: typeof it.meta === 'object' ? it.meta : {}
    });
  }

  for (const n of (def.npcs || []).slice(0, LIMITS.maxNpcs)) {
    out.npcs.push({
      id: String(n.id).slice(0, 40),
      name: String(n.name || 'NPC').slice(0, 40),
      kind: String(n.kind || 'enemy').slice(0, 24),
      x: clampNum(n.x, 0, out.world.width, 200),
      y: clampNum(n.y, 0, out.world.height, 200),
      health: clampNum(n.health, 1, 10000, 50),
      damage: clampNum(n.damage, 0, 500, 5),
      speed: clampNum(n.speed, 0, 10, 1.5),
      ai: String(n.ai || 'patrol').slice(0, 24),
      team: n.team ? String(n.team).slice(0, 24) : null,
      dropId: n.dropId ? String(n.dropId).slice(0, 40) : null,
      dialogue: String(n.dialogue || '').slice(0, 200),
      questId: n.questId ? String(n.questId).slice(0, 40) : null
    });
  }

  for (const q of (def.quests || []).slice(0, LIMITS.maxQuests)) {
    out.quests.push({
      id: String(q.id).slice(0, 40),
      title: String(q.title || q.id).slice(0, 60),
      description: String(q.description || '').slice(0, 300),
      objectives: (q.objectives || []).slice(0, 10).map((o) => ({
        id: String(o.id || 'obj').slice(0, 40),
        type: String(o.type || 'collect').slice(0, 24),
        target: String(o.target || '').slice(0, 40),
        count: clampNum(o.count, 1, 999, 1)
      })),
      rewards: {
        xp: clampNum(q.rewards?.xp, 0, 100000, 0),
        coins: clampNum(q.rewards?.coins, 0, 100000, 0),
        items: Array.isArray(q.rewards?.items) ? q.rewards.items.slice(0, 10) : []
      },
      repeatable: !!q.repeatable
    });
  }

  for (const s of (def.shops || []).slice(0, LIMITS.maxShops)) {
    out.shops.push({
      id: String(s.id).slice(0, 40),
      name: String(s.name || 'Shop').slice(0, 40),
      listings: (s.listings || []).slice(0, 40).map((l) => ({
        itemId: String(l.itemId).slice(0, 40),
        price: clampNum(l.price, 0, 1e6, 1),
        currency: String(l.currency || 'coins').slice(0, 24),
        limit: clampNum(l.limit, 0, 999, 0)
      }))
    });
  }

  for (const sc of (def.scripts || []).slice(0, LIMITS.maxScripts)) {
    const actions = (sc.actions || []).slice(0, LIMITS.maxActionsPerScript).filter((a) => ACTION_TYPES.has(a.type));
    out.scripts.push({
      on: String(sc.on || '').slice(0, 40),
      filter: typeof sc.filter === 'object' && sc.filter ? sc.filter : {},
      actions
    });
  }

  if (def.vars && typeof def.vars === 'object') {
    for (const [k, v] of Object.entries(def.vars).slice(0, 40)) {
      out.vars[String(k).slice(0, 32)] = typeof v === 'number' ? v : String(v).slice(0, 64);
    }
  }

  return out;
}

function objectsToLegacyRows(gameId, objects) {
  return objects.map((o, idx) => ({
    id: String(gameId).slice(0, 8) + '_' + String(o.id || ('obj' + idx)).slice(0, 40),
    game_id: gameId,
    type: o.type,
    name: String(o.label || o.name || o.type || 'obj').slice(0, 40),
    x: o.x,
    y: o.y,
    scale_x: (o.w || 36) / 36,
    scale_y: (o.h || 20) / 20,
    rotation: o.rotation || 0,
    collision: o.collision ? 1 : 0,
    visibility: 1,
    props_json: JSON.stringify({ ...(o.props || {}), team: o.team || null })
  }));
}

module.exports = { LIMITS, OBJECT_TYPES, ACTION_TYPES, sanitizeDefinition, objectsToLegacyRows };
