const { uuid } = require('./crypto');
const db = require('../database/db');
const wallet = require('./wallet');
const { isOwner } = require('./security');

function audit(actorId, action, targetId, amount, reason, meta) {
  db.prepare(
    `INSERT INTO audit_log (id, actor_user_id, action, target_user_id, amount, reason, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), actorId || null, action, targetId || null, amount ?? null, reason || null, JSON.stringify(meta || {}), new Date().toISOString());
}

function requireOwner(user) {
  if (!user || !isOwner(user.id)) {
    const e = new Error('FORBIDDEN');
    e.code = 'FORBIDDEN';
    e.status = 403;
    throw e;
  }
}

/**
 * Owner-only Kavx commands. Server decides authority via OWNER_USER_ID.
 * Normal users always get 403.
 */
function grant(actor, username, amount, reason) {
  requireOwner(actor);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) {
    const e = new Error('Invalid amount');
    e.code = 'INVALID';
    throw e;
  }
  const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').replace(/^@/, ''));
  if (!target) {
    const e = new Error('User not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const txId = wallet.credit(target.id, amount, 'OWNER_GRANT', null, reason || 'owner command');
  audit(actor.id, 'OWNER_GRANT', target.id, amount, reason || 'owner command', { txId, username: target.username });
  return { balance: wallet.getBalance(target.id), username: target.username, amount, txId };
}

function grantSelf(actor, amount, reason) {
  requireOwner(actor);
  return grant(actor, actor.username, amount, reason || 'owner grant-self');
}

function revoke(actor, username, amount, reason) {
  requireOwner(actor);
  if (!Number.isInteger(amount) || amount <= 0) {
    const e = new Error('Invalid amount');
    e.code = 'INVALID';
    throw e;
  }
  const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').replace(/^@/, ''));
  if (!target) {
    const e = new Error('User not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const result = wallet.debit(target.id, amount, 'OWNER_REVOKE', reason || 'owner revoke');
  audit(actor.id, 'OWNER_REVOKE', target.id, amount, reason || 'owner revoke', { txId: result.id });
  return { balance: result.balance, username: target.username, amount };
}

function balanceOf(actor, username) {
  requireOwner(actor);
  const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').replace(/^@/, ''));
  if (!target) {
    const e = new Error('User not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  return { username: target.username, balance: wallet.getBalance(target.id) };
}

function historyOf(actor, username) {
  requireOwner(actor);
  const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').replace(/^@/, ''));
  if (!target) {
    const e = new Error('User not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  return { username: target.username, transactions: wallet.history(target.id, 50, 0) };
}

function parseCommand(text) {
  const parts = String(text || '').trim().split(/\s+/);
  if (!parts[0] || parts[0].toLowerCase() !== '/kavx') return null;
  const sub = (parts[1] || '').toLowerCase();
  return { sub, args: parts.slice(2) };
}

function runCommand(actor, text) {
  const cmd = parseCommand(text);
  if (!cmd) {
    const e = new Error('Unknown command');
    e.code = 'UNKNOWN';
    throw e;
  }
  if (cmd.sub === 'grant-self') {
    return { action: 'grant-self', result: grantSelf(actor, Number(cmd.args[0]), cmd.args.slice(1).join(' ') || 'grant-self') };
  }
  if (cmd.sub === 'grant') {
    return { action: 'grant', result: grant(actor, cmd.args[0], Number(cmd.args[1]), cmd.args.slice(2).join(' ') || 'owner grant') };
  }
  if (cmd.sub === 'revoke') {
    return { action: 'revoke', result: revoke(actor, cmd.args[0], Number(cmd.args[1]), cmd.args.slice(2).join(' ') || 'owner revoke') };
  }
  if (cmd.sub === 'balance') {
    return { action: 'balance', result: balanceOf(actor, cmd.args[0] || actor.username) };
  }
  if (cmd.sub === 'history') {
    return { action: 'history', result: historyOf(actor, cmd.args[0] || actor.username) };
  }
  const e = new Error('Unknown /kavx subcommand');
  e.code = 'UNKNOWN';
  throw e;
}

module.exports = { grant, grantSelf, revoke, balanceOf, historyOf, runCommand, requireOwner, audit };
