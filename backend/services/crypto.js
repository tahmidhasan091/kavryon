const crypto = require('crypto');

function uuid() {
  return crypto.randomUUID();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt:')) return false;
  const parts = stored.split(':');
  const salt = parts[1];
  const hash = parts[2];
  const check = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

module.exports = { uuid, hashPassword, verifyPassword };
