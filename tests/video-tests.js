/**
 * Gameplay video clips — upload, visibility, ownership, discovery.
 */
process.env.JWT_SECRET = 'test-secret-video-suite-32chars!!xx';
process.env.KAVRYON_DB = '/tmp/kavryon-video-tests.sqlite';
process.env.KAVRYON_VIDEO_ROOT = '/tmp/kavryon-video-storage';
process.env.NODE_ENV = 'development';

const fs = require('fs');
const path = require('path');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);
try { fs.rmSync(process.env.KAVRYON_VIDEO_ROOT, { recursive: true, force: true }); } catch (_) {}

require('../backend/database/db');
require('../backend/database/migrate').migrate();
require('../backend/database/seed');

const videos = require('../backend/services/videos');
const { hashPassword, uuid } = require('../backend/services/crypto');
const db = require('../backend/database/db');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

// Minimal MP4-like buffer with ftyp
function fakeMp4(size = 128) {
  const b = Buffer.alloc(size, 0);
  b.writeUInt32BE(size, 0);
  b.write('ftyp', 4);
  b.write('isom', 8);
  return b;
}
function fakeJunk() {
  return Buffer.alloc(64, 0x41); // 64 bytes of 'A' — no video magic
}

const now = new Date().toISOString();
const hash = hashPassword('password12');
const owner = uuid();
const other = uuid();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`)
  .run(owner, 'clip_owner', hash, 'Owner', now);
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`)
  .run(other, 'clip_other', hash, 'Other', now);
db.prepare('INSERT INTO profiles (user_id, videos_enabled) VALUES (?,1)').run(owner);
db.prepare('INSERT INTO profiles (user_id, videos_enabled) VALUES (?,1)').run(other);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(owner);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(other);

// 1. Valid upload
const pub = videos.createFromUpload({
  ownerId: owner,
  title: 'My Siege Clip',
  description: 'Final round',
  visibility: 'public',
  buffer: fakeMp4(256),
  declaredMime: 'video/mp4'
});
assert(pub && pub.id, 'upload public returns id');
assert(pub.visibility === 'public', 'public visibility');
assert(fs.existsSync(path.join(videos.VIDEO_DIR, videos.getVideo(pub.id).storage_key)), 'file on disk');

// 2. Reject bad format
let rejected = false;
try {
  videos.createFromUpload({ ownerId: owner, title: 'x', buffer: fakeJunk() });
} catch (e) {
  rejected = e.code === 'BAD_FORMAT';
}
assert(rejected, 'reject unsupported format');

// 3. Reject oversized
rejected = false;
try {
  const big = fakeMp4(videos.MAX_BYTES + 100);
  videos.createFromUpload({ ownerId: owner, title: 'big', buffer: big });
} catch (e) {
  rejected = e.code === 'TOO_LARGE';
}
assert(rejected, 'reject oversized');

// 4. Private not in public list
const priv = videos.createFromUpload({
  ownerId: owner,
  title: 'Secret',
  visibility: 'private',
  buffer: fakeMp4(200)
});
const unlisted = videos.createFromUpload({
  ownerId: owner,
  title: 'Link only',
  visibility: 'unlisted',
  buffer: fakeMp4(200)
});
const pubList = videos.listPublic({});
assert(pubList.some((v) => v.id === pub.id), 'public in discovery');
assert(!pubList.some((v) => v.id === priv.id), 'private not in discovery');
assert(!pubList.some((v) => v.id === unlisted.id), 'unlisted not in discovery');

// 5. canView rules
assert(videos.canView(videos.getVideo(priv.id), owner, false) === true, 'owner sees private');
assert(videos.canView(videos.getVideo(priv.id), other, false) === false, 'other cannot see private');
assert(videos.canView(videos.getVideo(unlisted.id), other, false) === true, 'other can open unlisted by id');
assert(videos.canView(videos.getVideo(pub.id), other, false) === true, 'other sees public');

// 6. Disable profile videos section
videos.setProfileVideoSettings(owner, { videosEnabled: false });
assert(videos.canView(videos.getVideo(pub.id), other, false) === false, 'public hidden when section disabled');
const profile = videos.listProfilePublic('clip_owner');
assert(profile.enabled === false, 'profile gallery disabled');
videos.setProfileVideoSettings(owner, { videosEnabled: true });
assert(videos.canView(videos.getVideo(pub.id), other, false) === true, 're-enabled');

// 7. Ownership — other cannot delete
let forbid = false;
try { videos.softDelete(other, pub.id, false); } catch (e) { forbid = e.code === 'FORBIDDEN'; }
assert(forbid, 'cannot delete others clip');

// 8. Owner delete cleans file
const key = videos.getVideo(priv.id).storage_key;
videos.softDelete(owner, priv.id, false);
assert(videos.getVideo(priv.id).status === 'deleted', 'soft deleted');
assert(!fs.existsSync(path.join(videos.VIDEO_DIR, key)), 'file removed');

// 9. Other cannot update
forbid = false;
try { videos.updateMeta(other, pub.id, { title: 'Hacked' }, false); } catch (e) { forbid = e.code === 'FORBIDDEN'; }
assert(forbid, 'cannot edit others clip');

// 10. Magic detection
assert(videos.detectVideoMagic(fakeMp4()).mime === 'video/mp4', 'mp4 magic');
assert(videos.detectVideoMagic(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])).mime === 'video/webm', 'webm magic');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('All video tests passed');
