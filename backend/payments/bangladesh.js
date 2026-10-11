/**
 * Bangladesh Kavx purchase adapter (SSLCommerz primary; bKash scaffold).
 *
 * CRITICAL:
 * - Credentials stay server-side (env only).
 * - Kavx is granted ONLY after provider verification / signed callback.
 * - A personal mobile number (e.g. bKash personal wallet) is NOT a merchant
 *   settlement destination for automated gateway payouts.
 * - Without merchant credentials, live checkout is disabled (503), never faked.
 *
 * Settlement: SSLCommerz (and similar) settle to the registered merchant bank /
 * mobile financial account linked during merchant onboarding — not an arbitrary
 * phone number hard-coded in the app.
 */
const crypto = require('crypto');
const db = require('../database/db');
const { uuid } = require('../services/crypto');
const { grantVerifiedPurchase } = require('./verify');
const { getPackage } = require('../services/products');

const PROVIDER = 'bd_sslcommerz';

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      amount_bdt INTEGER NOT NULL,
      kavx_amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'BDT',
      status TEXT NOT NULL DEFAULT 'pending',
      provider_session_id TEXT,
      provider_tran_id TEXT UNIQUE,
      provider_val_id TEXT,
      raw_callback_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);
  `);
}
ensureTables();

/** BDT price list — server only; never trust client amount */
const BDT_PRICES = {
  kavx_50: 50,
  kavx_100: 100,
  kavx_250: 240,
  kavx_500: 475,
  kavx_1000: 900
};

function isConfigured() {
  const storeId = process.env.SSLCOMMERZ_STORE_ID;
  const storePass = process.env.SSLCOMMERZ_STORE_PASSWORD;
  if (!storeId || !storePass) return false;
  if (storeId === 'CHANGE_ME' || storePass === 'CHANGE_ME') return false;
  return true;
}

function isLiveMode() {
  return process.env.SSLCOMMERZ_MODE === 'live';
}

function gatewayBase() {
  return isLiveMode()
    ? 'https://securepay.sslcommerz.com'
    : 'https://sandbox.sslcommerz.com';
}

function status() {
  return {
    available: isConfigured(),
    provider: 'sslcommerz',
    mode: isConfigured() ? (isLiveMode() ? 'live' : 'sandbox') : 'disabled',
    currency: 'BDT',
    packages: Object.keys(BDT_PRICES).map((productId) => {
      const pack = getPackage(productId);
      return {
        productId,
        kavx: pack ? pack.amount : null,
        amountBdt: BDT_PRICES[productId],
        label: pack ? pack.label : productId
      };
    }).filter((p) => p.kavx != null),
    message: isConfigured()
      ? 'SSLCommerz checkout available'
      : 'Bangladesh card/MFS checkout is not configured. Set SSLCOMMERZ_STORE_ID and SSLCOMMERZ_STORE_PASSWORD after merchant approval.'
  };
}

/**
 * Create a pending order. Returns gateway init payload only when configured.
 * Amount and Kavx come exclusively from server catalogs.
 */
async function createOrder({ userId, productId }) {
  if (!isConfigured()) {
    const e = new Error('Payment provider not configured');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const pack = getPackage(productId);
  if (!pack) {
    const e = new Error('Unknown product');
    e.code = 'UNKNOWN_PRODUCT';
    throw e;
  }
  const amountBdt = BDT_PRICES[pack.productId] || BDT_PRICES[productId];
  if (!amountBdt || amountBdt < 1) {
    const e = new Error('Product has no BDT price');
    e.code = 'NO_PRICE';
    throw e;
  }

  const orderId = uuid();
  const tranId = 'KAV' + crypto.randomBytes(12).toString('hex');
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO payment_orders
     (id, user_id, product_id, provider, amount_bdt, kavx_amount, currency, status, provider_tran_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'BDT', 'pending', ?,?,?)`
  ).run(orderId, userId, pack.productId, PROVIDER, amountBdt, pack.amount, tranId, now, now);

  const storeId = process.env.SSLCOMMERZ_STORE_ID;
  const storePass = process.env.SSLCOMMERZ_STORE_PASSWORD;
  const successUrl = process.env.SSLCOMMERZ_SUCCESS_URL || '';
  const failUrl = process.env.SSLCOMMERZ_FAIL_URL || '';
  const cancelUrl = process.env.SSLCOMMERZ_CANCEL_URL || '';
  const ipnUrl = process.env.SSLCOMMERZ_IPN_URL || '';

  // Official session API (server → SSLCommerz)
  const body = new URLSearchParams({
    store_id: storeId,
    store_passwd: storePass,
    total_amount: String(amountBdt),
    currency: 'BDT',
    tran_id: tranId,
    success_url: successUrl,
    fail_url: failUrl,
    cancel_url: cancelUrl,
    ipn_url: ipnUrl,
    product_name: pack.label || 'Kavx',
    product_category: 'digital',
    product_profile: 'non-physical-goods',
    cus_name: 'Kavryon User',
    cus_email: 'noreply@kavryon.local',
    cus_add1: 'N/A',
    cus_city: 'Dhaka',
    cus_country: 'Bangladesh',
    cus_phone: process.env.SSLCOMMERZ_CUS_PHONE_PLACEHOLDER || '01700000000',
    shipping_method: 'NO',
    num_of_item: '1',
    value_a: userId,
    value_b: pack.productId,
    value_c: orderId
  });

  const initUrl = gatewayBase() + '/gwprocess/v4/api.php';
  let gatewayUrl = null;
  let sessionKey = null;
  try {
    const resp = await fetch(initUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = await resp.json();
    if (data.status === 'SUCCESS' && data.GatewayPageURL) {
      gatewayUrl = data.GatewayPageURL;
      sessionKey = data.sessionkey || null;
      db.prepare(
        `UPDATE payment_orders SET provider_session_id=?, updated_at=? WHERE id=?`
      ).run(sessionKey, new Date().toISOString(), orderId);
    } else {
      db.prepare(
        `UPDATE payment_orders SET status='failed', updated_at=? WHERE id=?`
      ).run(new Date().toISOString(), orderId);
      const e = new Error(data.failedreason || 'Gateway init failed');
      e.code = 'GATEWAY_INIT';
      throw e;
    }
  } catch (err) {
    if (err.code === 'GATEWAY_INIT') throw err;
    db.prepare(
      `UPDATE payment_orders SET status='failed', updated_at=? WHERE id=?`
    ).run(new Date().toISOString(), orderId);
    const e = new Error('Could not reach payment gateway');
    e.code = 'GATEWAY_UNREACHABLE';
    e.cause = err;
    throw e;
  }

  return {
    orderId,
    tranId,
    amountBdt,
    kavx: pack.amount,
    currency: 'BDT',
    gatewayUrl,
    status: 'pending'
  };
}

