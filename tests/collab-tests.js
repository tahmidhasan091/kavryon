process.env.JWT_SECRET = 'test-secret-collab-suite-32chars!!!!';
process.env.KAVRYON_DB = '/tmp/kavryon-collab-tests.sqlite';
process.env.NODE_ENV = 'development';
const fs = require('fs');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);
require('../backend/database/db');
require('../backend/database/migrate').migrate();
const collab = require('../backend/services/collab');
const { hashPassword, uuid } = require('../backend/services/crypto');
const db = require('../backend/database/db');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

const now = new Date().toISOString();
const h = hashPassword('password12');
const owner = uuid(), editor = uuid(), stranger = uuid();
for (const [id, name] of [[owner, 'owner_user'], [editor, 'editor_user'], [stranger, 'stranger_x']]) {
  db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`)
    .run(id, name, h, name, now);
}
const gid = uuid();
db.prepare(`INSERT INTO games (id,creator_id,name,description,category,max_players,template,state,created_at,updated_at) VALUES (?,?,?,?,?,8,'Empty World','DRAFT',?,?)`)
  .run(gid, owner, 'Collab Project', 'test', 'Casual', now, now);
collab.ensureOwnerRow(gid, owner);

assert(collab.getRole(gid, owner) === 'owner', 'owner role');
assert(collab.canEdit(gid, owner) === true, 'owner can edit');
assert(collab.canPublish(gid, owner) === true, 'owner can publish');
assert(collab.canEdit(gid, stranger) === false, 'stranger cannot edit');
assert(collab.canView(gid, stranger) === false, 'stranger cannot view draft');

const inv = collab.invite({ gameId: gid, inviterId: owner, inviteeUsername: 'editor_user', role: 'editor' });
assert(inv.inviteId, 'invite created');
let deny = false;
try { collab.invite({ gameId: gid, inviterId: stranger, inviteeUsername: 'editor_user', role: 'editor' }); }
catch (e) { deny = e.code === 'FORBIDDEN'; }
assert(deny, 'non-owner cannot invite');

const incoming = collab.listIncomingInvites(editor);
assert(incoming.some((i) => i.id === inv.inviteId), 'incoming invite');

const acc = collab.respondInvite({ inviteId: inv.inviteId, userId: editor, accept: true });
assert(acc.status === 'accepted', 'accepted');
assert(collab.getRole(gid, editor) === 'editor', 'editor role after accept');
assert(collab.canEdit(gid, editor) === true, 'editor can edit');
assert(collab.canPublish(gid, editor) === false, 'editor cannot publish');

deny = false;
try { collab.setRole({ gameId: gid, ownerId: editor, targetUserId: editor, role: 'viewer' }); }
catch (e) { deny = e.code === 'FORBIDDEN'; }
assert(deny, 'editor cannot change roles');

collab.setRole({ gameId: gid, ownerId: owner, targetUserId: editor, role: 'viewer' });
assert(collab.getRole(gid, editor) === 'viewer', 'demoted to viewer');
assert(collab.canEdit(gid, editor) === false, 'viewer cannot edit');

collab.setRole({ gameId: gid, ownerId: owner, targetUserId: editor, role: 'editor' });
const r1 = collab.bumpRevision(gid, editor, 1);
assert(r1.revision === 2, 'revision bump');
let conflict = false;
try { collab.bumpRevision(gid, editor, 1); }
catch (e) { conflict = e.code === 'CONFLICT'; }
assert(conflict, 'stale revision conflict');

collab.removeMember({ gameId: gid, actorId: owner, targetUserId: editor });
assert(collab.getRole(gid, editor) === null, 'removed');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('All collab tests passed');
