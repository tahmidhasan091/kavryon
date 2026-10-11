/**
 * Creator AI provider credentials — encrypted at rest, never returned to clients.
 */
const crypto = require('crypto');
const db = require('../database/db');
const { uuid } = require('./crypto');

const PROVIDERS = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
  gemini: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-1.5-flash', 'gemini-1.5-pro'] },
  grok: { name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', models: ['grok-2', 'grok-2-mini'] },
  claude: { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-3-5-sonnet-latest', 'claude-3-haiku-latest'] },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-coder'] },
  custom: { name: 'Custom OpenAI-Compatible', baseUrl: null, models: ['default'] }
};

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_providers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    label TEXT,
    model TEXT,
    base_url TEXT,
    api_key_enc TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    last_test_at TEXT,
    last_test_ok INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ai_prov_user ON ai_providers(user_id)');
}
ensureTable();

function getEncKey() {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY || '';
  if (raw.length >= 32) return crypto.createHash('sha256').update(raw).digest();
  if (process.env.NODE_ENV === 'production') {
    const e = new Error('CREDENTIALS_ENCRYPTION_KEY required in production');
    e.code = 'NO_ENC_KEY';
    throw e;
  }
  // Dev fallback derived from JWT — not for production
  const jwt = process.env.JWT_SECRET || 'dev-only-insecure-key-do-not-use-prod';
  return crypto.createHash('sha256').update('kavryon-ai-cred:' + jwt).digest();
}

function encryptSecret(plain) {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decryptSecret(blob) {
  const key = getEncKey();
  const [ivH, tagH, dataH] = String(blob).split(':');
  if (!ivH || !tagH || !dataH) throw Object.assign(new Error('Corrupt credential'), { code: 'CORRUPT' });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivH, 'hex'));
  decipher.setAuthTag(Buffer.from(tagH, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataH, 'hex')), decipher.final()]).toString('utf8');
}

function publicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    model: row.model,
    baseUrl: row.provider === 'custom' ? row.base_url : (PROVIDERS[row.provider] && PROVIDERS[row.provider].baseUrl),
    isDefault: !!row.is_default,
    status: row.status,
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok == null ? null : !!row.last_test_ok,
    createdAt: row.created_at
  };
}

/** Block private/link-local hosts for custom endpoints (SSRF + DNS rebinding). */
function isPrivateIp(ip) {
  if (!ip) return true;
  const s = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::1' || s === '0.0.0.0' || s === '::') return true;
  if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')) return true;
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false; // non-IPv4 left to DNS check
  const a = [+m[1], +m[2], +m[3], +m[4]];
  if (a[0] === 10) return true;
  if (a[0] === 127) return true;
  if (a[0] === 0) return true;
  if (a[0] === 169 && a[1] === 254) return true;
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
  if (a[0] === 192 && a[1] === 168) return true;
  if (a[0] === 100 && a[1] >= 64 && a[1] <= 127) return true; // CGNAT
  if (a[0] >= 224) return true; // multicast/reserved
  return false;
}

function assertSafeBaseUrl(url) {
  if (!url) return;
  let u;
  try { u = new URL(url); } catch { throw Object.assign(new Error('Invalid base URL'), { code: 'BAD_URL' }); }
  if (u.protocol !== 'https:') throw Object.assign(new Error('Custom provider must use https://'), { code: 'BAD_URL' });
  if (u.username || u.password) throw Object.assign(new Error('URL credentials not allowed'), { code: 'BAD_URL' });
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host === '0.0.0.0') {
    throw Object.assign(new Error('Private hosts not allowed'), { code: 'SSRF' });
  }
  if (isPrivateIp(host)) {
    throw Object.assign(new Error('Private IP ranges not allowed'), { code: 'SSRF' });
  }
  // DNS resolve and re-check (sync lookup; blocks rebinding to private IP)
  try {
    const dns = require('dns');
    const { promisify } = require('util');
    // Note: callers should prefer assertSafeBaseUrlAsync for full DNS; sync path uses lookupSync if available
    const results = dns.lookupSync ? [dns.lookupSync(host, { all: true })].flat() : null;
    if (results && results.length) {
      for (const r of results) {
        const addr = r.address || r;
        if (isPrivateIp(addr)) {
          throw Object.assign(new Error('Host resolves to private address'), { code: 'SSRF' });
        }
      }
    }
  } catch (e) {
    if (e.code === 'SSRF') throw e;
    // ENOTFOUND etc. — reject unknown hosts for custom endpoints
    if (e.code === 'ENOTFOUND' || e.code === 'ESERVFAIL') {
      throw Object.assign(new Error('Host could not be resolved'), { code: 'SSRF' });
    }
  }
}

