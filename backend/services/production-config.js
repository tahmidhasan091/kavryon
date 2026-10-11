/** Fail-closed production configuration checks shared by startup and release tooling. */
const fs = require('fs');
const path = require('path');

function validate(env = process.env) {
  const issues = [];
  if (env.NODE_ENV !== 'production') return issues;

  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || env.JWT_SECRET === 'CHANGE_ME_DEV_ONLY' || env.JWT_SECRET.includes('CHANGE_ME')) {
    issues.push('JWT_SECRET must be a unique secret of at least 32 characters');
  }
  if (env.SANDBOX_PAYMENTS === 'true' && env.ALLOW_SANDBOX_IN_PRODUCTION !== 'true') {
    issues.push('SANDBOX_PAYMENTS must be false in production');
  }

  const db = env.KAVRYON_DB || env.VYNTRIX_DB || '';
  if (!db || path.resolve(db).startsWith(path.resolve('/tmp') + path.sep) || path.resolve(db) === path.resolve('/tmp')) {
    issues.push('KAVRYON_DB must point to persistent storage outside /tmp');
  }

  const origins = String(env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (origins.includes('*')) issues.push('ALLOWED_ORIGINS must not use wildcard origins in production');
  const httpsOrigins = origins.filter((origin) => {
    try {
      const u = new URL(origin);
      return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password && !u.pathname.replace(/^\/$/, '') && !u.search && !u.hash;
    } catch { return false; }
  });
  if (!httpsOrigins.length) issues.push('ALLOWED_ORIGINS must include at least one exact production HTTPS origin');
  if (!origins.includes('https://appassets.androidplatform.net')) {
    issues.push('ALLOWED_ORIGINS must include https://appassets.androidplatform.net for the Android WebView app origin');
  }

  const pkg = env.GOOGLE_PLAY_PACKAGE || 'com.kavryon.platform';
  if (pkg !== 'com.kavryon.platform') issues.push('GOOGLE_PLAY_PACKAGE must match Android applicationId com.kavryon.platform');
  if (env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    try {
      const creds = JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
      if (!creds.client_email || !creds.private_key || creds.type !== 'service_account') {
        issues.push('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must contain valid service-account credentials');
      }
    } catch { issues.push('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must be valid JSON'); }
  } else if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (!fs.existsSync(env.GOOGLE_APPLICATION_CREDENTIALS) || !fs.statSync(env.GOOGLE_APPLICATION_CREDENTIALS).isFile()) {
      issues.push('GOOGLE_APPLICATION_CREDENTIALS must point to an existing service-account JSON file');
    }
  } else {
    issues.push('Google Play verification requires GOOGLE_PLAY_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS');
  }

  if (env.MULTIPLAYER_REQUIRE_REDIS === 'true') {
    if (env.MULTIPLAYER_MODE !== 'redis' || !env.REDIS_URL) {
      issues.push('MULTIPLAYER_REQUIRE_REDIS=true requires MULTIPLAYER_MODE=redis and REDIS_URL');
    }
    try { require.resolve('ioredis'); } catch { issues.push('Redis multiplayer is configured but ioredis is not installed'); }
  }

  return issues;
}

function assertProductionConfig(env = process.env) {
  const issues = validate(env);
  if (issues.length) {
    const error = new Error('Production configuration invalid:\n - ' + issues.join('\n - '));
    error.code = 'PRODUCTION_CONFIG_INVALID';
    throw error;
  }
  return true;
}

module.exports = { validate, assertProductionConfig };
