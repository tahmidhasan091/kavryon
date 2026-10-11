/**
 * Server-authoritative GameRuntime — one instance per game server/room.
 * Clients send INPUT only; runtime owns physics, combat, inventory, match state.
 */
const { runScripts } = require('./dsl');

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

class GameRuntime {
  constructor(serverId, def, meta = {}) {
    this.serverId = String(serverId);
    this.def = def;
    this.meta = {
      gameId: meta.gameId || null,
      versionId: meta.versionId || null,
      maxPlayers: def.rules?.maxPlayers || meta.maxPlayers || 10,
      status: 'waiting',
      createdAt: Date.now(),
      lastActivity: Date.now()
    };
    this.players = new Map();
    this.entities = new Map(); // npcs, projectiles
    this.colliders = [];
    this.triggers = [];
    this.spawns = [];
    this.teamBeds = new Map(); // team -> bed object
    this.generators = [];
    this.vars = { ...(def.vars || {}) };
    this.timers = new Map();
    this.round = 0;
    this.matchEnded = false;
    this.winners = [];
    this.scriptErrors = 0;
    this.disabled = false;
    this.eventCount = 0;
    this._eventReset = setInterval(() => { this.eventCount = 0; }, 1000);
    if (typeof this._eventReset.unref === 'function') this._eventReset.unref();
    this._buildWorld();
    this._spawnNpcs();
  }

  destroy() {
    clearInterval(this._eventReset);
    this.players.clear();
    this.entities.clear();
  }

  _buildWorld() {
    this.colliders = [];
    this.triggers = [];
    this.spawns = [];
    this.generators = [];
    for (const o of this.def.objects || []) {
      if (o.type === 'spawn') {
        this.spawns.push({ x: o.x, y: o.y, team: o.team || null });
        continue;
      }
      if (o.type === 'bed' && o.team) this.teamBeds.set(o.team, { ...o, destroyed: false });
      if (o.type === 'generator') this.generators.push({ ...o, lastTick: Date.now() });
      if (['trigger', 'checkpoint', 'finish', 'teleport', 'shop', 'zone', 'item_pickup'].includes(o.type) || o.props?.trigger) {
        this.triggers.push(o);
      }
      if (o.collision !== false && !['spawn', 'trigger', 'zone', 'item_pickup', 'decoration'].includes(o.type)) {
        this.colliders.push({
          id: o.id,
          type: o.type,
          x: o.x - o.w / 2,
          y: o.y - o.h / 2,
          w: o.w,
          h: o.h,
          hazard: o.type === 'hazard',
          team: o.team,
          props: o.props
        });
      }
    }
    if (!this.colliders.length) {
      this.colliders.push({
        id: 'floor',
        type: 'floor',
        x: 0,
        y: this.def.world.height - 30,
        w: this.def.world.width,
        h: 40,
        hazard: false
      });
    }
    if (!this.spawns.length) this.spawns.push({ x: 80, y: 200, team: null });
  }

  _spawnNpcs() {
    for (const n of this.def.npcs || []) {
      this.entities.set(n.id, {
        ...n,
        eid: n.id,
        kind: n.kind || 'enemy',
        x: n.x,
        y: n.y,
        vx: 0,
        vy: 0,
        health: n.health,
        maxHealth: n.health,
        alive: true,
        state: 'idle',
        target: null,
        cooldown: 0
      });
    }
  }

  count() { return this.players.size; }

  join(user, preferredTeam) {
    if (this.players.size >= this.meta.maxPlayers) {
      const e = new Error('FULL'); e.code = 'FULL'; throw e;
    }
    if (this.matchEnded) {
      const e = new Error('MATCH_ENDED'); e.code = 'MATCH_ENDED'; throw e;
    }
    let team = preferredTeam || null;
    if (this.def.teams?.length) {
      if (!team || !this.def.teams.find((t) => t.id === team)) {
        // balance teams
        const counts = {};
        for (const t of this.def.teams) counts[t.id] = 0;
        for (const p of this.players.values()) if (p.team && counts[p.team] !== undefined) counts[p.team]++;
        team = Object.entries(counts).sort((a, b) => a[1] - b[1])[0]?.[0] || this.def.teams[0].id;
      }
    }
    const spawn = this._pickSpawn(team);
    const inv = {};
    for (const sid of this.def.rules.startingItems || []) inv[sid] = (inv[sid] || 0) + 1;
    const p = {
      id: user.id,
      username: user.username,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      alive: true,
      health: 100,
      maxHealth: 100,
      armor: 0,
      onGround: false,
      seq: 0,
      team,
      score: 0,
      xp: 0,
      level: 1,
      inventory: inv,
      equipment: { weapon: null, armor: null },
      currencies: { coins: 0 },
      quests: {},
      checkpoint: { x: spawn.x, y: spawn.y },
      bedDestroyed: false,
      spectating: false,
      lastAttack: 0,
      ws: user.ws
    };
    this.players.set(user.id, p);
    this.meta.status = this.players.size > 0 ? 'playing' : 'waiting';
    this.meta.lastActivity = Date.now();
    runScripts(this, 'onGameStart', { player: p });
    runScripts(this, 'onPlayerJoin', { player: p });
    runScripts(this, 'onPlayerSpawn', { player: p });
    return this.snapshot();
  }

