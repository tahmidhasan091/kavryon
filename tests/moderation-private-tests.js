process.env.JWT_SECRET = 'test-secret-mod-private-suite-32ch!';
process.env.KAVRYON_DB = '/tmp/kavryon-mod-private-test.sqlite';
process.env.NODE_ENV = 'development';
const fs = require('fs');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);
require('../backend/database/db');
require('../backend/database/seed');
const db = require('../backend/database/db');
const { hashPassword, uuid } = require('../backend/services/crypto');
const publishSvc = require('../backend/services/publish');
const platform = require('../backend/services/platform');
const templates = require('../backend/engine/templates');
const { sanitizeDefinition, objectsToLegacyRows } = require('../backend/engine/definition');
const { credit, getBalance } = require('../backend/services/wallet');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

const hash = hashPassword('password12');
const now = new Date().toISOString();
const creator = uuid(), other = uuid(), admin = uuid();
for (const [id, name, dev] of [[creator,'ModCreator',1],[other,'ModOther',0],[admin,'ModAdmin',1]]) {
  db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status,role) VALUES (?,?,?,?,?,?, 'active',?)`)
    .run(id, name, hash, name, now, dev, id===admin?'admin':'player');
  db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(id);
}

function makeGame(owner, name) {
  const gid = uuid();
  db.prepare(`INSERT INTO games (id,creator_id,name,description,category,max_players,template,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'DRAFT',?,?)`)
    .run(gid, owner, name, 'test description long enough', 'Arena', 8, 'Arena', now, now);
  const def = sanitizeDefinition(templates.load('Arena') || templates.load('Empty World') || {});
  db.prepare(`INSERT INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`).run(gid, JSON.stringify(def), now);
  for (const row of objectsToLegacyRows(gid, def.objects || [])) {
    db.prepare(`INSERT INTO game_objects (id,game_id,type,name,x,y,scale_x,scale_y,rotation,collision,visibility,props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, gid, row.type, row.name, row.x, row.y, row.scale_x, row.scale_y, row.rotation, row.collision, row.visibility, row.props_json);
  }
  return gid;
}

const gid = makeGame(creator, 'ModTestGame');
publishSvc.publishGame(creator, gid, { confirmWarnings: true });
assert(db.prepare('SELECT state FROM games WHERE id=?').get(gid).state === 'PUBLISHED', 'published');

// Admin suspend
publishSvc.suspendGame(admin, gid, 'policy');
assert(db.prepare('SELECT state FROM games WHERE id=?').get(gid).state === 'SUSPENDED', 'suspended');

// Creator cannot republish
let blocked = false;
try { publishSvc.publishGame(creator, gid, { confirmWarnings: true }); } catch (e) { blocked = e.code === 'MODERATION_LOCK'; }
assert(blocked, 'suspended cannot publish');

// Creator cannot unpublish moderated
blocked = false;
try { publishSvc.unpublishGame(creator, gid); } catch (e) { blocked = e.code === 'MODERATION_LOCK'; }
assert(blocked, 'suspended cannot unpublish');

// Admin unsuspend -> DRAFT
publishSvc.unsuspendGame(admin, gid);
assert(db.prepare('SELECT state FROM games WHERE id=?').get(gid).state === 'DRAFT', 'unsuspend to draft');

// Can publish again after unsuspend
publishSvc.publishGame(creator, gid, { confirmWarnings: true });
assert(db.prepare('SELECT state FROM games WHERE id=?').get(gid).state === 'PUBLISHED', 'republish after unsuspend');

// Private server
const ps = platform.createPrivateServer({ userId: creator, gameId: gid, name: 'VIP', maxPlayers: 4, accessCode: 'code1' });
assert(ps.id, 'private server created');
assert(db.prepare('SELECT id FROM game_servers WHERE id=?').get(ps.id), 'linked game_server row');

// Non-member without code
let forbid = false;
try { platform.assertPrivateServerAccess(other, ps.id, null); } catch (e) { forbid = e.code === 'FORBIDDEN'; }
assert(forbid, 'non-member blocked');

// Wrong code
forbid = false;
try { platform.assertPrivateServerAccess(other, ps.id, 'wrong'); } catch (e) { forbid = e.code === 'FORBIDDEN'; }
assert(forbid, 'wrong code blocked');

// Valid code
const acc = platform.assertPrivateServerAccess(other, ps.id, 'code1');
assert(acc.role === 'member' || acc.role === 'owner', 'code grants access');

// Invalid server
let nf = false;
try { platform.assertPrivateServerAccess(other, 'no-such-server', 'x'); } catch (e) { nf = e.code === 'NOT_FOUND'; }
assert(nf, 'invalid server');

// Close
platform.closePrivateServer({ userId: creator, serverId: ps.id });
let closed = false;
try { platform.assertPrivateServerAccess(other, ps.id, 'code1'); } catch (e) { closed = e.code === 'CLOSED'; }
assert(closed, 'closed server blocked');

// Atomic marketplace
credit(other, 200, 'test', null, 't');
const asset = platform.publishAsset({ userId: creator, type: 'item', name: 'Atomic Item', priceKavx: 50, dataJson: {} });
db.prepare(`UPDATE assets SET moderation='approved' WHERE id=?`).run(asset.id);
const key = 'idem_test_' + asset.id;
const b1 = platform.buyAsset({ userId: other, assetId: asset.id, idempotencyKey: key });
assert(b1.price === 50, 'purchase');
const bal1 = getBalance(other);
const b2 = platform.buyAsset({ userId: other, assetId: asset.id, idempotencyKey: key });
assert(b2.duplicate || b2.price === 0, 'idempotent');
assert(getBalance(other) === bal1, 'no double debit');

// Rollback test
const versions = db.prepare('SELECT version FROM game_versions WHERE game_id=? ORDER BY version').all(gid);
assert(versions.length >= 1, 'has versions');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('All moderation/private/economy tests passed');
