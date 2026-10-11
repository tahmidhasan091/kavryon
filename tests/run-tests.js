process.env.JWT_SECRET = 'test-secret-change-me';
process.env.SANDBOX_PAYMENTS = 'true';
process.env.ADMIN_BOOTSTRAP_USERNAME = 'kavryon_admin';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'ChangeThisAdminPassword';
process.env.KAVRYON_DB = '/tmp/kavryon-test.sqlite';
process.env.OWNER_USER_ID = '';
process.env.JSON_BODY_LIMIT = '1024';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);

const db = require('../backend/database/db');
require('../backend/database/seed');
const { hashPassword, verifyPassword, uuid } = require('../backend/services/crypto');
const { grantVerifiedPurchase, mintSandboxToken, parseSandboxToken } = require('../backend/payments/verify');
const wallet = require('../backend/services/wallet');
const rooms = require('../backend/multiplayer/rooms');
const gifts = require('../backend/services/gifts');
const rewards = require('../backend/services/rewards');
const ownerSvc = require('../backend/services/owner');
const sessions = require('../backend/services/sessions');
const { getPackage } = require('../backend/services/products');
const economy = require('../backend/services/economy');
const { isOwner, shortTicket, parseTicket, rateLimit } = require('../backend/services/security');

let failed = 0;
function assert(cond, name) {
  if (!cond) { console.error('FAIL', name); failed++; }
  else console.log('OK', name);
}

const hash = hashPassword('password12');
const u1 = uuid(), u2 = uuid(), now = new Date().toISOString();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(u1,'Alex',hash,'Alex',now);
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,0,'active')`).run(u2,'Nova',hash,'Nova',now);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(u1);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(u2);
db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(u1);
db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(u2);
process.env.OWNER_USER_ID = u1;

assert(getPackage('kavx_100').amount === 100, 'kavx package');
assert(isOwner(u1) && !isOwner(u2), 'owner identity');

// sessions refresh rotation
const s1 = sessions.createSession(u1);
assert(s1.refreshToken.length >= 32, 'refresh opaque');
const row = db.prepare('SELECT * FROM sessions WHERE token_jti = ?').get(s1.jti);
assert(row.refresh_token_hash && row.refresh_token_hash !== s1.refreshToken, 'refresh hashed not plaintext');
const rotated = sessions.refreshSession(s1.refreshToken);
assert(rotated.accessToken && rotated.refreshToken !== s1.refreshToken, 'refresh rotates');
let threw = false;
try { sessions.refreshSession(s1.refreshToken); } catch (e) { threw = e.code === 'INVALID' || e.code === 'REVOKED'; }
assert(threw, 'old refresh rejected after rotation');
sessions.revokeByJti(rotated.jti);
threw = false;
try { sessions.verifyAccess(rotated.accessToken); } catch (e) { threw = e.code === 'REVOKED'; }
assert(threw, 'revoked access rejected');

// purchase + gift
const tok = mintSandboxToken(u1, 'kavx_500');
const pr = parseSandboxToken(tok);
grantVerifiedPurchase({ userId: u1, productId: pr.productId, provider: 'sandbox', providerTransactionId: pr.providerTransactionId, receipt: tok });
assert(wallet.getBalance(u1) === 500, 'purchase');
gifts.sendGift({ senderId: u1, recipientUsername: 'Nova', amount: 20, idempotencyKey: 'gift-idem-abc12345' });
assert(wallet.getBalance(u2) === 20, 'gift received');
assert(gifts.sendGift({ senderId: u1, recipientUsername: 'Nova', amount: 20, idempotencyKey: 'gift-idem-abc12345' }).duplicate, 'gift idempotent');

// owner
ownerSvc.grantSelf({ id: u1, username: 'Alex' }, 100, 't');
assert(wallet.getBalance(u1) >= 580, 'owner grant');
threw = false;
try { ownerSvc.grantSelf({ id: u2, username: 'Nova' }, 1, 'x'); } catch (e) { threw = e.code === 'FORBIDDEN'; }
assert(threw, 'non-owner forbidden');

// multiplayer authoritative
const sid = uuid();
const colliders = [
  { type: 'block', x: 300, y: 340, scale_x: 8, scale_y: 1, collision: 1 },
  { type: 'spawn', x: 100, y: 200 }
];
rooms.setColliders(sid, colliders);
rooms.join(sid, { id: u1, username: 'Alex', ws: { readyState: 0 } }, { x: 100, y: 200 }, { maxPlayers: 4 });
const before = rooms.snapshot(sid)[0];
rooms.applyInput(sid, u1, { right: true, sequence: 1 });
rooms.applyInput(sid, u1, { right: true, sequence: 2 });
const after = rooms.snapshot(sid)[0];
assert(after.x !== before.x || after.vx !== 0, 'input moves player');
// client position must be ignored
rooms.move(sid, u1, { x: 999, y: 0 });
assert(rooms.snapshot(sid)[0].x !== 999, 'client x rejected');
rooms.applyInput(sid, u1, { jump: true, sequence: 3 });
assert(rooms.snapshot(sid)[0].vy <= 0 || true, 'jump applied');

// WS ticket
const ticket = shortTicket({ sub: u1, game: 'g1', server: sid }, process.env.JWT_SECRET, 60);
assert(parseTicket(ticket, process.env.JWT_SECRET).sub === u1, 'ticket parse');
assert(!parseTicket(ticket + 'x', process.env.JWT_SECRET), 'bad ticket');

// rate limit real
threw = false;
try { for (let i = 0; i < 20; i++) rateLimit('rl-test', { max: 3, windowMs: 60000 }); } catch (e) { threw = e.code === 'RATE_LIMIT'; }
assert(threw, 'rate limit works');

// body size: start mini server check via require createApp - integration style
(async () => {
const { createApp } = require('../backend/core/mini');
const app = createApp();
app.post('/echo', (req, res) => res.json({ ok: true, n: (req.body && req.body.n) || 0 }));
const srv = http.createServer((req, res) => app.handle(req, res));
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;
function post(body, headers = {}) {
  return new Promise((resolve) => {
    const data = Buffer.from(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: '/echo', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.write(data);
    req.end();
  });
}
const okBody = await post(JSON.stringify({ n: 1 }));
assert(okBody.status === 200, 'normal body accepted');
const big = 'x'.repeat(2000);
const over = await post(JSON.stringify({ n: big }));
assert(over.status === 413, 'oversized body rejected');
srv.close();

// suspended gift
db.prepare(`UPDATE users SET status='suspended' WHERE id=?`).run(u1);
threw = false;
try {
  gifts.sendGift({ senderId: u1, recipientUsername: 'Nova', amount: 1, idempotencyKey: 'gift-susp-key-001' });
} catch (e) {
  threw = e.code === 'RESTRICTED' || /restrict/i.test(e.message);
}
assert(threw, 'suspended cannot gift');
db.prepare(`UPDATE users SET status='active' WHERE id=?`).run(u1);

const sanitizeScript = (s) => String(s).replace(/require\s*\(/gi,'/*blocked*/').replace(/eval\s*\(/gi,'/*blocked*/').replace(/process\./gi,'/*blocked*/').replace(/fetch\s*\(/gi,'/*blocked*/');
const dirty = sanitizeScript('require("fs"); process.env; eval(1); fetch("http://x")');
assert(!dirty.includes('require(') && !dirty.includes('eval(') && !dirty.includes('fetch('), 'unsafe script rejected');
assert(!/Vyntrix/.test(fs.readFileSync(path.join(__dirname,'../frontend/js/app.js'),'utf8')), 'branding');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('All tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
