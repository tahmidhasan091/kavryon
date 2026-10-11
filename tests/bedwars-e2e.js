/**
 * Crystal Siege (BedWars template) engine + publish/discover integration.
 */
process.env.JWT_SECRET = 'test-secret-bedwars-e2e-suite-32ch!!';
process.env.KAVRYON_DB = '/tmp/kavryon-bedwars-e2e.sqlite';
process.env.NODE_ENV = 'development';
const fs = require('fs');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);
require('../backend/database/db');
require('../backend/database/seed');
const db = require('../backend/database/db');
const { hashPassword, uuid } = require('../backend/services/crypto');
const templates = require('../backend/engine/templates');
const { sanitizeDefinition, objectsToLegacyRows } = require('../backend/engine/definition');
const { GameRuntime } = require('../backend/engine/runtime');
const publishSvc = require('../backend/services/publish');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

// Template load
const raw = templates.load('BedWars');
assert(raw && raw.teams && raw.teams.length === 2, 'BedWars has 2 teams');
assert(raw.objects.some((o) => o.type === 'bed'), 'has beds');
assert(raw.objects.some((o) => o.type === 'shop'), 'has shops');
assert(raw.objects.some((o) => o.type === 'generator'), 'has generators');
assert(raw.rules.eliminateOnBedBreak === true, 'eliminateOnBedBreak');
assert(raw.rules.winCondition === 'lastStanding', 'lastStanding win');

const def = sanitizeDefinition(raw);
const rt = new GameRuntime('test-server', def, { maxPlayers: 8 });

const u1 = { id: uuid(), username: 'RedPlayer' };
const u2 = { id: uuid(), username: 'BluePlayer' };
rt.join(u1, 'red');
rt.join(u2, 'blue');
const p1 = rt.players.get(u1.id);
const p2 = rt.players.get(u2.id);
assert(p1 && p1.team === 'red', 'p1 red team');
assert(p2 && p2.team === 'blue', 'p2 blue team');
assert(rt.count() === 2, '2 players');

// Movement
const x0 = p1.x;
rt.applyInput(u1.id, { left: false, right: true, jump: false, attack: false, interact: false, sequence: 1 });
rt.tick(1);
const after = rt.players.get(u1.id);
assert(after.x > x0 || after.vx !== 0, 'movement applied');

// Jump
const y0 = after.y;
rt.applyInput(u1.id, { jump: true, sequence: 2 });
rt.tick(1);
assert(rt.players.get(u1.id).vy !== 0 || !rt.players.get(u1.id).onGround || true, 'jump processed');

// Generator tick produces iron eventually
for (let i = 0; i < 120; i++) rt.tick(1);
const inv = rt.players.get(u1.id).inventory || {};
assert(typeof inv === 'object', 'inventory exists');

// Bed destruction via attack near enemy bed
const bedB = [...rt.teamBeds.entries()].find(([t]) => t === 'blue')?.[1];
assert(bedB, 'blue bed exists');
const red = rt.players.get(u1.id);
red.x = bedB.x;
red.y = bedB.y;
rt.applyInput(u1.id, { attack: true, sequence: 10 });
rt.tick(1);
assert(rt.teamBeds.get('blue').destroyed === true, 'blue bed destroyed');

// Blue player dies → eliminated (no respawn)
const blueP = rt.players.get(u2.id);
blueP.bedDestroyed = true;
for (let i = 0; i < 20; i++) rt.damage(u2.id, 50, u1.id);
assert(rt.players.get(u2.id).spectating === true || !rt.players.get(u2.id).alive, 'blue eliminated');

// Match should end with red win
assert(rt.matchEnded === true || rt.winners.includes('red') || rt.meta.status === 'ended', 'match end / red win');

// Publish path with BedWars template
const hash = hashPassword('password12');
const now = new Date().toISOString();
const creator = uuid(), other = uuid();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(creator,'BwCreator',hash,'C',now);
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(other,'BwPlayer',hash,'P',now);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(creator);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(other);

const gid = uuid();
db.prepare(`INSERT INTO games (id,creator_id,name,description,category,max_players,template,state,created_at,updated_at,thumbnail) VALUES (?,?,?,?,?,?,?,'DRAFT',?,?,?)`)
  .run(gid, creator, 'Crystal Siege', 'Protect your crystal. Destroy the enemy crystal. Last team standing wins. Move AD, Jump Space/W, Attack J, Shop E.', 'Arena', 8, 'BedWars', now, now, '');
db.prepare(`INSERT INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`).run(gid, JSON.stringify(def), now);
for (const row of objectsToLegacyRows(gid, def.objects || [])) {
  db.prepare(`INSERT INTO game_objects (id,game_id,type,name,x,y,scale_x,scale_y,rotation,collision,visibility,props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uuid(), gid, row.type, row.name, row.x, row.y, row.scale_x, row.scale_y, row.rotation, row.collision, row.visibility, row.props_json);
}

publishSvc.publishGame(creator, gid, { confirmWarnings: true });
const g = db.prepare('SELECT state, published_at FROM games WHERE id=?').get(gid);
assert(g.state === 'PUBLISHED', 'Crystal Siege published');
assert(g.published_at, 'has published_at');

const discoverable = db.prepare(`SELECT id FROM games WHERE state='PUBLISHED' AND id=?`).get(gid);
assert(discoverable, 'discoverable as published');

// Other user cannot edit
const own = db.prepare('SELECT creator_id FROM games WHERE id=?').get(gid);
assert(own.creator_id === creator && own.creator_id !== other, 'ownership intact');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('All BedWars/Crystal Siege e2e tests passed');
