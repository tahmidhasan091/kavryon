process.env.JWT_SECRET = 'test-secret-invite-suite-32chars!!';
process.env.KAVRYON_DB = '/tmp/kavryon-invite-test.sqlite';
process.env.SANDBOX_PAYMENTS = 'true';
process.env.NODE_ENV = 'development';
const fs = require('fs');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);
require('../backend/database/db');
require('../backend/database/seed');
const db = require('../backend/database/db');
const { hashPassword, uuid } = require('../backend/services/crypto');
const invites = require('../backend/services/invites');
const publishSvc = require('../backend/services/publish');
const templates = require('../backend/engine/templates');
const { sanitizeDefinition, objectsToLegacyRows } = require('../backend/engine/definition');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

const hash = hashPassword('password12');
const now = new Date().toISOString();
const a = uuid(), b = uuid();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(a,'Host',hash,'Host',now);
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,0,'active')`).run(b,'Guest',hash,'Guest',now);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(a);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(b);
db.prepare('INSERT INTO friends (user_id, friend_id, created_at) VALUES (?,?,?)').run(a,b,now);
db.prepare('INSERT INTO friends (user_id, friend_id, created_at) VALUES (?,?,?)').run(b,a,now);

const gid = uuid();
db.prepare(`INSERT INTO games (id, creator_id, name, description, category, max_players, template, state, created_at, updated_at, thumbnail) VALUES (?,?,?,?,?,?,?,'DRAFT',?,?,?)`)
  .run(gid, a, 'Invite Arena', 'test game for invites system', 'Arena', 8, 'Arena', now, now, '');
const def = sanitizeDefinition(templates.load('Arena'));
db.prepare(`INSERT INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`).run(gid, JSON.stringify(def), now);
for (const row of objectsToLegacyRows(gid, def.objects)) {
  db.prepare(`INSERT INTO game_objects (id,game_id,type,name,x,y,scale_x,scale_y,rotation,collision,visibility,props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, gid, row.type, row.name, row.x, row.y, row.scale_x, row.scale_y, row.rotation, row.collision, row.visibility, row.props_json);
}
publishSvc.publishGame(a, gid, { confirmWarnings: true });
const srv = db.prepare('SELECT id FROM game_servers WHERE game_id=? AND is_test=0').get(gid);


// non-friend rejected
const c = uuid();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,0,'active')`).run(c,'Stranger',hash,'Stranger',now);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(c);
let nf = false;
try { invites.sendInvite({ senderId: a, receiverUsername: 'Stranger', gameId: gid, serverId: srv.id }); } catch (e) { nf = e.code === 'NOT_FRIENDS'; }
assert(nf, 'non-friend invite rejected');

// self invite rejected
let threw = false;
try { invites.sendInvite({ senderId: a, receiverUsername: 'Host', gameId: gid, serverId: srv.id }); } catch (e) { threw = e.code === 'SELF'; }
assert(threw, 'self invite rejected');

const inv = invites.sendInvite({ senderId: a, receiverUsername: 'Guest', gameId: gid, serverId: srv.id });
assert(inv.id, 'invite created');
const notif = db.prepare(`SELECT * FROM notifications WHERE user_id=? AND type='GAME_INVITE' ORDER BY created_at DESC`).get(b);
assert(notif, 'notification created');
const data = JSON.parse(notif.data_json);
assert(data.inviteId === inv.id, 'notif has inviteId');

const dup = invites.sendInvite({ senderId: a, receiverUsername: 'Guest', gameId: gid, serverId: srv.id });
assert(dup.duplicate, 'duplicate pending invite');

// wrong user cannot accept
threw = false;
try { invites.respondInvite({ userId: a, inviteId: inv.id, action: 'accept' }); } catch (e) { threw = e.code === 'FORBIDDEN'; }
assert(threw, 'sender cannot accept own invite as receiver');

const acc = invites.respondInvite({ userId: b, inviteId: inv.id, action: 'accept' });
assert(acc.status === 'ACCEPTED' && acc.gameId === gid && acc.serverId, 'accept returns game+server');

// used invite
threw = false;
try { invites.respondInvite({ userId: b, inviteId: inv.id, action: 'accept' }); } catch (e) { threw = e.code === 'USED'; }
assert(threw, 'replay invite rejected');

// decline path
const inv2 = invites.sendInvite({ senderId: a, receiverUsername: 'Guest', gameId: gid, serverId: srv.id });
const dec = invites.respondInvite({ userId: b, inviteId: inv2.id, action: 'decline' });
assert(dec.status === 'DECLINED', 'decline works');

const list = invites.listFriendsForInvite(a);
assert(list.some((f) => f.username === 'Guest'), 'friends for invite list');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('All invite tests passed');
