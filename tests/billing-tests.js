process.env.JWT_SECRET = 'test-secret-billing-suite-32chars!!';
process.env.KAVRYON_DB = '/tmp/kavryon-billing-test.sqlite';
process.env.PLAY_VERIFY_MOCK = '1';
process.env.SANDBOX_PAYMENTS = 'false';
process.env.NODE_ENV = 'test';
const fs = require('fs');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);
require('../backend/database/db');
require('../backend/database/seed');
const db = require('../backend/database/db');
const { hashPassword, uuid } = require('../backend/services/crypto');
const { getBalance } = require('../backend/services/wallet');
const {
  grantVerifiedPurchase,
  completeGooglePlayPurchase,
  verifyGooglePlayPurchase,
  mintSandboxToken,
  parseSandboxToken
} = require('../backend/payments/verify');
const { KAVX_PACKAGES, getPackage } = require('../backend/services/products');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

const hash = hashPassword('password12');
const now = new Date().toISOString();
const uid = uuid();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,0,'active')`).run(uid,'BuyerBill',hash,'Buyer',now);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,0)').run(uid);

const productId = KAVX_PACKAGES[0].productId;
const amount = KAVX_PACKAGES[0].amount;

(async () => {
  // Invalid product
  let bad = false;
  try {
    await completeGooglePlayPurchase({ userId: uid, productId: 'not_a_real_sku', purchaseToken: 'tok_valid_abc12345' });
  } catch (e) { bad = e.code === 'UNKNOWN_PRODUCT'; }
  assert(bad, 'unknown product rejected');

  // Invalid token
  bad = false;
  try {
    await completeGooglePlayPurchase({ userId: uid, productId, purchaseToken: 'invalid_token_xyz' });
  } catch (e) { bad = e.code === 'INVALID_TOKEN'; }
  assert(bad, 'invalid token rejected');

  // Pending
  bad = false;
  try {
    await completeGooglePlayPurchase({ userId: uid, productId, purchaseToken: 'pending_token_abc12345' });
  } catch (e) { bad = e.code === 'PENDING'; }
  assert(bad, 'pending purchase not granted');

  // Cancelled
  bad = false;
  try {
    await completeGooglePlayPurchase({ userId: uid, productId, purchaseToken: 'cancelled_token_abc12345' });
  } catch (e) { bad = e.code === 'CANCELLED'; }
  assert(bad, 'cancelled purchase not granted');

  // Product mismatch
  bad = false;
  try {
    await completeGooglePlayPurchase({ userId: uid, productId, purchaseToken: 'wrong_product_token_abc' });
  } catch (e) { bad = e.code === 'PRODUCT_MISMATCH'; }
  assert(bad, 'product mismatch rejected');

  // Success
  const r1 = await completeGooglePlayPurchase({ userId: uid, productId, purchaseToken: 'good_token_abc12345678' });
  assert(r1.kavxGranted === amount, 'kavx granted from product table');
  assert(getBalance(uid) === amount, 'balance matches');

  // Duplicate / replay
  const r2 = await completeGooglePlayPurchase({ userId: uid, productId, purchaseToken: 'good_token_abc12345678' });
  assert(r2.duplicate === true, 'duplicate token no double grant');
  assert(r2.kavxGranted === 0, 'zero grant on replay');
  assert(getBalance(uid) === amount, 'balance unchanged on replay');

  // Client cannot choose amount — grantVerified ignores client amounts
  const g = grantVerifiedPurchase({
    userId: uid,
    productId,
    provider: 'test',
    providerTransactionId: 'manual_tx_1',
    receipt: 'r1'
  });
  assert(g.kavxGranted === amount, 'grant uses server package amount');

  // Sandbox token parse
  process.env.SANDBOX_PAYMENTS = 'true';
  const tok = mintSandboxToken(uid, productId);
  const parsed = parseSandboxToken(tok);
  assert(parsed && parsed.userId === uid && parsed.productId === productId, 'sandbox token parses');
  assert(!parseSandboxToken('garbage'), 'garbage token null');

  if (failed) { console.error(failed + ' failed'); process.exit(1); }
  console.log('All billing tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
