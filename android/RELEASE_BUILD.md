const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validate } = require('../backend/services/production-config');
const { createConnectionLimiter } = require('../backend/services/connection-limit');

const valid = {
  NODE_ENV: 'production',
  JWT_SECRET: 'a-unique-production-secret-that-is-long-enough-12345',
  KAVRYON_DB: '/var/lib/kavryon/kavryon.sqlite',
  ALLOWED_ORIGINS: 'https://kavryon.example,https://appassets.androidplatform.net',
  GOOGLE_PLAY_PACKAGE: 'com.kavryon.platform',
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account',
    client_email: 'kavryon-release@example.iam.gserviceaccount.com',
    private_key: 'test-key-only'
  })
};

assert.deepStrictEqual(validate({ NODE_ENV: 'test' }), [], 'non-production environments skip production-only checks');
assert.deepStrictEqual(validate(valid), [], 'complete production configuration passes');
assert(validate({ ...valid, JWT_SECRET: 'short' }).some((x) => x.includes('JWT_SECRET')), 'weak JWT secret rejected');
assert(validate({ ...valid, KAVRYON_DB: '/tmp/kavryon.sqlite' }).some((x) => x.includes('persistent storage')), 'temporary database rejected');
assert(validate({ ...valid, ALLOWED_ORIGINS: 'http://kavryon.example' }).some((x) => x.includes('HTTPS origin')), 'non-HTTPS origin rejected');
assert(validate({ ...valid, ALLOWED_ORIGINS: 'https://kavryon.example,*' }).some((x) => x.includes('wildcard')), 'wildcard CORS rejected in production');
assert(validate({ ...valid, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '{broken' }).some((x) => x.includes('valid JSON')), 'invalid service-account JSON rejected');
assert(validate({ ...valid, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: undefined }).some((x) => x.includes('Google Play verification')), 'missing billing verification credentials rejected');
assert(validate({ ...valid, GOOGLE_PLAY_PACKAGE: 'com.other.app' }).some((x) => x.includes('applicationId')), 'package mismatch rejected');
const capConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../frontend/capacitor.config.json'), 'utf8'));
assert.strictEqual(capConfig.android.allowMixedContent, false, 'mixed content disabled in frontend config');
assert.strictEqual(capConfig.server.cleartext, false, 'cleartext disabled in frontend config');
assert(fs.readFileSync(path.join(__dirname, '../frontend/js/app.js'), 'utf8').includes('p.purchaseState !== 1'), 'pending native purchases are not granted by frontend');
const dbPath = path.join(os.tmpdir(), `kavryon-prod-gate-${process.pid}.sqlite`);
const child = spawnSync(process.execPath, [path.join(__dirname, '../backend/server.js')], {
  encoding: 'utf8',
  env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'short', KAVRYON_DB: dbPath, ALLOWED_ORIGINS: '', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '' }
});
assert.notStrictEqual(child.status, 0, 'production server rejects invalid release config');
assert((child.stderr || '').includes('Production configuration invalid'), 'production config error is explicit');
assert(!fs.existsSync(dbPath), 'invalid production config is rejected before database creation');
const limiter = createConnectionLimiter(2);
const releaseA = limiter.acquire('peer-a');
const releaseB = limiter.acquire('peer-a');
assert.strictEqual(typeof releaseA, 'function');
assert.strictEqual(typeof releaseB, 'function');
assert.strictEqual(limiter.acquire('peer-a'), null, 'active WebSocket cap enforced');
releaseA();
releaseA();
assert.strictEqual(limiter.count('peer-a'), 1, 'release is idempotent');
releaseB();
assert.strictEqual(limiter.count('peer-a'), 0, 'all active slots released');
assert.strictEqual(limiter.peerCount(), 0, 'idle peer keys removed');
assert.strictEqual(typeof limiter.acquire('peer-a'), 'function', 'failed connections do not permanently block peer');
console.log('All production release configuration and connection limiter tests passed');
