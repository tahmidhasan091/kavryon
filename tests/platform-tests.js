process.env.JWT_SECRET = 'test-secret-platform-suite-32chars!';
process.env.CREDENTIALS_ENCRYPTION_KEY = 'test-credentials-encryption-key-32b';
process.env.KAVRYON_DB = '/tmp/kavryon-platform-test.sqlite';
process.env.NODE_ENV = 'development';
const fs = require('fs');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);
require('../backend/database/db');
require('../backend/database/seed');
const db = require('../backend/database/db');
const { hashPassword, uuid } = require('../backend/services/crypto');
const platform = require('../backend/services/platform');
const { credit, getBalance } = require('../backend/services/wallet');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

const hash = hashPassword('password12');
const now = new Date().toISOString();
const a = uuid(), b = uuid();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(a,'Seller',hash,'Seller',now);
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,0,'active')`).run(b,'Buyer',hash,'Buyer',now);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(a);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(b);
credit(b, 500, 'test_grant', null, 'test');

const free = platform.publishAsset({ userId: a, type: 'item', name: 'Prism Shard', description: 'test', priceKavx: 0, dataJson: { power: 1 } });
assert(free.moderation === 'approved', 'free asset auto-approved');
const paid = platform.publishAsset({ userId: a, type: 'weapon', name: 'Facet Blade', priceKavx: 100, dataJson: {} });
assert(paid.moderation === 'pending', 'paid pending moderation');
// approve paid for test
db.prepare(`UPDATE assets SET moderation='approved' WHERE id=?`).run(paid.id);

const list = platform.listMarketplace({});
assert(list.some(x => x.id === free.id), 'marketplace lists free');

const buy0 = platform.buyAsset({ userId: b, assetId: free.id });
assert(buy0.owned, 'free get');
const buy1 = platform.buyAsset({ userId: b, assetId: paid.id });
assert(buy1.price === 100, 'paid purchase');
assert(getBalance(b) === 400, 'buyer debited');
assert(getBalance(a) === 70, 'seller 70%');

let dup = false;
const buy2 = platform.buyAsset({ userId: b, assetId: paid.id });
assert(buy2.duplicate || buy2.owned, 'idempotent repurchase');

const av = platform.updateAvatar({ userId: b, body: 'tall', hair: 'long', outfit: 'explorer' });
assert(av.body === 'tall' && av.hair === 'long', 'avatar update');

// cloud save needs published game
const gid = uuid();
db.prepare(`INSERT INTO games (id,creator_id,name,description,category,max_players,template,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'PUBLISHED',?,?)`)
  .run(gid, a, 'SaveTest', 'd', 'Casual', 8, 'Empty World', now, now);
const save = platform.cloudSave({ userId: b, gameId: gid, slot: 0, data: { level: 3, inv: ['sword'] } });
assert(save.id, 'cloud save');
const load = platform.cloudLoad({ userId: b, gameId: gid, slot: 0 });
assert(load.data && load.data.level === 3, 'cloud load');

const ps = platform.createPrivateServer({ userId: a, gameId: gid, name: 'VIP', maxPlayers: 4, accessCode: 'secret' });
assert(ps.id, 'private server');
let bad = false;
try { platform.joinPrivateServer({ userId: b, serverId: ps.id, accessCode: 'wrong' }); } catch (e) { bad = e.code === 'FORBIDDEN'; }
assert(bad, 'bad code rejected');
const join = platform.joinPrivateServer({ userId: b, serverId: ps.id, accessCode: 'secret' });
assert(join.ok, 'join private');

platform.follow({ followerId: b, followingUsername: 'Seller' });
let self = false;
try { platform.follow({ followerId: b, followingUsername: 'Buyer' }); } catch (e) { self = e.code === 'SELF'; }
assert(self, 'no self follow');

const gr = platform.createGroup({ userId: a, name: 'Facet Guild', description: 'creators' });
assert(gr.id, 'group created');
assert(platform.listGroups(a).length >= 1, 'list groups');

const an = platform.creatorAnalytics(a);
assert(an.games >= 1, 'analytics');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('All platform tests passed');