  leave(userId) {
    const p = this.players.get(userId);
    if (p) runScripts(this, 'onPlayerLeave', { player: p });
    this.players.delete(userId);
    if (!this.players.size) this.meta.status = 'empty';
  }

  _pickSpawn(team) {
    const teamSpawns = this.spawns.filter((s) => s.team === team);
    const pool = teamSpawns.length ? teamSpawns : this.spawns;
    return pool[Math.floor(Math.random() * pool.length)] || { x: 100, y: 200 };
  }

  /**
   * INPUT protocol: { type:'input', left, right, jump, attack, interact, useItem, ability, sequence }
   */
  applyInput(userId, input) {
    const p = this.players.get(userId);
    if (!p || p.spectating) return null;
    const seq = Number(input.sequence) || 0;
    if (seq && seq <= p.seq) return this.playerView(p);
    p.seq = seq || p.seq;

    if (!p.alive) return this.playerView(p);

    let ax = 0;
    if (input.left) ax -= 1;
    if (input.right) ax += 1;
    if (input.ax !== undefined) ax = clamp(Number(input.ax) || 0, -1, 1);
    const jump = !!(input.jump || input.up);
    const speed = 4.2;
    p.vx = ax * speed;
    if (jump && p.onGround) {
      p.vy = -9.5;
      p.onGround = false;
    }

    this._physicsPlayer(p);

    // triggers / touch
    this._checkTriggers(p);

    if (input.attack) this._attack(p);
    if (input.interact) this._interact(p);
    if (input.useItem && input.itemId) this.useItem(p.id, String(input.itemId));

    this.meta.lastActivity = Date.now();
    return this.playerView(p);
  }

  _physicsPlayer(p) {
    const g = this.def.world.gravity || 0.5;
    const W = this.def.world.width;
    const H = this.def.world.height;
    p.vy += g;
    if (p.vy > 14) p.vy = 14;

    const pw = 16, ph = 20;
    let nx = clamp(p.x + p.vx, 8, W - 8);
    for (const c of this.colliders) {
      if (c.hazard) continue;
      if (aabb(nx - pw / 2, p.y - ph / 2, pw, ph, c.x, c.y, c.w, c.h)) {
        if (p.vx > 0) nx = c.x - pw / 2;
        else if (p.vx < 0) nx = c.x + c.w + pw / 2;
        p.vx = 0;
      }
    }
    p.x = nx;

    let ny = p.y + p.vy;
    p.onGround = false;
    for (const c of this.colliders) {
      if (aabb(p.x - pw / 2, ny - ph / 2, pw, ph, c.x, c.y, c.w, c.h)) {
        if (c.hazard) {
          this.damage(p.id, 20, null);
          ny = c.y - ph / 2 - 1;
          p.vy = -3;
          runScripts(this, 'onPlayerTouch', { player: p, object: { id: c.id, type: c.type } });
          continue;
        }
        if (p.vy > 0) {
          ny = c.y - ph / 2;
          p.vy = 0;
          p.onGround = true;
        } else if (p.vy < 0) {
          ny = c.y + c.h + ph / 2;
          p.vy = 0;
        }
      }
    }
    if (ny > H - 10) {
      // fell out
      this.kill(p.id);
      return;
    }
    if (ny < 10) { ny = 10; p.vy = 0; }
    p.y = ny;
    p.vx *= 0.82;
  }

