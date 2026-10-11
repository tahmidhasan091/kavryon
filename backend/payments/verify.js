/**
 * Kavx purchase verification — server authoritative.
 *
 * Production: Google Play Developer API purchase token verification.
 * Sandbox: only tokens minted by this backend (SANDBOX_PAYMENTS=true, non-production preferred).
 *
 * Never trust client-reported Kavx amounts.
 */
const crypto = require('crypto');
const { uuid } = require('../services/crypto');
const db = require('../database/db');
const wallet = require('../services/wallet');
const { getPackage } = require('../services/products');

const PLAY_PACKAGE = process.env.GOOGLE_PLAY_PACKAGE || 'com.kavryon.platform';

function hashReceipt(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function ensurePurchaseIndexes() {
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_provider_tx ON purchases(provider, provider_transaction_id)`);
  } catch (_) {}
}
ensurePurchaseIndexes();

/**
 * Grant Kavx only after verification. Idempotent on (provider, provider_transaction_id).
 */
function grantVerifiedPurchase({ userId, productId, provider, providerTransactionId, receipt, meta }) {
  const pack = getPackage(productId);
  if (!pack) {
    const e = new Error('Unknown product');
    e.code = 'UNKNOWN_PRODUCT';
    throw e;
  }
  if (!providerTransactionId || String(providerTransactionId).length < 8) {
    const e = new Error('Invalid transaction id');
    e.code = 'BAD_TX';
    throw e;
  }

  const amount = pack.amount; // server product table only
  const existing = db
    .prepare('SELECT * FROM purchases WHERE provider = ? AND provider_transaction_id = ?')
    .get(provider, String(providerTransactionId));

  if (existing) {
    // Bound to another account — never reassign or grant again
    if (existing.user_id !== userId) {
      const e = new Error('Purchase already bound to another account');
      e.code = 'TX_BOUND';
      throw e;
    }
    return {
      duplicate: true,
      purchase: { id: existing.id, status: existing.status, product_id: existing.product_id },
      kavxGranted: 0,
      balance: wallet.getBalance(userId)
    };
  }

  const purchaseId = uuid();
  const now = new Date().toISOString();
  const metaJson = meta ? JSON.stringify(meta).slice(0, 2000) : null;

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO purchases
       (id, provider, provider_transaction_id, user_id, product_id, status, verified_at, raw_receipt_hash, created_at)
       VALUES (?, ?, ?, ?, ?, 'verified', ?, ?, ?)`
    ).run(purchaseId, provider, String(providerTransactionId), userId, productId, now, hashReceipt(receipt || providerTransactionId), now);
    wallet.credit(userId, amount, 'PURCHASE', purchaseId, productId);
  });
  run();

  return {
    duplicate: false,
    purchaseId,
    kavxGranted: amount,
    balance: wallet.getBalance(userId)
  };
}