async function assertSafeBaseUrlAsync(url) {
  if (!url) return;
  assertSafeBaseUrl(url);
  let u;
  try { u = new URL(url); } catch { throw Object.assign(new Error('Invalid base URL'), { code: 'BAD_URL' }); }
  const dns = require('dns').promises;
  try {
    const results = await dns.lookup(u.hostname, { all: true });
    for (const r of results) {
      if (isPrivateIp(r.address)) {
        throw Object.assign(new Error('Host resolves to private address'), { code: 'SSRF' });
      }
    }
  } catch (e) {
    if (e.code === 'SSRF' || e.code === 'BAD_URL') throw e;
    throw Object.assign(new Error('Host could not be resolved'), { code: 'SSRF' });
  }
}


function listProviders(userId) {
  ensureTable();
  return db.prepare('SELECT * FROM ai_providers WHERE user_id=? AND status!=\'deleted\' ORDER BY is_default DESC, created_at DESC')
    .all(userId).map(publicRow);
}

function addProvider({ userId, provider, apiKey, model, label, baseUrl }) {
  ensureTable();
  if (!PROVIDERS[provider]) throw Object.assign(new Error('Unknown provider'), { code: 'BAD_PROVIDER' });
  if (!apiKey || String(apiKey).length < 8) throw Object.assign(new Error('API key required'), { code: 'BAD_KEY' });
  if (provider === 'custom') assertSafeBaseUrl(baseUrl);
  const now = new Date().toISOString();
  const id = uuid();
  const enc = encryptSecret(apiKey);
  const models = PROVIDERS[provider].models;
  const useModel = model && models.includes(model) ? model : models[0];
  const count = db.prepare('SELECT COUNT(*) as c FROM ai_providers WHERE user_id=? AND status=\'active\'').get(userId).c;
  const isDefault = count === 0 ? 1 : 0;
  db.prepare(
    `INSERT INTO ai_providers (id,user_id,provider,label,model,base_url,api_key_enc,is_default,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'active',?,?)`
  ).run(id, userId, provider, label || PROVIDERS[provider].name, useModel, provider === 'custom' ? baseUrl : null, enc, isDefault, now, now);
  return publicRow(db.prepare('SELECT * FROM ai_providers WHERE id=?').get(id));
}

function removeProvider(userId, id) {
  const row = db.prepare('SELECT * FROM ai_providers WHERE id=? AND user_id=?').get(id, userId);
  if (!row) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
  db.prepare(`UPDATE ai_providers SET status='deleted', api_key_enc='', updated_at=? WHERE id=?`).run(new Date().toISOString(), id);
  if (row.is_default) {
    const next = db.prepare(`SELECT id FROM ai_providers WHERE user_id=? AND status='active' LIMIT 1`).get(userId);
    if (next) db.prepare('UPDATE ai_providers SET is_default=1 WHERE id=?').run(next.id);
  }
  return { ok: true };
}

function setDefault(userId, id) {
  const row = db.prepare(`SELECT * FROM ai_providers WHERE id=? AND user_id=? AND status='active'`).get(id, userId);
  if (!row) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
  db.prepare('UPDATE ai_providers SET is_default=0 WHERE user_id=?').run(userId);
  db.prepare('UPDATE ai_providers SET is_default=1, updated_at=? WHERE id=?').run(new Date().toISOString(), id);
  return publicRow(db.prepare('SELECT * FROM ai_providers WHERE id=?').get(id));
}

function setModel(userId, id, model) {
  const row = db.prepare(`SELECT * FROM ai_providers WHERE id=? AND user_id=? AND status='active'`).get(id, userId);
  if (!row) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
  db.prepare('UPDATE ai_providers SET model=?, updated_at=? WHERE id=?').run(String(model).slice(0, 80), new Date().toISOString(), id);
  return publicRow(db.prepare('SELECT * FROM ai_providers WHERE id=?').get(id));
}

/** Decrypt for server-side use only — never log or return. */
function getCredential(userId, id) {
  const row = db.prepare(`SELECT * FROM ai_providers WHERE id=? AND user_id=? AND status='active'`).get(id, userId);
  if (!row) return null;
  return { row, apiKey: decryptSecret(row.api_key_enc) };
}

function getDefaultCredential(userId) {
  const row = db.prepare(`SELECT * FROM ai_providers WHERE user_id=? AND status='active' ORDER BY is_default DESC LIMIT 1`).get(userId);
  if (!row) return null;
  return { row, apiKey: decryptSecret(row.api_key_enc) };
}

/**
 * Test connection. Uses mock in tests when AI_HTTP_MOCK=1.
 * Real HTTP only when AI_HTTP_MOCK is not set and key is real.
 */