  _checkTriggers(p) {
    const pw = 16, ph = 20;
    for (const t of this.triggers) {
      const tx = t.x - t.w / 2, ty = t.y - t.h / 2;
      if (!aabb(p.x - pw / 2, p.y - ph / 2, pw, ph, tx, ty, t.w, t.h)) continue;
      if (t.type === 'checkpoint') {
        p.checkpoint = { x: t.x, y: t.y };
        runScripts(this, 'onPlayerTouch', { player: p, object: t });
      } else if (t.type === 'finish') {
        runScripts(this, 'onPlayerWin', { player: p, object: t });
        if (this.def.rules.winCondition === 'finish') this.declareWinner(p.id, 'finish');
      } else if (t.type === 'teleport' && t.props?.targetX != null) {
        this.teleport(p.id, Number(t.props.targetX), Number(t.props.targetY) || p.y);
      } else if (t.type === 'shop') {
        runScripts(this, 'onPlayerTouch', { player: p, object: t });
      } else if (t.type === 'item_pickup' && t.props?.itemId) {
        this.giveItem(p.id, t.props.itemId, 1);
        // remove one-shot pickups from triggers
        this.triggers = this.triggers.filter((x) => x.id !== t.id);
        runScripts(this, 'onPlayerCollect', { player: p, object: t, itemId: t.props.itemId });
      } else {
        runScripts(this, 'onPlayerTouch', { player: p, object: t });
        runScripts(this, 'onPlayerEnterZone', { player: p, object: t, zone: t.props?.zone || t.id });
      }
    }
  }

  _attack(p) {
    const now = Date.now();
    if (now - p.lastAttack < 400) return;
    p.lastAttack = now;
    const weapon = p.equipment.weapon;
    const item = weapon ? this.def.items.find((i) => i.id === weapon) : null;
    const dmg = item?.damage || 10;
    const range = 36;
    // players
    for (const o of this.players.values()) {
      if (o.id === p.id || !o.alive) continue;
      if (!this.def.rules.friendlyFire && o.team && o.team === p.team) continue;
      const dx = o.x - p.x, dy = o.y - p.y;
      if (dx * dx + dy * dy < range * range) {
        this.damage(o.id, dmg, p.id);
        runScripts(this, 'onPlayerAttack', { player: p, target: o });
      }
    }
    // entities
    for (const e of this.entities.values()) {
      if (!e.alive) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      if (dx * dx + dy * dy < range * range) {
        e.health -= dmg;
        if (e.health <= 0) this._killEntity(e, p);
        runScripts(this, 'onPlayerAttack', { player: p, npc: e });
      }
    }
    // beds (BedWars-style)
    for (const [team, bed] of this.teamBeds) {
      if (bed.destroyed || team === p.team) continue;
      const dx = bed.x - p.x, dy = bed.y - p.y;
      if (dx * dx + dy * dy < 40 * 40) {
        bed.destroyed = true;
        bed.health = 0;
        this.broadcast({ type: 'bedDestroyed', team });
        for (const pl of this.players.values()) {
          if (pl.team === team) pl.bedDestroyed = true;
        }
        runScripts(this, 'onBedDestroyed', { player: p, team });
        this._checkElimination();
      }
    }
  }

  _interact(p) {
    for (const t of this.triggers) {
      if (t.type !== 'shop' && t.type !== 'npc') continue;
      const dx = t.x - p.x, dy = t.y - p.y;
      if (dx * dx + dy * dy < 48 * 48) {
        if (t.type === 'shop') this.send(p.id, { type: 'shop', shopId: t.props?.shopId || t.id });
        runScripts(this, 'onPlayerInteract', { player: p, object: t });
      }
    }
    for (const e of this.entities.values()) {
      if (e.kind !== 'npc' && e.kind !== 'vendor') continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      if (dx * dx + dy * dy < 48 * 48) {
        this.send(p.id, { type: 'dialogue', npcId: e.id, text: e.dialogue || '...' });
        if (e.questId) this.grantQuest(p.id, e.questId);
        runScripts(this, 'onPlayerInteract', { player: p, npc: e });
      }
    }
  }

  _killEntity(e, killer) {
    e.alive = false;
    e.health = 0;
    if (e.dropId && killer) this.giveItem(killer.id, e.dropId, 1);
    if (killer) {
      this.addXp(killer.id, 15);
      killer.score = (killer.score || 0) + 10;
      runScripts(this, 'onNpcDeath', { player: killer, npc: e });
      // quest progress kill
      this._questProgress(killer.id, 'kill', e.id, 1);
      this._questProgress(killer.id, 'kill', e.kind, 1);
    }
    this.broadcast({ type: 'entityDeath', id: e.id });
  }