function getOrder(orderId) {
  return db.prepare('SELECT * FROM payment_orders WHERE id=?').get(orderId);
}

function getOrderByTranId(tranId) {
  return db.prepare('SELECT * FROM payment_orders WHERE provider_tran_id=?').get(tranId);
}

/**
 * Verify payment with SSLCommerz validation API, then grant Kavx once.
 * Idempotent on provider transaction id via purchases unique index.
 */
async function handleIpnOrCallback(payload) {
  if (!isConfigured()) {
    const e = new Error('Provider not configured');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }

  const tranId = String(payload.tran_id || payload.tranId || '');
  const valId = String(payload.val_id || payload.valId || '');
  const status = String(payload.status || '').toUpperCase();
  const amount = Number(payload.amount || payload.store_amount || 0);

  if (!tranId) {
    const e = new Error('Missing tran_id');
    e.code = 'BAD_PAYLOAD';
    throw e;
  }

  const order = getOrderByTranId(tranId);
  if (!order) {
    const e = new Error('Unknown order');
    e.code = 'UNKNOWN_ORDER';
    throw e;
  }

  if (order.status === 'completed') {
    return {
      duplicate: true,
      orderId: order.id,
      status: 'completed',
      kavxGranted: 0,
      balance: require('../services/wallet').getBalance(order.user_id)
    };
  }

  if (status && status !== 'VALID' && status !== 'VALIDATED' && status !== 'SUCCESS') {
    db.prepare(
      `UPDATE payment_orders SET status=?, updated_at=? WHERE id=?`
    ).run('failed', new Date().toISOString(), order.id);
    return { orderId: order.id, status: 'failed', kavxGranted: 0 };
  }

  // Server-to-server validation
  const storeId = process.env.SSLCOMMERZ_STORE_ID;
  const storePass = process.env.SSLCOMMERZ_STORE_PASSWORD;
  const valUrl =
    gatewayBase() +
    '/validator/api/validationserverAPI.php?' +
    new URLSearchParams({
      val_id: valId,
      store_id: storeId,
      store_passwd: storePass,
      format: 'json'
    }).toString();

  let validated = null;
  try {
    const resp = await fetch(valUrl);
    validated = await resp.json();
  } catch (err) {
    const e = new Error('Validation API unreachable');
    e.code = 'VALIDATION_UNREACHABLE';
    throw e;
  }

  const vStatus = String(validated.status || '').toUpperCase();
  if (vStatus !== 'VALID' && vStatus !== 'VALIDATED') {
    db.prepare(
      `UPDATE payment_orders SET status='failed', updated_at=? WHERE id=?`
    ).run(new Date().toISOString(), order.id);
    return { orderId: order.id, status: 'failed', reason: 'not_valid', kavxGranted: 0 };
  }

  const paidAmount = Number(validated.amount || validated.currency_amount || 0);
  if (Math.abs(paidAmount - order.amount_bdt) > 0.01) {
    db.prepare(
      `UPDATE payment_orders SET status='failed', updated_at=? WHERE id=?`
    ).run(new Date().toISOString(), order.id);
    const e = new Error('Amount mismatch');
    e.code = 'AMOUNT_MISMATCH';
    throw e;
  }

  if (String(validated.tran_id) !== tranId) {
    const e = new Error('tran_id mismatch');
    e.code = 'TRAN_MISMATCH';
    throw e;
  }

  // Grant via shared purchase ledger (idempotent on provider + tx id)
  const grant = grantVerifiedPurchase({
    userId: order.user_id,
    productId: order.product_id,
    provider: PROVIDER,
    providerTransactionId: String(validated.bank_tran_id || valId || tranId),
    receipt: JSON.stringify({
      tran_id: tranId,
      val_id: valId,
      amount: paidAmount
    }).slice(0, 2000),
    meta: { orderId: order.id, provider: PROVIDER }
  });

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE payment_orders SET status='completed', provider_val_id=?, raw_callback_hash=?, updated_at=?, completed_at=? WHERE id=?`
  ).run(
    valId,
    crypto.createHash('sha256').update(JSON.stringify(validated)).digest('hex'),
    now,
    now,
    order.id
  );

  return {
    duplicate: !!grant.duplicate,
    orderId: order.id,
    status: 'completed',
    kavxGranted: grant.kavxGranted,
    balance: grant.balance
  };
}

function listOrders(userId, limit = 30) {
  return db
    .prepare(
      `SELECT id, product_id, amount_bdt, kavx_amount, currency, status, provider, created_at, completed_at
       FROM payment_orders WHERE user_id=? ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, Math.min(50, limit));
}

module.exports = {
  status,
  isConfigured,
  createOrder,
  handleIpnOrCallback,
  getOrder,
  listOrders,
  BDT_PRICES,
  PROVIDER
};