async function testConnection(userId, id) {
  const cred = getCredential(userId, id);
  if (!cred) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
  const { row, apiKey } = cred;
  let ok = false;
  let message = '';
  try {
    if (process.env.AI_HTTP_MOCK === '1' || apiKey.startsWith('test_')) {
      ok = !apiKey.includes('invalid');
      message = ok ? 'Mock connection OK' : 'Mock invalid key';
    } else {
      // Minimal live probe — OpenAI-compatible models list where possible
      const base = row.base_url || (PROVIDERS[row.provider] && PROVIDERS[row.provider].baseUrl);
      if (!base) throw new Error('No base URL');
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 12000);
      let res;
      if (row.provider === 'gemini') {
        res = await fetch(`${base}/models?key=${encodeURIComponent(apiKey)}`, { signal: controller.signal });
      } else if (row.provider === 'claude') {
        res = await fetch(`${base}/models`, {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          signal: controller.signal
        });
      } else {
        res = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal
        });
      }
      clearTimeout(t);
      ok = res.ok || res.status === 404; // some providers lack /models
      message = ok ? 'Connected' : `Provider HTTP ${res.status}`;
    }
  } catch (e) {
    ok = false;
    message = e.name === 'AbortError' ? 'Timeout' : (e.message || 'Connection failed');
  }
  db.prepare('UPDATE ai_providers SET last_test_at=?, last_test_ok=?, updated_at=? WHERE id=?')
    .run(new Date().toISOString(), ok ? 1 : 0, new Date().toISOString(), id);
  return { ok, message };
}

/**
 * Ask connected AI for a structured plan (JSON). Falls back to local planner if no provider / mock.
 */
async function requestPlan({ userId, providerId, prompt, dimension }) {
  const tools = require('../ai/tools');
  const local = tools.planFromPrompt ? tools.planFromPrompt(prompt, dimension) : null;

  let cred = null;
  if (providerId) cred = getCredential(userId, providerId);
  else cred = getDefaultCredential(userId);

  if (!cred || process.env.AI_HTTP_MOCK === '1' || (cred.apiKey && cred.apiKey.startsWith('test_'))) {
    return { source: cred ? 'provider-mock' : 'local', plan: local || { template: 'Empty World', steps: [] }, note: 'Local/safe planner used (no live LLM call in test/mock mode).' };
  }

  // Live LLM: request JSON plan only — never execute returned code
  const system = 'You are a Kavryon game design assistant. Reply ONLY with JSON: {"template":"BedWars|Arena|Obby|RPG|Racing|Survival|Empty World","dimension":"2d|3d","summary":"...","steps":[{"tool":"UPDATE_GAME_RULE","args":{}}]}. Tools must be from the allowed Kavryon set. Never include API keys, shell, or filesystem.';
  try {
    const base = cred.row.base_url || (PROVIDERS[cred.row.provider] && PROVIDERS[cred.row.provider].baseUrl);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 25000);
    let text = '';
    if (cred.row.provider === 'claude') {
      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cred.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cred.row.model, max_tokens: 1024, system, messages: [{ role: 'user', content: prompt }] }),
        signal: controller.signal
      });
      clearTimeout(t);
      const j = await res.json();
      text = (j.content && j.content[0] && j.content[0].text) || '';
    } else if (cred.row.provider === 'gemini') {
      const res = await fetch(`${base}/models/${cred.row.model}:generateContent?key=${encodeURIComponent(cred.apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: system + '\n\n' + prompt }] }] }),
        signal: controller.signal
      });
      clearTimeout(t);
      const j = await res.json();
      text = (((j.candidates || [])[0] || {}).content || {}).parts?.[0]?.text || '';
    } else {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${cred.apiKey}` },
        body: JSON.stringify({ model: cred.row.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], temperature: 0.2 }),
        signal: controller.signal
      });
      clearTimeout(t);
      const j = await res.json();
      text = (((j.choices || [])[0] || {}).message || {}).content || '';
    }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const plan = JSON.parse(m[0]);
      return { source: 'provider', plan, raw: undefined };
    }
  } catch (e) {
    return { source: 'local-fallback', plan: local || { template: 'Empty World', steps: [] }, error: e.message };
  }
  return { source: 'local-fallback', plan: local || { template: 'Empty World', steps: [] } };
}

module.exports = {
  assertSafeBaseUrl,
  assertSafeBaseUrlAsync,
  isPrivateIp,
  PROVIDERS,
  listProviders,
  addProvider,
  removeProvider,
  setDefault,
  setModel,
  testConnection,
  requestPlan,
  getCredential,
  publicRow,
  assertSafeBaseUrl,
  encryptSecret,
  decryptSecret
};