  tick(dt = 1) {
    if (this.matchEnded) return;
    // NPC AI
    for (const e of this.entities.values()) {
      if (!e.alive) continue;
      e.cooldown = Math.max(0, (e.cooldown || 0) - dt);
      if (e.ai === 'patrol') {
        e.vx = Math.sin(Date.now() / 800 + e.x) * (e.speed || 1);
        e.x = clamp(e.x + e.vx, 20, this.def.world.width - 20);
      } else if (e.ai === 'chase' || e.kind === 'enemy' || e.kind === 'boss') {
        let nearest = null, best = 1e9;
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          const d = (p.x - e.x) ** 2 + (p.y - e.y) ** 2;
          if (d < best) { best = d; nearest = p; }
        }
        if (nearest && best < 200 * 200) {
          e.vx = Math.sign(nearest.x - e.x) * (e.speed || 1.5);
          e.x = clamp(e.x + e.vx, 20, this.def.world.width - 20);
          if (best < 28 * 28 && e.cooldown <= 0) {
            this.damage(nearest.id, e.damage || 5, e.id);
            e.cooldown = 30;
            runScripts(this, 'onPlayerTakeDamage', { player: nearest, npc: e });
          }
        }
      }
    }
    // generators (BedWars resources)
    const now = Date.now();
    for (const g of this.generators) {
      const rate = Number(g.props?.rateMs) || 3000;
      if (now - g.lastTick >= rate) {
        g.lastTick = now;
        const itemId = g.props?.itemId || 'iron';
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          if (g.team && p.team !== g.team) continue;
          const dx = p.x - g.x, dy = p.y - g.y;
          if (dx * dx + dy * dy < 50 * 50) this.giveItem(p.id, itemId, 1);
        }
      }
    }
    // timers
    for (const [name, t] of this.timers) {
      if (t.endsAt && now >= t.endsAt) {
        this.timers.delete(name);
        runScripts(this, 'onTimerEnd', { timer: name });
        if (name === 'match') this.endRound(null);
      }
    }
  }

  // ---- combat / health ----
  setHealth(userId, v) {
    const p = this.players.get(userId);
    if (!p) return;
    p.health = clamp(v, 0, p.maxHealth);
    if (p.health <= 0) this.kill(userId);
  }
  damage(userId, amount, sourceId) {
    const p = this.players.get(userId);
    if (!p || !p.alive) return;
    const raw = Math.max(0, Number(amount) || 0);
    const mitigated = Math.max(0, raw - (p.armor || 0) * 0.5);
    p.health = Math.max(0, p.health - mitigated);
    runScripts(this, 'onPlayerTakeDamage', { player: p, amount: mitigated, sourceId });
    if (p.health <= 0) this.kill(userId, sourceId);
  }
  heal(userId, amount) {
    const p = this.players.get(userId);
    if (!p || !p.alive) return;
    p.health = Math.min(p.maxHealth, p.health + (Number(amount) || 0));
  }
  kill(userId, sourceId) {
    const p = this.players.get(userId);
    if (!p || !p.alive) return;
    p.alive = false;
    p.health = 0;
    runScripts(this, 'onPlayerDeath', { player: p, sourceId });
    // BedWars: no respawn if bed destroyed
    const noRespawn = this.def.rules.eliminateOnBedBreak && p.bedDestroyed;
    if (noRespawn) {
      p.spectating = true;
      this._checkElimination();
    } else {
      const delay = this.def.rules.respawnDelayMs || 1500;
      setTimeout(() => {
        if (this.players.has(userId) && !this.players.get(userId).alive && !this.players.get(userId).spectating) {
          this.respawnPlayer(userId);
        }
      }, delay);
    }
  }
  respawnPlayer(userId) {
    const p = this.players.get(userId);
    if (!p) return null;
    const sp = p.checkpoint || this._pickSpawn(p.team);
    p.alive = true;
    p.spectating = false;
    p.health = p.maxHealth;
    p.x = sp.x;
    p.y = sp.y;
    p.vx = 0;
    p.vy = 0;
    runScripts(this, 'onPlayerSpawn', { player: p });
    this.broadcast({ type: 'state', players: this.snapshot() });
    return this.playerView(p);
  }

  // ---- inventory (server authoritative) ----
  giveItem(userId, itemId, qty = 1) {
    const p = this.players.get(userId);
    if (!p || !itemId) return false;
    const def = this.def.items.find((i) => i.id === itemId);
    const stack = def?.stack || 99;
    p.inventory[itemId] = Math.min(stack, (p.inventory[itemId] || 0) + qty);
    this.send(userId, { type: 'inventory', inventory: p.inventory });
    this._questProgress(userId, 'collect', itemId, qty);
    return true;
  }
  takeItem(userId, itemId, qty = 1) {
    const p = this.players.get(userId);
    if (!p) return false;
    if ((p.inventory[itemId] || 0) < qty) return false;
    p.inventory[itemId] -= qty;
    if (p.inventory[itemId] <= 0) delete p.inventory[itemId];
    this.send(userId, { type: 'inventory', inventory: p.inventory });
    return true;
  }
  useItem(userId, itemId) {
    const p = this.players.get(userId);
    if (!p || !this.takeItem(userId, itemId, 1)) return false;
    const def = this.def.items.find((i) => i.id === itemId);
    if (!def) return false;
    if (def.type === 'consumable' && def.meta?.heal) this.heal(userId, def.meta.heal);
    if (def.type === 'weapon') p.equipment.weapon = itemId;
    if (def.type === 'armor') {
      p.equipment.armor = itemId;
      p.armor = def.armor || 0;
    }
    runScripts(this, 'onPlayerUseItem', { player: p, itemId });
    return true;
  }

  // ---- shop ----
  buy(userId, shopId, itemId) {
    const p = this.players.get(userId);
    if (!p) return { error: 'NO_PLAYER' };
    const shop = this.def.shops.find((s) => s.id === shopId);
    if (!shop) return { error: 'NO_SHOP' };
    const listing = shop.listings.find((l) => l.itemId === itemId);
    if (!listing) return { error: 'NO_LISTING' };
    const cur = listing.currency || 'coins';
    p.currencies = p.currencies || {};
    // Prefer inventory resources (iron etc.), else wallet-style currencies
    if ((p.inventory[cur] || 0) >= listing.price) {
      this.takeItem(userId, cur, listing.price);
    } else if ((p.currencies[cur] || 0) >= listing.price) {
      p.currencies[cur] -= listing.price;
    } else {
      return { error: 'INSUFFICIENT' };
    }
    this.giveItem(userId, itemId, 1);
    runScripts(this, 'onPlayerBuy', { player: p, shopId, itemId });
    return { ok: true, inventory: p.inventory, currencies: p.currencies };
  }

  // ---- quests ----
  grantQuest(userId, questId) {
    const p = this.players.get(userId);
    const q = this.def.quests.find((x) => x.id === questId);
    if (!p || !q) return false;
    if (p.quests[questId]?.completed && !q.repeatable) return false;
    p.quests[questId] = {
      progress: Object.fromEntries((q.objectives || []).map((o) => [o.id, 0])),
      completed: false
    };
    this.send(userId, { type: 'quest', quest: q, state: p.quests[questId] });
    return true;
  }
  completeObjective(userId, questId, objectiveId) {
    this._questProgress(userId, null, null, 0, questId, objectiveId);
  }
  _questProgress(userId, type, target, count = 1, forceQuest, forceObj) {
    const p = this.players.get(userId);
    if (!p) return;
    for (const q of this.def.quests || []) {
      const st = p.quests[q.id];
      if (!st || st.completed) continue;
      for (const o of q.objectives || []) {
        if (forceQuest && forceObj) {
          if (q.id === forceQuest && o.id === forceObj) st.progress[o.id] = o.count;
        } else if (o.type === type && (o.target === target || !o.target)) {
          st.progress[o.id] = Math.min(o.count, (st.progress[o.id] || 0) + count);
        }
      }
      const done = (q.objectives || []).every((o) => (st.progress[o.id] || 0) >= o.count);
      if (done) {
        st.completed = true;
        if (q.rewards?.xp) this.addXp(userId, q.rewards.xp);
        if (q.rewards?.coins) p.currencies.coins = (p.currencies.coins || 0) + q.rewards.coins;
        for (const it of q.rewards?.items || []) this.giveItem(userId, it, 1);
        this.send(userId, { type: 'questComplete', questId: q.id });
        runScripts(this, 'onQuestComplete', { player: p, questId: q.id });
      }
    }
  }

  addXp(userId, amount) {
    const p = this.players.get(userId);
    if (!p) return;
    p.xp = (p.xp || 0) + (Number(amount) || 0);
    while (p.xp >= p.level * 50) {
      p.xp -= p.level * 50;
      p.level += 1;
      p.maxHealth += 5;
      p.health = p.maxHealth;
      this.send(userId, { type: 'levelUp', level: p.level });
    }
  }

  // ---- teams / match ----
  eliminateTeam(team) {
    for (const p of this.players.values()) {
      if (p.team === team) {
        p.spectating = true;
        p.alive = false;
      }
    }
    this._checkElimination();
  }
  _checkElimination() {
    if (!this.def.teams?.length) return;
    const aliveTeams = new Set();
    for (const p of this.players.values()) {
      if (p.alive || (!p.spectating && !p.bedDestroyed)) {
        if (p.team) aliveTeams.add(p.team);
      }
      if (p.alive && p.team) aliveTeams.add(p.team);
    }
    // teams with living players
    const living = new Set();
    for (const p of this.players.values()) if (p.alive && p.team) living.add(p.team);
    if (living.size === 1) {
      const winner = [...living][0];
      this.endRound(winner);
    }
  }
  startRound() {
    this.round += 1;
    this.matchEnded = false;
    this.meta.status = 'playing';
    if (this.def.rules.matchDurationSec > 0) {
      this.setTimer('match', this.def.rules.matchDurationSec);
    }
    runScripts(this, 'onRoundStart', {});
    this.broadcast({ type: 'roundStart', round: this.round });
  }
  endRound(winnerTeam) {
    this.matchEnded = true;
    this.meta.status = 'ended';
    this.winners = winnerTeam ? [winnerTeam] : this.winners;
    runScripts(this, 'onRoundEnd', { winnerTeam });
    runScripts(this, 'onGameEnd', { winnerTeam });
    this.broadcast({ type: 'matchEnd', winnerTeam, winners: this.winners });
  }
  declareWinner(userId, reason) {
    const p = this.players.get(userId);
    if (!p) return;
    this.winners.push(userId);
    p.score += 100;
    this.broadcast({ type: 'playerWin', userId, reason });
    if (this.def.rules.winCondition === 'finish' || this.def.rules.winCondition === 'firstWin') {
      this.endRound(p.team || userId);
    }
  }
  declareLoser(userId) {
    const p = this.players.get(userId);
    if (p) { p.alive = false; p.spectating = true; }
  }
  setTimer(name, seconds) {
    this.timers.set(name, { endsAt: Date.now() + seconds * 1000 });
  }
  teleport(userId, x, y) {
    const p = this.players.get(userId);
    if (!p) return;
    p.x = clamp(x, 8, this.def.world.width - 8);
    p.y = clamp(y, 8, this.def.world.height - 8);
  }
  spawnNpc(action) {
    const id = String(action.id || `e_${Date.now()}`);
    this.entities.set(id, {
      id,
      eid: id,
      name: action.name || 'Entity',
      kind: action.kind || 'enemy',
      x: Number(action.x) || 100,
      y: Number(action.y) || 200,
      health: Number(action.health) || 30,
      maxHealth: Number(action.health) || 30,
      damage: Number(action.damage) || 5,
      speed: Number(action.speed) || 1.2,
      ai: action.ai || 'chase',
      alive: true,
      cooldown: 0,
      dropId: action.dropId || null
    });
  }

  // ---- net helpers ----
  send(userId, msg) {
    const p = this.players.get(userId);
    if (p?.ws?.readyState === 1) {
      try { p.ws.send(JSON.stringify(msg)); } catch (_) {}
    }
  }
  broadcast(msg, exceptId) {
    const raw = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (exceptId && p.id === exceptId) continue;
      if (p.ws?.readyState === 1) {
        try { p.ws.send(raw); } catch (_) {}
      }
    }
  }

  playerView(p) {
    return {
      id: p.id,
      username: p.username,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      vx: Math.round(p.vx * 100) / 100,
      vy: Math.round(p.vy * 100) / 100,
      alive: p.alive,
      health: Math.round(p.health),
      maxHealth: p.maxHealth,
      team: p.team,
      score: p.score,
      level: p.level,
      spectating: !!p.spectating,
      onGround: p.onGround
    };
  }

  snapshot() {
    return [...this.players.values()].map((p) => this.playerView(p));
  }

  entitySnapshot() {
    return [...this.entities.values()].filter((e) => e.alive).map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      x: e.x,
      y: e.y,
      health: e.health,
      maxHealth: e.maxHealth
    }));
  }

  fullState() {
    return {
      players: this.snapshot(),
      entities: this.entitySnapshot(),
      vars: this.vars,
      matchEnded: this.matchEnded,
      winners: this.winners,
      beds: Object.fromEntries([...this.teamBeds].map(([k, v]) => [k, { destroyed: v.destroyed }]))
    };
  }
}

module.exports = { GameRuntime };
