process.env.JWT_SECRET = 'test-secret-security-hardening-32ch';
process.env.KAVRYON_DB = '/tmp/kavryon-sec-hard-test.sqlite';
process.env.NODE_ENV = 'development';
const fs = require('fs');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);
require('../backend/database/db');
require('../backend/database/seed');
const db = require('../backend/database/db');
const { hashPassword, uuid } = require('../backend/services/crypto');
const platform = require('../backend/services/platform');
const ai = require('../backend/services/ai_providers');
const security = require('../backend/services/security');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}


const oldTrustProxy = process.env.TRUST_PROXY;
delete process.env.TRUST_PROXY;
const reqIp = { headers: { 'x-forwarded-for': '203.0.113.99' }, socket: { remoteAddress: '198.51.100.7' } };
assert(security.clientIp(reqIp) === '198.51.100.7', 'spoofed forwarded IP ignored by default');
process.env.TRUST_PROXY = 'true';
reqIp.headers['x-forwarded-for'] = '192.0.2.1, 203.0.113.8';
assert(security.clientIp(reqIp) === '203.0.113.8', 'trusted proxy uses appended client IP');
if (oldTrustProxy === undefined) delete process.env.TRUST_PROXY;
else process.env.TRUST_PROXY = oldTrustProxy;

const hash = hashPassword('password12');
const now = new Date().toISOString();
const u1 = uuid(), u2 = uuid(), u3 = uuid();
for (const [id, name] of [[u1,'SecUser1'],[u2,'SecUser2'],[u3,'SecUser3']]) {
  db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(id,name,hash,name,now);
  db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(id);
}
const gid = uuid();
db.prepare(`INSERT INTO games (id,creator_id,name,description,category,max_players,template,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'PUBLISHED',?,?)`)
  .run(gid, u1, 'Sec Game', 'd', 'Casual', 8, 'Empty World', now, now);

let r = platform.recordSession({ userId: u2, gameId: gid, durationSec: 2 });
assert(r.ignored, 'short session ignored');
r = platform.recordSession({ userId: u2, gameId: gid, durationSec: 60, sessionId: 'sess-abc-12345' });
assert(r.ok && r.recordedSec === 60, 'valid session');
r = platform.recordSession({ userId: u2, gameId: gid, durationSec: 60, sessionId: 'sess-abc-12345' });
assert(r.duplicate, 'duplicate session id');
r = platform.recordSession({ userId: u2, gameId: gid, durationSec: 999999, sessionId: 'sess-long-999' });
assert(r.recordedSec === 14400, 'duration capped');
let bad = false;
try { platform.recordSession({ userId: u2, gameId: 'nope', durationSec: 30 }); } catch (e) { bad = e.code === 'NOT_FOUND'; }
assert(bad, 'missing game');

let ssrf = false;
try { ai.assertSafeBaseUrl('http://evil.com'); } catch (e) { ssrf = e.code === 'BAD_URL' || e.code === 'SSRF'; }
assert(ssrf, 'http blocked');
ssrf = false;
try { ai.assertSafeBaseUrl('https://127.0.0.1/'); } catch (e) { ssrf = e.code === 'SSRF'; }
assert(ssrf, 'loopback blocked');
ssrf = false;
try { ai.assertSafeBaseUrl('https://192.168.1.1/'); } catch (e) { ssrf = e.code === 'SSRF'; }
assert(ssrf, 'private IP blocked');
ssrf = false;
try { ai.assertSafeBaseUrl('https://localhost/api'); } catch (e) { ssrf = e.code === 'SSRF'; }
assert(ssrf, 'localhost blocked');

const ps = platform.createPrivateServer({ userId: u1, gameId: gid, name: 'Tiny', maxPlayers: 2, accessCode: 'xy' });
platform.assertPrivateServerAccess(u2, ps.id, 'xy');
let full = false;
try { platform.assertPrivateServerAccess(u3, ps.id, 'xy'); } catch (e) { full = e.code === 'FULL'; }
assert(full, 'private server full at max');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('All security hardening tests passed');

// CORS preflight must allow PATCH because video metadata uses PATCH.
{
  const { applyCors } = require('../backend/services/security');
  const old = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = 'https://kavryon.example';
  const headers = {};
  const res = { setHeader(k, v) { headers[k] = v; } };
  applyCors({ headers: { origin: 'https://kavryon.example' } }, res);
  if (!String(headers['Access-Control-Allow-Methods'] || '').split(',').includes('PATCH')) {
    throw new Error('FAIL CORS preflight allows PATCH');
  }
  if (old === undefined) delete process.env.ALLOWED_ORIGINS; else process.env.ALLOWED_ORIGINS = old;
  console.log('OK CORS preflight allows PATCH');
}
