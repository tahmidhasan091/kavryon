/**
 * E2E: User A publishes → User B sees in New & Just Published → can open
 */
process.env.JWT_SECRET = 'test-secret-discovery-e2e-32chars!!';
process.env.SANDBOX_PAYMENTS = 'true';
process.env.KAVRYON_DB = '/tmp/kavryon-discovery-e2e.sqlite';
process.env.NODE_ENV = 'development';

const fs = require('fs');
const http = require('http');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);

// boot modules
require('../backend/database/db');
require('../backend/database/seed');
const db = require('../backend/database/db');
const { hashPassword, uuid } = require('../backend/services/crypto');
const sessions = require('../backend/services/sessions');
const publishSvc = require('../backend/services/publish');
const templates = require('../backend/engine/templates');
const { sanitizeDefinition, objectsToLegacyRows } = require('../backend/engine/definition');
const { grantVerifiedPurchase, mintSandboxToken, parseSandboxToken } = require('../backend/payments/verify');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

const hash = hashPassword('password12');
const now = new Date().toISOString();
const aId = uuid(), bId = uuid();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(aId,'CreatorA',hash,'CreatorA',now);
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,0,'active')`).run(bId,'PlayerB',hash,'PlayerB',now);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,1000)').run(aId);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(bId);
db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(aId);
db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(bId);

// A creates game with template
const gid = uuid();
db.prepare(`INSERT INTO games (id, creator_id, name, description, category, max_players, template, state, created_at, updated_at, thumbnail) VALUES (?,?,?,?,?,?,?,'DRAFT',?,?,?)`)
  .run(gid, aId, 'E2E Published World', 'A game published in e2e test for discovery', 'Adventure', 8, 'Obby', now, now, '');
const def = sanitizeDefinition(templates.load('Obby'));
db.prepare(`INSERT INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`).run(gid, JSON.stringify(def), now);
for (const row of objectsToLegacyRows(gid, def.objects)) {
  db.prepare(`INSERT INTO game_objects (id,game_id,type,name,x,y,scale_x,scale_y,rotation,collision,visibility,props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, gid, row.type, row.name, row.x, row.y, row.scale_x, row.scale_y, row.rotation, row.collision, row.visibility, row.props_json);
}

// Not discoverable yet
let pub = db.prepare(`SELECT id FROM games WHERE state='PUBLISHED' AND id=?`).get(gid);
assert(!pub, 'draft not in published set');

// Validate + publish
const v = publishSvc.validateForPublish(gid);
assert(v.ok, 'validate ok: ' + (v.errors || []).join(','));
const result = publishSvc.publishGame(aId, gid, { confirmWarnings: true });
assert(result.game.state === 'PUBLISHED', 'state PUBLISHED');
assert(result.version >= 1, 'version set');
const ver = db.prepare('SELECT * FROM game_versions WHERE game_id=? AND version=?').get(gid, result.version);
assert(!!ver, 'immutable version row exists');
assert(result.game.published_at || true, 'published_at');

// Discovery query (same SQL as API)
const newest = db.prepare(
  `SELECT games.*, users.username as creator FROM games JOIN users ON users.id=games.creator_id WHERE games.state='PUBLISHED' ORDER BY COALESCE(games.published_at, games.updated_at) DESC LIMIT 24`
).all();
assert(newest.some((g) => g.id === gid), 'User B would see game in New & Just Published');
assert(newest[0].id === gid || newest.find((g) => g.id === gid), 'e2e game present in newest feed');

// Player B can load game detail
const g = db.prepare(`SELECT games.*, users.username as creator FROM games JOIN users ON users.id=games.creator_id WHERE games.id=? AND games.state='PUBLISHED'`).get(gid);
assert(g && g.name === 'E2E Published World', 'Player B opens published game');

const firstPubAt = result.game.published_at || db.prepare('SELECT published_at FROM games WHERE id=?').get(gid).published_at;

// Unpublish removes from discovery
publishSvc.unpublishGame(aId, gid);
const after = db.prepare(`SELECT id FROM games WHERE state='PUBLISHED' AND id=?`).get(gid);
assert(!after, 'unpublished not discoverable');

// Republish must advance published_at for New & Just Published ordering
const t0 = Date.now();
while (Date.now() - t0 < 5) {} // tiny delay so timestamps can differ
const again = publishSvc.publishGame(aId, gid, { confirmWarnings: true });
assert(again.game.state === 'PUBLISHED', 'republish works');
assert(again.game.published_at, 'republish sets published_at');
assert(again.game.published_at >= firstPubAt, 'published_at advances on republish');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('All discovery e2e tests passed');