function mintSandboxToken(userId, productId) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) throw new Error('JWT_SECRET required for sandbox tokens');
  const payload = `${userId}:${productId}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function parseSandboxToken(token) {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const [payload, sig] = raw.split('.');
    if (!payload || !sig) return null;
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const expect = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const [userId, productId, ts, nonce] = payload.split(':');
    if (!userId || !productId) return null;
    // 1 hour max age
    if (Date.now() - Number(ts) > 3600000) return null;
    return { userId, productId, providerTransactionId: `sandbox_${ts}_${nonce}` };
  } catch {
    return null;
  }
}

/**
 * Verify a Google Play purchase token via Android Publisher API.
 *
 * Requires env:
 *   GOOGLE_PLAY_PACKAGE=com.kavryon.platform
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   OR GOOGLE_PLAY_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
 *
 * Returns { productId, orderId, purchaseState, acknowledged } or throws.
 */
async function verifyGooglePlayPurchase({ packageName, productId, purchaseToken }) {
  const pkg = packageName || PLAY_PACKAGE;
  if (!productId || !purchaseToken) {
    const e = new Error('productId and purchaseToken required');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  if (!getPackage(productId)) {
    const e = new Error('Unknown product');
    e.code = 'UNKNOWN_PRODUCT';
    throw e;
  }

  // Mock path for automated tests only
  if (process.env.PLAY_VERIFY_MOCK === '1') {
    if (String(purchaseToken).includes('invalid')) {
      const e = new Error('Invalid purchase token');
      e.code = 'INVALID_TOKEN';
      throw e;
    }
    if (String(purchaseToken).includes('wrong_product')) {
      return { productId: 'kavx_other', orderId: 'mock_order', purchaseState: 0, acknowledged: false, mock: true };
    }
    if (String(purchaseToken).includes('pending')) {
      return { productId, orderId: 'mock_pending', purchaseState: 2, acknowledged: false, mock: true };
    }
    if (String(purchaseToken).includes('cancelled')) {
      return { productId, orderId: 'mock_cancel', purchaseState: 1, acknowledged: false, mock: true };
    }
    return {
      productId,
      orderId: 'mock_' + crypto.createHash('sha256').update(purchaseToken).digest('hex').slice(0, 16),
      purchaseState: 0,
      acknowledged: false,
      mock: true
    };
  }

  let credentials;
  if (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
    } catch {
      const e = new Error('Invalid GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
      e.code = 'CONFIG';
      throw e;
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // google-auth will load from file path when using googleapis
    credentials = null;
  } else {
    const e = new Error(
      'Google Play verification not configured. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.'
    );
    e.code = 'NOT_CONFIGURED';
    throw e;
  }

  // Dynamic require so tests without googleapis still load the module
  let google;
  try {
    google = require('googleapis').google;
  } catch {
    const e = new Error(
      'googleapis package not installed. Run: npm install googleapis --prefix backend'
    );
    e.code = 'MISSING_DEP';
    throw e;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: credentials || undefined,
    keyFile: credentials ? undefined : process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/androidpublisher']
  });
  const authClient = await auth.getClient();
  const androidpublisher = google.androidpublisher({ version: 'v3', auth: authClient });

  const result = await androidpublisher.purchases.products.get({
    packageName: pkg,
    productId,
    token: purchaseToken
  });

  const data = result.data || {};
  // purchaseState: 0 purchased, 1 canceled, 2 pending
  return {
    productId: data.productId || productId,
    orderId: data.orderId || purchaseToken,
    purchaseState: data.purchaseState,
    consumptionState: data.consumptionState,
    acknowledged: data.acknowledgementState === 1,
    purchaseTimeMillis: data.purchaseTimeMillis,
    raw: undefined // never log full raw in callers
  };
}

/**
 * Complete a Play purchase: verify → grant → optionally acknowledge.
 */
async function completeGooglePlayPurchase({ userId, productId, purchaseToken, packageName }) {
  const expectedPkg = process.env.GOOGLE_PLAY_PACKAGE || 'com.kavryon.platform';
  if (packageName && String(packageName) !== expectedPkg) {
    const e = new Error('packageName mismatch');
    e.code = 'PACKAGE';
    throw e;
  }
  packageName = expectedPkg;
  const verified = await verifyGooglePlayPurchase({ packageName, productId, purchaseToken });

  if (verified.productId && verified.productId !== productId) {
    const e = new Error('Product ID mismatch');
    e.code = 'PRODUCT_MISMATCH';
    throw e;
  }
  if (verified.purchaseState === 1) {
    const e = new Error('Purchase cancelled');
    e.code = 'CANCELLED';
    throw e;
  }
  if (verified.purchaseState === 2) {
    const e = new Error('Purchase pending');
    e.code = 'PENDING';
    throw e;
  }
  if (verified.purchaseState !== 0 && verified.purchaseState !== undefined) {
    const e = new Error('Purchase not completed');
    e.code = 'NOT_PURCHASED';
    throw e;
  }

  const orderId = verified.orderId || purchaseToken;
  const grant = grantVerifiedPurchase({
    userId,
    productId,
    provider: 'google_play',
    providerTransactionId: orderId,
    receipt: purchaseToken,
    meta: { packageName: packageName || PLAY_PACKAGE, purchaseState: verified.purchaseState }
  });

  // Acknowledge when possible — never revoke grant if ack fails; queue for retry
  if (!grant.duplicate && !verified.mock && !verified.acknowledged) {
    const ackOk = await tryAcknowledgePlayPurchase({
      packageName: packageName || PLAY_PACKAGE,
      productId,
      purchaseToken
    });
    if (!ackOk) {
      queueAckRetry({
        purchaseId: grant.purchaseId,
        packageName: packageName || PLAY_PACKAGE,
        productId,
        purchaseToken
      });
    }
  }

  return grant;
}

function ensureAckQueue() {
  db.exec(`CREATE TABLE IF NOT EXISTS play_ack_queue (
    id TEXT PRIMARY KEY,
    purchase_id TEXT,
    package_name TEXT NOT NULL,
    product_id TEXT NOT NULL,
    purchase_token TEXT NOT NULL UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

function queueAckRetry({ purchaseId, packageName, productId, purchaseToken }) {
  ensureAckQueue();
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT OR IGNORE INTO play_ack_queue (id, purchase_id, package_name, product_id, purchase_token, attempts, created_at, updated_at)
       VALUES (?,?,?,?,?,0,?,?)`
    ).run(uuid(), purchaseId || null, packageName, productId, purchaseToken, now, now);
  } catch (_) {}
}

async function tryAcknowledgePlayPurchase({ packageName, productId, purchaseToken }) {
  try {
    const google = require('googleapis').google;
    let credentials;
    if (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
      credentials = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
    }
    const auth = new google.auth.GoogleAuth({
      credentials: credentials || undefined,
      keyFile: credentials ? undefined : process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/androidpublisher']
    });
    const androidpublisher = google.androidpublisher({ version: 'v3', auth: await auth.getClient() });
    await androidpublisher.purchases.products.acknowledge({
      packageName,
      productId,
      token: purchaseToken,
      requestBody: {}
    });
    // remove from queue on success
    try {
      ensureAckQueue();
      db.prepare('DELETE FROM play_ack_queue WHERE purchase_token=?').run(purchaseToken);
    } catch (_) {}
    return true;
  } catch (e) {
    try {
      ensureAckQueue();
      db.prepare('UPDATE play_ack_queue SET attempts=attempts+1, last_error=?, updated_at=? WHERE purchase_token=?')
        .run(String(e.message || e).slice(0, 300), new Date().toISOString(), purchaseToken);
    } catch (_) {}
    return false;
  }
}

/** Process pending acknowledgements (call from cron or health interval). */
async function processAckQueue(limit = 20) {
  ensureAckQueue();
  const rows = db.prepare('SELECT * FROM play_ack_queue WHERE attempts < 10 ORDER BY updated_at ASC LIMIT ?').all(limit);
  let ok = 0, fail = 0;
  for (const row of rows) {
    const success = await tryAcknowledgePlayPurchase({
      packageName: row.package_name,
      productId: row.product_id,
      purchaseToken: row.purchase_token
    });
    if (success) ok++;
    else fail++;
  }
  return { processed: rows.length, ok, fail };
}


/**
 * Mark purchase revoked (refund) — admin/webhook path.
 */
function revokePurchase({ provider, providerTransactionId, reason }) {
  const row = db.prepare('SELECT * FROM purchases WHERE provider=? AND provider_transaction_id=?').get(provider, providerTransactionId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'revoked') return { ok: true, already: true };
  const pack = getPackage(row.product_id);
  const amount = pack ? pack.amount : 0;
  const run = db.transaction(() => {
    db.prepare(`UPDATE purchases SET status='revoked' WHERE id=?`).run(row.id);
    if (amount > 0) {
      try {
        wallet.debit(row.user_id, amount, 'REFUND', `revoke:${row.id}:${reason || ''}`);
      } catch (_) {
        // balance may be insufficient — still mark revoked for audit
      }
    }
  });
  run();
  return { ok: true, purchaseId: row.id };
}

module.exports = {
  grantVerifiedPurchase,
  mintSandboxToken,
  parseSandboxToken,
  verifyGooglePlayPurchase,
  tryAcknowledgePlayPurchase,
  processAckQueue,
  queueAckRetry,
  completeGooglePlayPurchase,
  revokePurchase,
  PLAY_PACKAGE
};
