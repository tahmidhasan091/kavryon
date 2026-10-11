process.env.JWT_SECRET = 'test-secret-ai-provider-suite-32ch!!';
process.env.CREDENTIALS_ENCRYPTION_KEY = 'test-credentials-encryption-key-32b';
process.env.KAVRYON_DB = '/tmp/kavryon-ai-prov-test.sqlite';
process.env.AI_HTTP_MOCK = '1';
process.env.NODE_ENV = 'development';
const fs = require('fs');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);
require('../backend/database/db');
require('../backend/database/seed');
const db = require('../backend/database/db');
const { hashPassword, uuid } = require('../backend/services/crypto');
const ai = require('../backend/services/ai_providers');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

const hash = hashPassword('password12');
const now = new Date().toISOString();
const a = uuid(), b = uuid();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(a,'AliceAI',hash,'Alice',now);
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(b,'BobAI',hash,'Bob',now);

// Add provider
const p1 = ai.addProvider({ userId: a, provider: 'openai', apiKey: 'test_sk_alice_key_12345', model: 'gpt-4o-mini' });
assert(p1.id && p1.provider === 'openai', 'add provider');
assert(p1.isDefault, 'first is default');
assert(!('apiKey' in p1) && !JSON.stringify(p1).includes('test_sk'), 'key not in public row');

// List
const list = ai.listProviders(a);
assert(list.length === 1, 'list own');
assert(list.every(x => !JSON.stringify(x).includes('test_sk')), 'list has no key');

// Bob cannot see Alice
assert(ai.listProviders(b).length === 0, 'isolation list');
assert(!ai.getCredential(b, p1.id), 'isolation credential');

// Test connection mock
(async () => {
  const t1 = await ai.testConnection(a, p1.id);
  assert(t1.ok, 'mock test ok');
  const bad = ai.addProvider({ userId: a, provider: 'gemini', apiKey: 'test_invalid_key_xxx' });
  const t2 = await ai.testConnection(a, bad.id);
  assert(!t2.ok, 'mock invalid fails');

  // SSRF
  let ssrf = false;
  try { ai.addProvider({ userId: a, provider: 'custom', apiKey: 'test_custom_key_12345', baseUrl: 'https://127.0.0.1/v1' }); }
  catch (e) { ssrf = e.code === 'SSRF' || e.code === 'BAD_URL'; }
  assert(ssrf, 'SSRF blocked');

  let ssrf2 = false;
  try { ai.addProvider({ userId: a, provider: 'custom', apiKey: 'test_custom_key_12345', baseUrl: 'http://evil.com/v1' }); }
  catch (e) { ssrf2 = e.code === 'BAD_URL'; }
  assert(ssrf2, 'http custom blocked');

  // Plan mock
  const plan = await ai.requestPlan({ userId: a, providerId: p1.id, prompt: 'Create a BedWars style team battle', dimension: '2d' });
  assert(plan.plan, 'plan returned');
  assert(plan.source === 'provider-mock' || plan.source === 'local', 'mock/local source');

  // Remove
  ai.removeProvider(a, p1.id);
  assert(ai.listProviders(a).filter(x => x.id === p1.id).length === 0, 'removed');
  assert(!ai.getCredential(a, p1.id), 'credential gone');

  // Encrypt roundtrip
  const enc = ai.encryptSecret('secret-value');
  assert(ai.decryptSecret(enc) === 'secret-value', 'encrypt roundtrip');
  assert(!enc.includes('secret-value'), 'ciphertext hides plain');

  if (failed) { console.error(failed + ' failed'); process.exit(1); }
  console.log('All AI provider tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
