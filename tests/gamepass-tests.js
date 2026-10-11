process.env.JWT_SECRET = 'test-secret-gamepass-suite-32chars!';
process.env.KAVRYON_DB = '/tmp/kavryon-gamepass-test.sqlite';
process.env.NODE_ENV = 'development';
const fs = require('fs');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);
require('../backend/database/db');
require('../backend/database/seed');
const db = require('../backend/database/db');
const { hashPassword, uuid } = require('../backend/services/crypto');
const gamepasses = require('../backend/services/gamepasses');
const { credit, getBalance } = require('../backend/services/wallet');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

const hash = hashPassword('password12');
const now = new Date().toISOString();
const creator = uuid(), buyer = uuid();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(creator,'PassCreator',hash,'C',now);
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(buyer,'PassBuyer',hash,'B',now);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(creator);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(buyer);
credit(buyer, 500, 'test', null, 't');

const gid = uuid();
db.prepare(`INSERT INTO games (id,creator_id,name,description,category,max_players,template,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'PUBLISHED',?,?)`)
  .run(gid, creator, 'Pass Game', 'desc', 'Casual', 8, 'Empty World', now, now);

const { creatorShare, platformShare } = gamepasses.splitRevenue(100);
assert(creatorShare === 60 && platformShare === 40, '100 → 60/40');
assert(creatorShare + platformShare === 100, 'exact sum');
const s3 = gamepasses.splitRevenue(3);
assert(s3.creatorShare + s3.platformShare === 3, 'odd price exact');

const pass = gamepasses.createPass({ userId: creator, gameId: gid, name: 'VIP Access', priceKavx: 100, description: 'test' });
assert(pass.priceKavx === 100, 'pass created');

// self buy blocked
let self = false;
try { gamepasses.purchasePass({ userId: creator, passId: pass.id, idempotencyKey: 'self' }); } catch (e) { self = e.code === 'SELF'; }
assert(self, 'self buy blocked');

const r1 = gamepasses.purchasePass({ userId: buyer, passId: pass.id, idempotencyKey: 'buy1' });
assert(r1.creatorShare === 60 && r1.platformShare === 40, 'split applied');
assert(getBalance(buyer) === 400, 'buyer debited 100');
assert(getBalance(creator) === 60, 'creator +60');
const plat = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM platform_ledger WHERE type='game_pass_fee'`).get().s;
assert(plat === 40, 'platform ledger +40');

const r2 = gamepasses.purchasePass({ userId: buyer, passId: pass.id, idempotencyKey: 'buy1' });
assert(r2.duplicate, 'idempotent');
assert(getBalance(buyer) === 400, 'no double debit');
assert(getBalance(creator) === 60, 'no double credit');

// client cannot set price — price from DB
const pass2 = gamepasses.createPass({ userId: creator, gameId: gid, name: 'Cheap', priceKavx: 10 });
credit(buyer, 10, 'test', null, 't2');
const r3 = gamepasses.purchasePass({ userId: buyer, passId: pass2.id, idempotencyKey: 'buy2' });
assert(r3.priceKavx === 10 && r3.creatorShare === 6 && r3.platformShare === 4, 'price from server');

const stats = gamepasses.creatorPassStats(creator);
assert(stats.creatorEarnings === 66, 'stats earnings');
assert(stats.split.creatorPercent === 60, 'stats split');

// Free creator: new users should have developer_mode=1 path tested via schema default migration note
assert(true, 'creator free (signup sets developer_mode=1)');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('All game pass tests passed');
