const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
// Validate production secrets/storage/origins/payment verification before opening DB or listening.
if (process.env.NODE_ENV === 'production') {
  require('./services/production-config').assertProductionConfig(process.env);
}
const db = require('./database/db');
require('./database/seed');
const { createApp, jwtSign, jwtVerify, staticHandler, acceptWebSocket } = require('./core/mini');
const { hashPassword, verifyPassword, uuid } = require('./services/crypto');
const wallet = require('./services/wallet');
const { KAVX_PACKAGES, DEVELOPER_MODE_COST, getPackage } = require('./services/products');
const gifts = require('./services/gifts');
const rewards = require('./services/rewards');
const ownerSvc = require('./services/owner');
const sessions = require('./services/sessions');
const { rateLimit, clientIp, applyCors, isOwner, shortTicket, parseTicket } = require('./services/security');
const { grantVerifiedPurchase, mintSandboxToken, parseSandboxToken, completeGooglePlayPurchase, revokePurchase } = require('./payments/verify');
const rooms = require('./multiplayer/rooms');
const templates = require('./engine/templates');
const aiTools = require('./ai/tools');
const aiProviders = require('./services/ai_providers');
const platform = require('./services/platform');
const gamepasses = require('./services/gamepasses');
try { gamepasses.ensureTables(); } catch(_){}
try { platform.ensureTables(); } catch(_){}
const publishSvc = require('./services/publish');
const collab = require('./services/collab');
const invites = require('./services/invites');
invites.ensureTable();
publishSvc.ensurePublishColumns();
const { sanitizeDefinition, objectsToLegacyRows } = require('./engine/definition');
const presence = require('./multiplayer/presence');
const { createConnectionLimiter } = require('./services/connection-limit');
function requireSecret() {
  const s = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    if (!s || s === 'CHANGE_ME_DEV_ONLY' || s.length < 32) {
      console.error('FATAL: JWT_SECRET must be set to a strong value in production');
      process.exit(1);
    }
  }
  return s || 'CHANGE_ME_DEV_ONLY';
}
const SECRET = requireSecret();
const RESERVED = new Set(['admin','vyntrix','kavryon','system','moderator','support','official','kavx']);
const BODY_LIMIT = Number(process.env.JSON_BODY_LIMIT || 524288);

function publicUser(id) {
  const u = db.prepare('SELECT id, username, display_name, avatar_id, developer_mode, status, role, created_at FROM users WHERE id = ?').get(id);
  if (!u) return null;
  const w = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(id);
  const p = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(id);
  const bal = w ? w.balance : 0;
  return { ...u, developer_mode: !!u.developer_mode, kavx: bal, isOwner: isOwner(u.id), profile: p };
}
function auth(req, res, opts={}) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Login required' }); return null; }
  try {
    let payload;
    try { payload = sessions.verifyAccess(token); }
    catch (e) {
      if (e.code === 'REVOKED' || e.code === 'EXPIRED') { res.status(401).json({ error: e.message }); return null; }
      payload = jwtVerify(token, SECRET);
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) { res.status(401).json({ error: 'Account unavailable' }); return null; }
    if (!opts.allowSuspended && user.status !== 'active') { res.status(403).json({ error: 'Account suspended' }); return null; }
    req.authPayload = payload;
    return user;
  } catch { res.status(401).json({ error: 'Login expired' }); return null; }
}
function rl(req, res, key, opts) {
  try { rateLimit(key + ':' + clientIp(req), opts); return true; }
  catch (e) { res.status(429).json({ error: e.message, code: 'RATE_LIMIT' }); return false; }
}
function sanitizeThumb(t) {
  if (!t || typeof t !== 'string') return '';
  t = t.trim();
  if (t.includes('..') || t.includes('<') || t.includes('javascript:')) return '';
  if (t.startsWith('data:image/png') || t.startsWith('data:image/jpeg') || t.startsWith('data:image/webp') || t.startsWith('data:image/gif')) {
    if (t.length <= 200000) return t.slice(0, 200000);
    return '';
  }
  // block data:image/svg+xml (script risk)
  if (t.startsWith('data:image/svg')) return '';
  if ((t.startsWith('/assets/') || t.startsWith('assets/')) && !t.includes('..')) return t.slice(0, 200);
  return '';
}
function canAccessGame(user, g) {
  if (!g) return false;
  if (g.state === 'PUBLISHED') return true;
  if (g.state === 'SUSPENDED' || g.state === 'REMOVED') return false;
  if (user && (g.creator_id === user.id || user.role === 'admin' || isOwner(user.id))) return true;
  if (user && collab.canView(g.id, user.id)) return true;
  return false;
}
function withLive(g) {
  const sv = db.prepare('SELECT * FROM game_servers WHERE game_id = ?').all(g.id).map(s => ({ ...s, players: rooms.count(s.id), full: rooms.count(s.id) >= s.max_players }));
  return { ...g, currentPlayers: sv.reduce((n,s)=>n+s.players,0), servers: sv };
}

const app = createApp();
app.use((req, res, next) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  next();
});

app.get('/api/health', (_q,r)=>r.json({ ok:true, name:'Kavryon' }));

app.post('/api/auth/signup', (req,res) => {
  if (!rl(req,res,'signup',{max:8})) return;
  const { username, password, displayName } = req.body||{};
  if (!username || username.length<3||username.length>20||!/^[A-Za-z0-9_]+$/.test(username)||RESERVED.has(username.toLowerCase()))
    return res.status(400).json({ error:'Invalid username' });
  if (!password || String(password).length<8) return res.status(400).json({ error:'Password must be at least 8 characters' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(409).json({ error:'Username taken' });
  const id = uuid(), now = new Date().toISOString();
  db.transaction(()=>{
    db.prepare(`INSERT INTO users (id, username, password_hash, display_name, avatar_id, developer_mode, created_at) VALUES (?, ?, ?, ?, 'default', 1, ?)`).run(id, username, hashPassword(password), (displayName||username).slice(0,32), now);
    db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(id);
    db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 0)').run(id);
  })();
  const sess = sessions.createSession(id);
  res.json({ token: sess.accessToken, refreshToken: sess.refreshToken, expiresIn: sess.expiresIn, user: publicUser(id) });
});

app.post('/api/auth/login', (req,res) => {
  if (!rl(req,res,'login',{max:12})) return;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.body.username||'');
  if (!user || !verifyPassword(req.body.password||'', user.password_hash)) return res.status(401).json({ error:'Invalid credentials' });
  if (user.status !== 'active') return res.status(403).json({ error:'Account suspended' });
  const sess = sessions.createSession(user.id);
  res.json({ token: sess.accessToken, refreshToken: sess.refreshToken, expiresIn: sess.expiresIn, user: publicUser(user.id) });
});
app.post('/api/auth/refresh', (req,res) => {
  try { const sess = sessions.refreshSession(req.body.refreshToken); res.json({ token: sess.accessToken, refreshToken: sess.refreshToken, expiresIn: sess.expiresIn }); }
  catch(e){ res.status(401).json({ error:e.message }); }
});
app.post('/api/auth/logout', (req,res) => {
  const u = auth(req,res,{allowSuspended:true}); if (!u) return;
  if (req.authPayload && req.authPayload.jti) sessions.revokeByJti(req.authPayload.jti);
  res.json({ ok:true });
});
app.post('/api/auth/password-reset/request', (req,res) => {
  if (!rl(req,res,'pwreset',{max:5})) return;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.body.username||'');
  if (user) {
    const raw = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    db.prepare(`INSERT INTO password_resets (id, user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)`).run(uuid(), user.id, tokenHash, new Date(Date.now()+3600000).toISOString(), new Date().toISOString());
    if (process.env.NODE_ENV!=='production' && process.env.SANDBOX_PAYMENTS==='true') return res.json({ ok:true, devResetToken: raw });
  }
  res.json({ ok:true });
});
app.post('/api/auth/password-reset/confirm', (req,res) => {
  if (!rl(req,res,'pwresetc',{max:5})) return;
  const tokenHash = crypto.createHash('sha256').update(String(req.body.token||'')).digest('hex');
  const row = db.prepare(`SELECT * FROM password_resets WHERE token_hash = ? AND used = 0`).get(tokenHash);
  if (!row || new Date(row.expires_at) < new Date()) return res.status(400).json({ error:'Invalid or expired token' });
  if (!req.body.password || String(req.body.password).length<8) return res.status(400).json({ error:'Password too short' });
  db.transaction(()=>{
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), row.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
    sessions.revokeAllForUser(row.user_id);
  })();
  res.json({ ok:true });
});
app.get('/api/auth/me', (req,res) => { const u=auth(req,res); if(!u)return; res.json({ user: publicUser(u.id) }); });

app.get('/api/users/search', (req,res) => {
  const u=auth(req,res); if(!u)return;
  let q=String(req.query.username||'').replace(/^@/,'').trim();
  if (q.length<2) return res.json({ users:[] });
  res.json({ users: db.prepare(`SELECT id, username, display_name, avatar_id FROM users WHERE username LIKE ? AND status='active' LIMIT 20`).all('%'+q+'%') });
});
app.put('/api/users/me/profile', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const p=req.body||{};
  if (p.display_name) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(p.display_name).slice(0,32), u.id);
  const cur=db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(u.id)||{};
  const next={...cur};
  for (const k of ['bio','body','head','hair','face','outfit','accessory']) if (p[k]!==undefined) next[k]=String(p[k]).slice(0,80);
  db.prepare(`UPDATE profiles SET bio=?, body=?, head=?, hair=?, face=?, outfit=?, accessory=? WHERE user_id=?`).run(next.bio,next.body,next.head,next.hair,next.face,next.outfit,next.accessory,u.id);
  res.json({ user: publicUser(u.id) });
});

app.get('/api/friends', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const friends=db.prepare(`SELECT users.id, users.username, users.display_name, users.avatar_id FROM friends JOIN users ON users.id=friends.friend_id WHERE friends.user_id=?`).all(u.id).map(f=>({...f, presence: presence.get(f.id)}));
  const incoming=db.prepare(`SELECT friend_requests.id, users.id as user_id, users.username, users.display_name FROM friend_requests JOIN users ON users.id=friend_requests.from_user_id WHERE friend_requests.to_user_id=? AND friend_requests.status='pending'`).all(u.id);
  const outgoing=db.prepare(`SELECT friend_requests.id, users.id as user_id, users.username, users.display_name FROM friend_requests JOIN users ON users.id=friend_requests.to_user_id WHERE friend_requests.from_user_id=? AND friend_requests.status='pending'`).all(u.id);
  res.json({ friends, incoming, outgoing });
});
app.post('/api/friends/request', (req,res) => {
  if (!rl(req,res,'friend',{max:20})) return;
  const u=auth(req,res); if(!u)return;
  const target=db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username||'').replace(/^@/,''));
  if (!target||target.status!=='active') return res.status(404).json({ error:'User not found' });
  if (target.id===u.id) return res.status(400).json({ error:'Cannot add yourself' });
  if (db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(target.id,u.id,u.id,target.id))
    return res.status(403).json({ error:'Cannot send request' });
  if (db.prepare('SELECT 1 FROM friends WHERE user_id=? AND friend_id=?').get(u.id,target.id)) return res.status(409).json({ error:'Already friends' });
  if (db.prepare(`SELECT 1 FROM friend_requests WHERE from_user_id=? AND to_user_id=? AND status='pending'`).get(u.id,target.id))
    return res.json({ status:'pending', message:'Friend Request Sent' });
  const pendingIn=db.prepare(`SELECT * FROM friend_requests WHERE from_user_id=? AND to_user_id=? AND status='pending'`).get(target.id,u.id);
  if (pendingIn) {
    const now=new Date().toISOString();
    db.transaction(()=>{
      db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?,?,?)').run(u.id,target.id,now);
      db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?,?,?)').run(target.id,u.id,now);
      db.prepare(`UPDATE friend_requests SET status='accepted' WHERE id=?`).run(pendingIn.id);
    })();
    return res.json({ status:'accepted' });
  }
  db.prepare(`INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at) VALUES (?,?,?,'pending',?)`).run(uuid(),u.id,target.id,new Date().toISOString());
  res.json({ status:'pending', message:'Friend Request Sent' });
});
app.post('/api/friends/accept', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const row=db.prepare(`SELECT * FROM friend_requests WHERE id=? AND to_user_id=? AND status='pending'`).get(req.body.requestId,u.id);
  if (!row) return res.status(404).json({ error:'Request not found' });
  const now=new Date().toISOString();
  db.transaction(()=>{
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?,?,?)').run(row.from_user_id,row.to_user_id,now);
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?,?,?)').run(row.to_user_id,row.from_user_id,now);
    db.prepare(`UPDATE friend_requests SET status='accepted' WHERE id=?`).run(row.id);
  })();
  res.json({ ok:true });
});
app.post('/api/friends/decline', (req,res) => {
  const u=auth(req,res); if(!u)return;
  db.prepare(`UPDATE friend_requests SET status='declined' WHERE id=? AND to_user_id=?`).run(req.body.requestId,u.id);
  res.json({ ok:true });
});
app.post('/api/friends/remove', (req,res) => {
  const u=auth(req,res); if(!u)return;
  db.prepare('DELETE FROM friends WHERE user_id=? AND friend_id=?').run(u.id,req.body.userId);
  db.prepare('DELETE FROM friends WHERE user_id=? AND friend_id=?').run(req.body.userId,u.id);
  res.json({ ok:true });
});

app.get('/api/wallet', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ balance: wallet.getBalance(u.id), currency:'KAVX', currencyDisplay:'Kavx', transactions: wallet.history(u.id,50,Number(req.query.offset)||0), purchases: db.prepare('SELECT id, provider, product_id, status, verified_at, created_at FROM purchases WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(u.id), gifts: gifts.history(u.id,20,0) });
});
app.get('/api/wallet/packages', (req,res) => { if(!auth(req,res))return; res.json({ packages: KAVX_PACKAGES.map(p=>({productId:p.productId,amount:p.amount,label:p.label,kavx:p.amount})), currency:'KAVX' }); });
app.post('/api/wallet/purchase/intent', (req,res) => {
  if (!rl(req,res,'purchase',{max:15})) return;
  const u=auth(req,res); if(!u)return;
  const pack=getPackage(req.body.productId);
  if (!pack) return res.status(400).json({ error:'Unknown package' });
  const sandboxOn = process.env.SANDBOX_PAYMENTS === 'true' && !(process.env.NODE_ENV === 'production' && process.env.ALLOW_SANDBOX_IN_PRODUCTION !== 'true');
  res.json({
    mode: sandboxOn ? 'sandbox' : 'play_billing',
    productId: pack.productId,
    amount: pack.amount,
    kavx: pack.amount,
    packageName: process.env.GOOGLE_PLAY_PACKAGE || 'com.kavryon.platform',
    sandboxToken: sandboxOn ? mintSandboxToken(u.id, pack.productId) : undefined
  });
});
app.post('/api/wallet/purchase/complete', async (req,res) => {
  if (!rl(req,res,'purchasec',{max:15})) return;
  const u=auth(req,res); if(!u)return;
  const body = req.body || {};
  try {
    // Production Google Play path
    if (body.purchaseToken && body.productId && process.env.SANDBOX_PAYMENTS !== 'true') {
      const result = await completeGooglePlayPurchase({
        userId: u.id,
        productId: String(body.productId),
        purchaseToken: String(body.purchaseToken),
        packageName: body.packageName || process.env.GOOGLE_PLAY_PACKAGE
      });
      return res.json(result);
    }
    // Sandbox path (explicitly enabled)
    if (process.env.SANDBOX_PAYMENTS === 'true' && body.sandboxToken) {
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SANDBOX_IN_PRODUCTION !== 'true') {
        return res.status(403).json({ error: 'Sandbox purchases disabled in production' });
      }
      const parsed = parseSandboxToken(body.sandboxToken);
      if (!parsed || parsed.userId !== u.id) return res.status(400).json({ error: 'Invalid purchase token' });
      return res.json(grantVerifiedPurchase({
        userId: u.id,
        productId: parsed.productId,
        provider: 'sandbox',
        providerTransactionId: parsed.providerTransactionId,
        receipt: body.sandboxToken
      }));
    }
    if (process.env.SANDBOX_PAYMENTS !== 'true') {
      return res.status(400).json({ error: 'purchaseToken and productId required for Google Play verification' });
    }
    return res.status(400).json({ error: 'sandboxToken required in sandbox mode' });
  } catch (e) {
    const code = e.code === 'NOT_CONFIGURED' || e.code === 'MISSING_DEP' ? 503
      : e.code === 'PENDING' ? 202
      : e.code === 'CANCELLED' || e.code === 'PRODUCT_MISMATCH' || e.code === 'UNKNOWN_PRODUCT' ? 400
      : 400;
    res.status(code).json({ error: e.message, code: e.code });
  }
});
app.post('/api/wallet/developer-mode', (req,res) => {
  const u=auth(req,res); if(!u)return;
  // Creator Mode is FREE for all registered users
  if (!u.developer_mode) {
    db.prepare('UPDATE users SET developer_mode=1 WHERE id=?').run(u.id);
  }
  res.json({ already: true, developer_mode: true, free: true, balance: wallet.getBalance(u.id), note: 'Creator Mode is free for all users' });
});

app.post('/api/owner/command', (req,res) => {
  const u=auth(req,res); if(!u)return;
  if (!isOwner(u.id)) return res.status(403).json({ error:'FORBIDDEN' });
  try { res.json({ ok:true, ...ownerSvc.runCommand(u, req.body.command||'') }); }
  catch(e){ res.status(e.status||400).json({ error:e.message, code:e.code }); }
});

app.post('/api/gifts/send', (req,res) => {
  if (!rl(req,res,'gift',{max:20})) return;
  const u=auth(req,res); if(!u)return;
  try {
    const amt = Math.floor(Number(req.body.amount));
    if (!Number.isInteger(amt) || amt < 1) return res.status(400).json({ error: 'Invalid amount', code: 'INVALID_AMOUNT' });
    const result=gifts.sendGift({ senderId:u.id, recipientUsername:req.body.username||req.body.recipient, amount:amt, idempotencyKey:req.body.idempotencyKey||req.headers['idempotency-key'] });
    res.json({ ok:true, message:'Kavx gift sent successfully.', ...result });
  } catch(e){ res.status(e.code==='NOT_FOUND'?404:400).json({ error:e.message, code:e.code }); }
});
app.get('/api/gifts/history', (req,res) => { const u=auth(req,res); if(!u)return; res.json({ gifts: gifts.history(u.id, Number(req.query.limit)||20, Number(req.query.offset)||0) }); });

app.get('/api/invites/friends', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ friends: invites.listFriendsForInvite(u.id) });
});
app.post('/api/invites', (req,res) => {
  if (!rl(req,res,'invite',{max:20})) return;
  const u=auth(req,res); if(!u)return;
  try {
    const r = invites.sendInvite({
      senderId: u.id,
      receiverUsername: req.body.username,
      gameId: req.body.gameId,
      serverId: req.body.serverId
    });
    res.json(r);
  } catch(e) {
    const code = e.code==='NOT_FOUND'?404:e.code==='FORBIDDEN'?403:400;
    res.status(code).json({ error: e.message, code: e.code });
  }
});
app.post('/api/invites/:id/respond', (req,res) => {
  if (!rl(req,res,'invite',{max:30})) return;
  const u=auth(req,res); if(!u)return;
  try {
    const r = invites.respondInvite({ userId: u.id, inviteId: req.params.id, action: req.body.action });
    if (r.status === 'ACCEPTED' && r.gameId && r.serverId) {
      const ticket = shortTicket({ sub:u.id, game:r.gameId, server:r.serverId }, SECRET, 90);
      const th = crypto.createHash('sha256').update(ticket).digest('hex');
      db.prepare(`INSERT INTO ws_tickets (ticket_hash, user_id, game_id, server_id, expires_at, used) VALUES (?,?,?,?,?,0)`)
        .run(th, u.id, r.gameId, r.serverId, new Date(Date.now()+90000).toISOString());
      r.ticket = ticket;
      r.wsPath = '/ws';
    }
    res.json(r);
  } catch(e) {
    const code = e.code==='FORBIDDEN'?403:e.code==='NOT_FOUND'?404:e.code==='FULL'?409:e.code==='NOT_FRIENDS'?403:400;
    res.status(code).json({ error: e.message, code: e.code });
  }
});

app.get('/api/notifications', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const rows=db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(u.id);
  const unread=db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id=? AND read=0').get(u.id).c;
  res.json({ notifications: rows, unread });
});
app.post('/api/notifications/read', (req,res) => {
  const u=auth(req,res); if(!u)return;
  if (req.body.id) db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(req.body.id,u.id);
  else db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(u.id);
  res.json({ ok:true });
});

app.get('/api/templates', (req,res) => {
  res.json({ templates: templates.list() });
});
app.get('/api/games/:id/definition', (req,res) => {
  const u=auth(req,res); if (!u) return;
  const row=db.prepare('SELECT definition_json FROM game_definitions WHERE game_id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error:'No definition' });
  res.json({ definition: JSON.parse(row.definition_json) });
});
app.put('/api/games/:id/definition', (req,res) => {
  const u=auth(req,res); if (!u) return;
  const g=db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!g||!collab.canEdit(g.id,u.id)) return res.status(403).json({ error:'Forbidden' });
  if (g.state==='PUBLISHED') return res.status(400).json({ error:'Unpublish/edit draft to change definition' });
  const def=sanitizeDefinition(req.body.definition||req.body);
  const now=new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`).run(g.id, JSON.stringify(def), now);
  db.prepare('DELETE FROM game_objects WHERE game_id=?').run(g.id);
  for (const row of objectsToLegacyRows(g.id, def.objects)) {
    db.prepare(`INSERT INTO game_objects (id,game_id,type,name,x,y,scale_x,scale_y,rotation,collision,visibility,props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id,g.id,row.type,row.name||row.type,row.x,row.y,row.scale_x,row.scale_y,row.rotation,row.collision,row.visibility,row.props_json);
  }
  res.json({ ok:true, definition:def });
});


app.get('/api/studio/ai/providers/catalog', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ providers: Object.entries(aiProviders.PROVIDERS).map(([id,v]) => ({ id, name: v.name, models: v.models, needsBaseUrl: id==='custom' })) });
});
app.get('/api/studio/ai/providers', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ providers: aiProviders.listProviders(u.id) });
});
app.post('/api/studio/ai/providers', (req,res) => {
  if (!rl(req,res,'ai_prov',{max:20})) return;
  const u=auth(req,res); if(!u)return;
  try {
    const r = aiProviders.addProvider({
      userId: u.id,
      provider: String(req.body.provider||''),
      apiKey: String(req.body.apiKey||''),
      model: req.body.model,
      label: req.body.label,
      baseUrl: req.body.baseUrl
    });
    res.json({ provider: r });
  } catch(e) {
    const code = e.code==='NO_ENC_KEY'?503:e.code==='SSRF'?400:400;
    res.status(code).json({ error: e.message, code: e.code });
  }
});
app.delete('/api/studio/ai/providers/:id', (req,res) => {
  const u=auth(req,res); if(!u)return;
  try { res.json(aiProviders.removeProvider(u.id, req.params.id)); }
  catch(e) { res.status(e.code==='NOT_FOUND'?404:400).json({ error:e.message }); }
});
app.post('/api/studio/ai/providers/:id/default', (req,res) => {
  const u=auth(req,res); if(!u)return;
  try { res.json({ provider: aiProviders.setDefault(u.id, req.params.id) }); }
  catch(e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/studio/ai/providers/:id/test', async (req,res) => {
  if (!rl(req,res,'ai_test',{max:10})) return;
  const u=auth(req,res); if(!u)return;
  try { res.json(await aiProviders.testConnection(u.id, req.params.id)); }
  catch(e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/studio/ai/plan', async (req,res) => {
  if (!rl(req,res,'ai_plan',{max:15})) return;
  const u=auth(req,res); if(!u)return;
  const gameId = String(req.body.gameId||'');
  const g = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!g || !collab.canView(g.id, u.id)) return res.status(403).json({ error:'Not your game' });
  try {
    const out = await aiProviders.requestPlan({
      userId: u.id,
      providerId: req.body.providerId || null,
      prompt: String(req.body.prompt||'').slice(0,4000),
      dimension: req.body.dimension==='3d'?'3d':'2d'
    });
    res.json(out);
  } catch(e) { res.status(400).json({ error:e.message }); }
});

app.get('/api/studio/ai/tools', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ tools: [...aiTools.ALLOWED_TOOLS], note: 'AI tools only mutate owned game definitions. No wallet/admin access.' });
});
app.post('/api/studio/ai/tool', (req,res) => {
  if (!rl(req,res,'ai',{max:40})) return;
  const u=auth(req,res); if(!u)return;
  const gameId = String(req.body.gameId||'');
  const tool = String(req.body.tool||'');
  const args = req.body.args && typeof req.body.args==='object' ? req.body.args : {};
  try {
    const result = aiTools.runTool(u.id, gameId, tool, args);
    if (result.error==='FORBIDDEN'||result.error==='TOOL_NOT_ALLOWED'||result.error==='FORBIDDEN_ARGS') return res.status(403).json(result);
    if (result.error==='NOT_FOUND') return res.status(404).json(result);
    res.json(result);
  } catch(e) {
    res.status(e.code==='FORBIDDEN'?403:400).json({ error: e.message, code: e.code });
  }
});
app.post('/api/studio/ai/build', async (req,res) => {
  if (!rl(req,res,'ai_build',{max:10})) return;
  const u=auth(req,res); if(!u)return;
  const gameId = String(req.body.gameId||'');
  const prompt = String(req.body.prompt||'').slice(0, 500);
  const dimension = req.body.dimension==='3d'?'3d':'2d';
  if (!prompt) return res.status(400).json({ error:'Prompt required' });
  try {
    let out;
    if (aiTools.buildFromPromptAsync) {
      out = await aiTools.buildFromPromptAsync(u.id, gameId, prompt, dimension, req.body.providerId || null);
    } else {
      out = aiTools.buildFromPrompt(u.id, gameId, prompt, dimension);
    }
    res.json(out);
  } catch(e) {
    res.status(e.code==='FORBIDDEN'?403:400).json({ error: e.message, code: e.code });
  }
});

app.get('/api/games/discover', (req,res) => {
  if (!auth(req,res)) return;
  const cats=['Adventure','Horror','Survival','Racing','Simulator','Strategy','RPG','Puzzle','Platform','Casual','Arena','BedWars'];
  const cat=req.query.category?String(req.query.category):null;
  const base=`SELECT games.*, users.username as creator FROM games JOIN users ON users.id=games.creator_id WHERE games.state='PUBLISHED'`;
  const catClause = cat ? ' AND games.category=?' : '';
  const args = cat ? [cat] : [];
  // New & Just Published — by published_at / updated when published
  const newest=db.prepare(base+catClause+` ORDER BY COALESCE(games.published_at, games.updated_at) DESC LIMIT 24`).all(...args).map(withLive);
  // Popular — plays
  const popular=db.prepare(base+catClause+` ORDER BY games.plays DESC, games.likes DESC LIMIT 24`).all(...args).map(withLive);
  // Trending — engagement heuristic
  const trending=db.prepare(base+catClause+` ORDER BY (games.plays * 1 + games.likes * 3) DESC, COALESCE(games.published_at, games.updated_at) DESC LIMIT 24`).all(...args).map(withLive);
  // Recommended — mix of mid plays + likes
  const recommended=db.prepare(base+catClause+` ORDER BY games.likes DESC, games.plays DESC LIMIT 24`).all(...args).map(withLive);
  // All paginated
  const page=Math.max(1,Number(req.query.page)||1);
  const limit=Math.min(40,Math.max(1,Number(req.query.limit)||20));
  const offset=(page-1)*limit;
  const all=db.prepare(base+catClause+` ORDER BY COALESCE(games.published_at, games.created_at) DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(withLive);
  const total=db.prepare(`SELECT COUNT(*) as c FROM games WHERE state='PUBLISHED'`+(cat?' AND category=?':'')).get(...(cat?[cat]:[])).c;
  res.json({
    newest,
    trending,
    popular,
    recommended,
    all,
    page,
    limit,
    total,
    games: newest.length ? newest : popular, // backward compat for old clients
    categories: cats
  });
});
app.get('/api/games/feed/new', (req,res) => {
  if (!auth(req,res)) return;
  const games=db.prepare(`SELECT games.*, users.username as creator FROM games JOIN users ON users.id=games.creator_id WHERE games.state='PUBLISHED' ORDER BY COALESCE(games.published_at, games.updated_at) DESC LIMIT 40`).all().map(withLive);
  res.json({ games, section: 'new' });
});
app.get('/api/games/search', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const q=String(req.query.q||'').trim().slice(0,64);
  const page=Math.max(1,Number(req.query.page)||1);
  const limit=Math.min(30,Math.max(1,Number(req.query.limit)||20));
  const offset=(page-1)*limit;
  if (q.length<1) return res.json({ games:[], page, limit });
  const like='%'+q+'%';
  const games=db.prepare(`SELECT games.*, users.username as creator FROM games JOIN users ON users.id=games.creator_id WHERE games.state='PUBLISHED' AND (games.name LIKE ? OR games.description LIKE ? OR games.category LIKE ? OR users.username LIKE ?) ORDER BY games.plays DESC LIMIT ? OFFSET ?`).all(like,like,like,like,limit,offset).map(withLive);
  res.json({ games, page, limit });
});
app.get('/api/games/mine', (req,res) => { const u=auth(req,res); if(!u)return; res.json({ games: db.prepare('SELECT * FROM games WHERE creator_id=?').all(u.id) }); });
app.get('/api/games/:id', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const g=db.prepare(`SELECT games.*, users.username as creator FROM games JOIN users ON users.id=games.creator_id WHERE games.id=?`).get(req.params.id);
  if (!g||!canAccessGame(u,g)) return res.status(404).json({ error:'Game not found' });
  const versions=db.prepare('SELECT id, version, created_at, publisher_id FROM game_versions WHERE game_id=? ORDER BY version DESC LIMIT 20').all(g.id);
  const defRow=db.prepare('SELECT definition_json FROM game_definitions WHERE game_id=?').get(g.id);
  let dimension='2d';
  try { if (defRow) dimension = JSON.parse(defRow.definition_json).dimension||'2d'; } catch(_){}
  const liked=!!db.prepare('SELECT 1 FROM game_likes WHERE game_id=? AND user_id=?').get(g.id,u.id);
  const fav=!!db.prepare('SELECT 1 FROM favorites WHERE game_id=? AND user_id=?').get(g.id,u.id);
  res.json({
    game: { ...withLive(g), dimension, published_at: g.published_at||null, published_version: g.published_version||g.version, liked, favorited: fav },
    objects: db.prepare('SELECT * FROM game_objects WHERE game_id=?').all(g.id),
    scripts: db.prepare('SELECT event_name as event, source FROM game_scripts WHERE game_id=?').all(g.id),
    servers: withLive(g).servers,
    versions
  });
});
app.post('/api/games', (req,res) => {
  if (!rl(req,res,'creategame',{max:10})) return;
  const u=auth(req,res); if(!u)return;
  const { name, description, category, template, maxPlayers, thumbnail } = req.body||{};
  if (!name||name.length<2) return res.status(400).json({ error:'Invalid name' });
  const id=uuid(), now=new Date().toISOString(), max=Math.min(50,Math.max(2,Number(maxPlayers)||8)), thumb=sanitizeThumb(thumbnail);
  try { /* after insert */ } catch(_){}
  db.prepare(`INSERT INTO games (id, creator_id, name, description, category, max_players, template, state, created_at, updated_at, thumbnail) VALUES (?,?,?,?,?,?,?,'DRAFT',?,?,?)`).run(id,u.id,name.trim(),String(description||'').slice(0,500),category||'Casual',max,template||'Empty World',now,now,thumb);
  try {
    const tpl = templates.load(template||'Empty World');
    const def = sanitizeDefinition(tpl);
    def.rules.maxPlayers = max;
    def.dimension = (req.body.dimension==='3d'?'3d':'2d');
    db.prepare(`INSERT OR REPLACE INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`).run(id, JSON.stringify(def), now);
    for (const row of objectsToLegacyRows(id, def.objects)) {
      db.prepare(`INSERT INTO game_objects (id,game_id,type,name,x,y,scale_x,scale_y,rotation,collision,visibility,props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(row.id,id,row.type,row.name||row.type,row.x,row.y,row.scale_x,row.scale_y,row.rotation,row.collision,row.visibility,row.props_json);
    }
  } catch(e) { console.error('template apply', e.message); }

  db.prepare(`INSERT INTO game_objects (id, game_id, type, name, x, y, rotation, scale_x, scale_y, collision, visibility, props_json) VALUES (?,?,'spawn','Spawn',80,220,0,1,1,1,1,'{}')`).run(uuid(),id);
  db.prepare(`INSERT INTO game_objects (id, game_id, type, name, x, y, rotation, scale_x, scale_y, collision, visibility, props_json) VALUES (?,?,'block','Floor',300,340,0,1,1,1,1,'{}')`).run(uuid(),id);
  for (let i=1;i<=3;i++) db.prepare(`INSERT INTO game_servers (id, game_id, name, region, max_players, is_test, status, created_at) VALUES (?,?,?,'local',?,0,'online',?)`).run(uuid(),id,'Server '+i,max,now);
  res.json({ game: db.prepare('SELECT * FROM games WHERE id=?').get(id) });
});

app.put('/api/games/:id', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const g=db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!g||!collab.canEdit(g.id,u.id)) return res.status(403).json({ error:'Cannot edit' });
  const name = req.body.name != null ? String(req.body.name).trim().slice(0,80) : g.name;
  const description = req.body.description != null ? String(req.body.description).slice(0,500) : g.description;
  const category = req.body.category != null ? String(req.body.category).slice(0,40) : g.category;
  const max = req.body.maxPlayers != null ? Math.min(50,Math.max(2,Number(req.body.maxPlayers)||g.max_players)) : g.max_players;
  let thumb = g.thumbnail;
  if (req.body.thumbnail != null) thumb = sanitizeThumb(req.body.thumbnail);
  if (req.body.thumbnail && !thumb && String(req.body.thumbnail).length>0) return res.status(400).json({ error:'Invalid thumbnail' });
  const now=new Date().toISOString();
  db.prepare(`UPDATE games SET name=?, description=?, category=?, max_players=?, thumbnail=?, updated_at=? WHERE id=?`)
    .run(name||g.name, description, category, max, thumb||'', now, g.id);
  res.json({ game: db.prepare('SELECT * FROM games WHERE id=?').get(g.id) });
});

app.put('/api/games/:id/objects', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const g=db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!g||!collab.canEdit(g.id,u.id)) return res.status(403).json({ error:'Cannot edit' });
  const list=Array.isArray(req.body.objects)?req.body.objects.slice(0,200):[];
  db.prepare('DELETE FROM game_objects WHERE game_id=?').run(g.id);
  for (const o of list) {
    db.prepare(`INSERT INTO game_objects (id, game_id, type, name, x, y, rotation, scale_x, scale_y, collision, visibility, props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(o.id||uuid(),g.id,String(o.type||'block').slice(0,32),String(o.name||'obj').slice(0,40),Number(o.x)||0,Number(o.y)||0,Number(o.rotation)||0,Number(o.scale_x||o.scaleX)||1,Number(o.scale_y||o.scaleY)||1,o.collision===false?0:1,o.visibility===false?0:1,JSON.stringify(o.props||{}));
  }
  try {
    const existing = db.prepare('SELECT definition_json FROM game_definitions WHERE game_id=?').get(g.id);
    const base = existing ? JSON.parse(existing.definition_json) : { template: g.template||'Empty', world:{width:640,height:360,gravity:0.5}, teams:[], items:[], npcs:[], quests:[], shops:[], scripts:[], rules:{maxPlayers:g.max_players||10} };
    const rows = db.prepare('SELECT * FROM game_objects WHERE game_id=?').all(g.id);
    base.objects = rows.map(o=>({
      id:o.id, type:o.type, name:o.name, label:o.name, x:o.x, y:o.y,
      w:(Number(o.scale_x)||1)*36, h:(Number(o.scale_y)||1)*20,
      rotation:o.rotation||0, collision:!!o.collision,
      props: (()=>{try{return JSON.parse(o.props_json||'{}')}catch{return {}}})()
    }));
    const def = sanitizeDefinition(base);
    db.prepare(`INSERT OR REPLACE INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`).run(g.id, JSON.stringify(def), new Date().toISOString());
  } catch(e) { console.error('def sync objects', e.message); }
  res.json({ objects: db.prepare('SELECT * FROM game_objects WHERE game_id=?').all(g.id) });
});
app.put('/api/games/:id/scripts', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const g=db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!g||!collab.canEdit(g.id,u.id)) return res.status(403).json({ error:'Cannot edit' });
  const allowed=new Set(['onGameStart','onPlayerJoin','onPlayerLeave','onPlayerTouch','onPlayerDeath','onPlayerRespawn','onPlayerWin','onGameEnd','onPlayerSpawn']);
  db.prepare('DELETE FROM game_scripts WHERE game_id=?').run(g.id);
  for (const s of req.body.scripts||[]) {
    if (!allowed.has(s.event)) continue;
    let src=String(s.source||'').slice(0,4000).replace(/require\s*\(/gi,'/*blocked*/').replace(/eval\s*\(/gi,'/*blocked*/').replace(/fetch\s*\(/gi,'/*blocked*/').replace(/process\./gi,'/*blocked*/');
    db.prepare('INSERT INTO game_scripts (id, game_id, event_name, source) VALUES (?,?,?,?)').run(uuid(),g.id,s.event,src);
  }
  
  try {
    const existing = db.prepare('SELECT definition_json FROM game_definitions WHERE game_id=?').get(g.id);
    const base = existing ? JSON.parse(existing.definition_json) : { scripts: [] };
    const raw = Array.isArray(req.body.scripts) ? req.body.scripts : [];
    base.scripts = raw.slice(0, 60).map(s => {
      if (s && s.on && Array.isArray(s.actions)) return s;
      // legacy "event: source" text → minimal message action
      const event = String(s.event || s.on || 'onPlayerJoin').slice(0, 40);
      return { on: event, filter: {}, actions: [{ type: 'broadcast', message: String(s.source || '').slice(0, 80) }] };
    });
    const def = sanitizeDefinition(base);
    db.prepare(`INSERT OR REPLACE INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`).run(g.id, JSON.stringify(def), new Date().toISOString());
  } catch(e) { console.error('script def sync', e.message); }
res.json({ ok:true });
});
app.post('/api/games/:id/validate', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const g=db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!g||!collab.canEdit(g.id,u.id)) return res.status(403).json({ error:'Forbidden' });
  const v=publishSvc.validateForPublish(g.id);
  res.json(v);
});
app.post('/api/games/:id/publish', (req,res) => {
  if (!rl(req,res,'publish',{max:10})) return;
  const u=auth(req,res); if(!u)return;
  try {
    const result = publishSvc.publishGame(u.id, req.params.id, { confirmWarnings: !!req.body.confirmWarnings });
    let reward=null;
    if (!result.wasPublished) {
      try { reward=rewards.onGamePublished(u.id, req.params.id); } catch(e){ reward={error:e.message,code:e.code}; }
    }
    res.json({ game: result.game, version: result.version, versionId: result.versionId, warnings: result.warnings, creatorReward: reward });
  } catch(e) {
    if (e.code==='VALIDATION') return res.status(400).json({ error:e.message, errors:e.errors, warnings:e.warnings||[] });
    if (e.code==='WARNINGS') return res.status(409).json({ error:e.message, errors:[], warnings:e.warnings, needConfirm:true });
    if (e.code==='FORBIDDEN') return res.status(403).json({ error:e.message });
    console.error(e);
    res.status(500).json({ error:'Publish failed' });
  }
});
app.post('/api/games/:id/unpublish', (req,res) => {
  const u=auth(req,res); if(!u)return;
  try {
    const game = publishSvc.unpublishGame(u.id, req.params.id);
    res.json({ game });
  } catch(e) {
    res.status(e.code==='FORBIDDEN'?403:400).json({ error:e.message });
  }
});

app.post('/api/games/:id/like', (req,res) => {
  if (!rl(req,res,'like',{max:30})) return;
  const u=auth(req,res); if(!u)return;
  const g=db.prepare(`SELECT * FROM games WHERE id=? AND state='PUBLISHED'`).get(req.params.id);
  if (!g) return res.status(404).json({ error:'Game not found' });
  if (db.prepare('SELECT 1 FROM game_likes WHERE game_id=? AND user_id=?').get(g.id,u.id)) return res.json({ ok:true, already:true, likes:g.likes });
  db.transaction(()=>{
    db.prepare('INSERT INTO game_likes (game_id, user_id, created_at) VALUES (?,?,?)').run(g.id,u.id,new Date().toISOString());
    db.prepare('UPDATE games SET likes=likes+1 WHERE id=?').run(g.id);
  })();
  try { rewards.onLikeMilestone(g.creator_id,g.id,u.id); } catch(_){}
  res.json({ ok:true, likes: db.prepare('SELECT likes FROM games WHERE id=?').get(g.id).likes });
});
app.post('/api/games/:id/favorite', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const existing = db.prepare('SELECT 1 FROM favorites WHERE user_id=? AND game_id=?').get(u.id, req.params.id);
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE user_id=? AND game_id=?').run(u.id, req.params.id);
    return res.json({ ok:true, favorited: false });
  }
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, game_id, created_at) VALUES (?,?,?)').run(u.id,req.params.id,new Date().toISOString());
  res.json({ ok:true, favorited: true });
});
app.post('/api/games/:id/play', (req,res) => {
  if (!rl(req,res,'play',{max:40})) return;
  const u=auth(req,res); if(!u)return;
  const g=db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!g||!canAccessGame(u,g)||(g.state!=='PUBLISHED'&&g.creator_id!==u.id)) return res.status(404).json({ error:'Game unavailable' });
  if (g.state==='SUSPENDED'||g.state==='REMOVED'||g.state==='BANNED') return res.status(403).json({ error:'Game suspended' });
  const privateServerId = req.body.privateServerId || null;
  let srv = null;
  if (privateServerId) {
    try {
      platform.assertPrivateServerAccess(u.id, privateServerId, req.body.accessCode);
      const ps = db.prepare('SELECT * FROM private_servers WHERE id=?').get(privateServerId);
      if (!ps || ps.game_id !== g.id) return res.status(400).json({ error:'Private server does not match game' });
      srv = db.prepare('SELECT * FROM game_servers WHERE id=?').get(privateServerId);
      if (!srv) return res.status(404).json({ error:'Private server runtime missing' });
      if (rooms.count(srv.id) >= (ps.max_players || srv.max_players)) return res.status(409).json({ error:'FULL' });
    } catch (e) {
      return res.status(e.code==='FORBIDDEN'?403:e.code==='CLOSED'?410:400).json({ error: e.message, code: e.code });
    }
  } else {
    // Public servers only (exclude private)
    let servers=db.prepare('SELECT * FROM game_servers WHERE game_id=? AND is_test=0').all(g.id);
    try {
      servers = servers.filter(s => {
        const ps = db.prepare('SELECT 1 FROM private_servers WHERE id=?').get(s.id);
        return !ps;
      });
    } catch (_) {}
    srv=req.body.serverId?servers.find(s=>s.id===req.body.serverId):servers.find(s=>rooms.count(s.id)<s.max_players);
    if (!srv||rooms.count(srv.id)>=srv.max_players) return res.status(409).json({ error:'FULL' });
  }
  db.prepare('UPDATE games SET plays=plays+1 WHERE id=?').run(g.id);
  try { if (g.creator_id) rewards.onUniquePlayEngagement(g.creator_id,g.id,u.id); } catch(_){}
  const ticket=shortTicket({ sub:u.id, game:g.id, server:srv.id, private: !!privateServerId }, SECRET, 90);
  const th=crypto.createHash('sha256').update(ticket).digest('hex');
  db.prepare(`INSERT INTO ws_tickets (ticket_hash, user_id, game_id, server_id, expires_at, used) VALUES (?,?,?,?,?,0)`).run(th,u.id,g.id,srv.id,new Date(Date.now()+90000).toISOString());
  res.json({ serverId:srv.id, wsPath:'/ws', ticket, private: !!privateServerId });
});
app.post('/api/games/:id/test-server', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const g=db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!g||!collab.canEdit(g.id,u.id)) return res.status(403).json({ error:'Cannot test' });
  let srv=db.prepare('SELECT * FROM game_servers WHERE game_id=? AND is_test=1').get(g.id);
  if (!srv) {
    const id=uuid();
    db.prepare(`INSERT INTO game_servers (id, game_id, name, region, max_players, is_test, status, created_at) VALUES (?,?,'TEST SERVER','local',?,1,'online',?)`).run(id,g.id,g.max_players,new Date().toISOString());
    srv=db.prepare('SELECT * FROM game_servers WHERE id=?').get(id);
  }
  const ticket=shortTicket({ sub:u.id, game:g.id, server:srv.id }, SECRET, 90);
  const th=crypto.createHash('sha256').update(ticket).digest('hex');
  db.prepare(`INSERT INTO ws_tickets (ticket_hash, user_id, game_id, server_id, expires_at, used) VALUES (?,?,?,?,?,0)`).run(th,u.id,g.id,srv.id,new Date(Date.now()+90000).toISOString());
  res.json({ server:srv, wsPath:'/ws', ticket });
});

app.get('/api/creator/dashboard', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const games=db.prepare('SELECT * FROM games WHERE creator_id=?').all(u.id);
  const published=games.filter(g=>g.state==='PUBLISHED').length;
  const totals=games.reduce((a,g)=>({games:a.games+1,plays:a.plays+g.plays,likes:a.likes+g.likes}),{games:0,plays:0,likes:0});
  const rewardList=rewards.listRewards(u.id);
  const today=new Date().toISOString().slice(0,10);
  const weekAgo=new Date(Date.now()-7*864e5).toISOString();
  const passStats=gamepasses.creatorPassStats(u.id);
  res.json({
    totals:{...totals,published}, kavxBalance:wallet.getBalance(u.id), passStats,
    creatorRewards:rewardList.reduce((n,r)=>n+r.amount,0),
    earnedToday:rewardList.filter(r=>r.created_at&&r.created_at.startsWith(today)).reduce((n,r)=>n+r.amount,0),
    earnedWeek:rewardList.filter(r=>r.created_at>=weekAgo).reduce((n,r)=>n+r.amount,0),
    rewardHistory:rewardList.slice(0,50),
    perGame:games.map(g=>({id:g.id,name:g.name,state:g.state,plays:g.plays,likes:g.likes,earned:rewardList.filter(r=>r.game_id===g.id).reduce((n,r)=>n+r.amount,0)})),
    games, note:'Creator payouts are platform-controlled.'
  });
});
app.get('/api/creator/rewards', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ rewards: rewards.listRewards(u.id), balance: wallet.getBalance(u.id) });
});
app.get('/api/inventory', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ items: db.prepare(`SELECT items.id, items.name, items.kind, inventory.qty FROM inventory JOIN items ON items.id=inventory.item_id WHERE inventory.user_id=?`).all(u.id) });
});
app.post('/api/reports', (req,res) => {
  if (!rl(req,res,'report',{max:10})) return;
  const u=auth(req,res); if(!u)return;
  db.prepare(`INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, status, created_at) VALUES (?,?,?,?,?,?,'open',?)`).run(uuid(),u.id,req.body.targetType,String(req.body.targetId),req.body.reason||'Other',String(req.body.details||'').slice(0,500),new Date().toISOString());
  res.json({ ok:true });
});

app.get('/api/admin/reports', (req,res) => {
  const u=auth(req,res); if(!u)return;
  if (u.role!=='admin'&&!isOwner(u.id)) return res.status(403).json({ error:'Admin only' });
  const rows = db.prepare(`SELECT * FROM reports ORDER BY created_at DESC LIMIT 100`).all();
  res.json({ reports: rows });
});
app.post('/api/admin/reports/:id/resolve', (req,res) => {
  const u=auth(req,res); if(!u)return;
  if (u.role!=='admin'&&!isOwner(u.id)) return res.status(403).json({ error:'Admin only' });
  const action = String(req.body.action||'dismiss');
  const rep = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!rep) return res.status(404).json({ error:'Not found' });
  const now = new Date().toISOString();
  if (action === 'unpublish' && rep.target_type === 'game') {
    db.prepare(`UPDATE games SET state='DRAFT', updated_at=? WHERE id=?`).run(now, rep.target_id);
  }
  if (action === 'suspend_user' && rep.target_type === 'user') {
    db.prepare(`UPDATE users SET status='suspended' WHERE id=?`).run(rep.target_id);
  }
  if (action === 'suspend_game' && rep.target_type === 'game') {
    db.prepare(`UPDATE games SET state='SUSPENDED', updated_at=? WHERE id=?`).run(now, rep.target_id);
  }
  db.prepare(`UPDATE reports SET status=? WHERE id=?`).run(action==='dismiss'?'dismissed':'resolved', req.params.id);
  try {
    db.prepare(`INSERT INTO admin_actions (id, admin_id, action, target_type, target_id, details, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(uuid(), u.id, action, rep.target_type, rep.target_id, String(req.body.reason||'').slice(0,200), now);
  } catch(_){}
  res.json({ ok:true });
});


// —— Marketplace / assets ——
app.get('/api/marketplace', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ assets: platform.listMarketplace({ type: req.query.type, q: req.query.q }) });
});
app.post('/api/marketplace/assets', (req,res) => {
  if (!rl(req,res,'asset_pub',{max:20})) return;
  const u=auth(req,res); if(!u)return;
  try {
    res.json({ asset: platform.publishAsset({ userId:u.id, type:req.body.type, name:req.body.name, description:req.body.description, priceKavx:req.body.priceKavx, dataJson:req.body.data, thumbnail:req.body.thumbnail }) });
  } catch(e) { res.status(400).json({ error:e.message, code:e.code }); }
});
app.post('/api/marketplace/assets/:id/buy', (req,res) => {
  if (!rl(req,res,'asset_buy',{max:20})) return;
  const u=auth(req,res); if(!u)return;
  try { res.json(platform.buyAsset({ userId:u.id, assetId:req.params.id, idempotencyKey:req.body.idempotencyKey })); }
  catch(e) { res.status(e.code==='FUNDS'?402:400).json({ error:e.message, code:e.code }); }
});
app.get('/api/marketplace/mine', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ published: platform.myAssets(u.id), owned: platform.ownedAssets(u.id) });
});

// —— Cloud saves ——
app.post('/api/games/:id/cloud-save', (req,res) => {
  if (!rl(req,res,'cloud',{max:30})) return;
  const u=auth(req,res); if(!u)return;
  try { res.json(platform.cloudSave({ userId:u.id, gameId:req.params.id, slot:req.body.slot, data:req.body.data })); }
  catch(e) { res.status(400).json({ error:e.message }); }
});
app.get('/api/games/:id/cloud-save', (req,res) => {
  const u=auth(req,res); if(!u)return;
  try { res.json(platform.cloudLoad({ userId:u.id, gameId:req.params.id, slot:req.query.slot })); }
  catch(e) { res.status(400).json({ error:e.message }); }
});

// —— Private servers ——
app.post('/api/games/:id/private-servers', (req,res) => {
  const u=auth(req,res); if(!u)return;
  try { res.json(platform.createPrivateServer({ userId:u.id, gameId:req.params.id, name:req.body.name, maxPlayers:req.body.maxPlayers, accessCode:req.body.accessCode })); }
  catch(e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/private-servers/:id/join', (req,res) => {
  const u=auth(req,res); if(!u)return;
  try { res.json(platform.joinPrivateServer({ userId:u.id, serverId:req.params.id, accessCode:req.body.accessCode })); }
  catch(e) { res.status(e.code==='FORBIDDEN'?403:400).json({ error:e.message }); }
});

// —— Follows ——
app.post('/api/follow', (req,res) => {
  const u=auth(req,res); if(!u)return;
  try { res.json(platform.follow({ followerId:u.id, followingUsername:req.body.username })); }
  catch(e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/unfollow', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json(platform.unfollow({ followerId:u.id, followingId:req.body.userId }));
});

// —— Avatar ——
app.get('/api/avatar', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ avatar: platform.getAvatar(u.id) });
});
app.put('/api/avatar', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ avatar: platform.updateAvatar({ userId:u.id, ...req.body }) });
});

// —— Groups ——
app.get('/api/groups', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json({ groups: platform.listGroups(u.id) });
});
app.post('/api/groups', (req,res) => {
  const u=auth(req,res); if(!u)return;
  try { res.json(platform.createGroup({ userId:u.id, name:req.body.name, description:req.body.description })); }
  catch(e) { res.status(400).json({ error:e.message }); }
});

// —— Creator analytics ——
app.get('/api/creator/analytics', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json(platform.creatorAnalytics(u.id));
});

app.post('/api/games/:id/session-stat', (req,res) => {
  if (!rl(req,res,'session_stat',{max:30})) return;
  const u=auth(req,res); if(!u)return;
  try {
    res.json(platform.recordSession({
      userId: u.id,
      gameId: req.params.id,
      durationSec: req.body.durationSec,
      sessionId: req.body.sessionId || null
    }));
  } catch(e) {
    res.status(e.code==='FORBIDDEN'?403:e.code==='NOT_FOUND'?404:400).json({ error: e.message, code: e.code });
  }
});

// —— Version rollback ——
app.post('/api/games/:id/rollback', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const g=db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!g||!collab.canEdit(g.id,u.id)) return res.status(403).json({ error:'Cannot rollback' });
  if (g.state==='SUSPENDED'||g.state==='REMOVED'||g.state==='BANNED') return res.status(403).json({ error:'Moderated games cannot be rolled back by creator' });
  const ver = Number(req.body.version);
  const row = db.prepare('SELECT * FROM game_versions WHERE game_id=? AND version=?').get(g.id, ver);
  if (!row) return res.status(404).json({ error:'Version not found' });
  const now = new Date().toISOString();
  try {
    const run = db.transaction(() => {
      let def = null;
      try {
        const data = JSON.parse(row.data_json || '{}');
        def = data.definition || data;
      } catch (_) { def = null; }
      if (!def || typeof def !== 'object') throw new Error('Invalid version snapshot');
      const { sanitizeDefinition, objectsToLegacyRows } = require('./engine/definition');
      def = sanitizeDefinition(def);
      db.prepare(`INSERT OR REPLACE INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`)
        .run(g.id, JSON.stringify(def), now);
      db.prepare('DELETE FROM game_objects WHERE game_id=?').run(g.id);
      let objects = [];
      try { objects = JSON.parse(row.objects_json || '[]'); } catch (_) {}
      if (objects.length) {
        for (const o of objects) {
          db.prepare(`INSERT INTO game_objects (id,game_id,type,name,x,y,scale_x,scale_y,rotation,collision,visibility,props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(o.id||require('./services/crypto').uuid(), g.id, o.type||'block', o.name||o.type||'obj', o.x||0, o.y||0, o.scale_x||1, o.scale_y||1, o.rotation||0, o.collision!=null?o.collision:1, o.visibility!=null?o.visibility:1, o.props_json||'{}');
        }
      } else {
        for (const rowo of objectsToLegacyRows(g.id, def.objects||[])) {
          db.prepare(`INSERT INTO game_objects (id,game_id,type,name,x,y,scale_x,scale_y,rotation,collision,visibility,props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(rowo.id, g.id, rowo.type, rowo.name, rowo.x, rowo.y, rowo.scale_x, rowo.scale_y, rowo.rotation, rowo.collision, rowo.visibility, rowo.props_json);
        }
      }
      db.prepare('DELETE FROM game_scripts WHERE game_id=?').run(g.id);
      try {
        const scripts = JSON.parse(row.scripts_json || '[]');
        for (const s of scripts) {
          db.prepare(`INSERT INTO game_scripts (id, game_id, event_name, source) VALUES (?,?,?,?)`)
            .run(require('./services/crypto').uuid(), g.id, s.event||s.event_name||'onGameStart', s.source||'');
        }
      } catch (_) {}
      // Keep as DRAFT after rollback unless was published pointing to this version intentionally
      if (g.state === 'PUBLISHED') {
        db.prepare(`UPDATE games SET version=?, published_version=?, updated_at=? WHERE id=?`).run(ver, ver, now, g.id);
      } else {
        db.prepare(`UPDATE games SET version=?, updated_at=? WHERE id=?`).run(ver, now, g.id);
      }
    });
    run();
    res.json({ ok:true, version: ver, state: db.prepare('SELECT state,version FROM games WHERE id=?').get(g.id) });
  } catch(e) {
    res.status(500).json({ error: e.message || 'Rollback failed' });
  }
});


app.post('/api/admin/games/:id/suspend', (req,res) => {
  const u=auth(req,res); if(!u)return;
  if (u.role!=='admin'&&!isOwner(u.id)) return res.status(403).json({ error:'Admin only' });
  try { res.json({ game: publishSvc.suspendGame(u.id, req.params.id, req.body.reason) }); }
  catch(e){ res.status(400).json({ error:e.message }); }
});
app.post('/api/admin/games/:id/unsuspend', (req,res) => {
  const u=auth(req,res); if(!u)return;
  if (u.role!=='admin'&&!isOwner(u.id)) return res.status(403).json({ error:'Admin only' });
  try { res.json({ game: publishSvc.unsuspendGame(u.id, req.params.id) }); }
  catch(e){ res.status(400).json({ error:e.message }); }
});
app.post('/api/private-servers/:id/close', (req,res) => {
  const u=auth(req,res); if(!u)return;
  try { res.json(platform.closePrivateServer({ userId:u.id, serverId:req.params.id })); }
  catch(e){ res.status(e.code==='FORBIDDEN'?403:400).json({ error:e.message }); }
});


// —— Game Passes (60% creator / 40% platform) ——
app.get('/api/games/:id/passes', (req,res) => {
  const u=auth(req,res); if(!u)return;
  const g=db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error:'Not found' });
  const includeInactive = g.creator_id===u.id;
  res.json({ passes: gamepasses.listPasses(g.id, { includeInactive }), split: { creatorPercent:60, platformPercent:40 } });
});
app.post('/api/games/:id/passes', (req,res) => {
  if (!rl(req,res,'pass_create',{max:20})) return;
  const u=auth(req,res); if(!u)return;
  try {
    res.json({ pass: gamepasses.createPass({
      userId: u.id, gameId: req.params.id, name: req.body.name, description: req.body.description,
      icon: req.body.icon, priceKavx: req.body.priceKavx, benefits: req.body.benefits
    })});
  } catch(e) { res.status(e.code==='FORBIDDEN'?403:400).json({ error:e.message, code:e.code }); }
});
app.post('/api/passes/:id/buy', (req,res) => {
  if (!rl(req,res,'pass_buy',{max:20})) return;
  const u=auth(req,res); if(!u)return;
  try {
    res.json(gamepasses.purchasePass({ userId:u.id, passId:req.params.id, idempotencyKey:req.body.idempotencyKey }));
  } catch(e) {
    const code = e.code==='FUNDS'?402:e.code==='FORBIDDEN'?403:e.code==='SELF'?400:400;
    res.status(code).json({ error:e.message, code:e.code });
  }
});
app.post('/api/passes/:id/active', (req,res) => {
  const u=auth(req,res); if(!u)return;
  try { res.json({ pass: gamepasses.setPassActive({ userId:u.id, passId:req.params.id, active: !!req.body.active }) }); }
  catch(e) { res.status(400).json({ error:e.message }); }
});
app.get('/api/creator/pass-stats', (req,res) => {
  const u=auth(req,res); if(!u)return;
  res.json(gamepasses.creatorPassStats(u.id));
});

app.get('/api/admin/overview', (req,res) => {
  const u=auth(req,res); if(!u)return;
  if (u.role!=='admin'&&!isOwner(u.id)) return res.status(403).json({ error:'Admin only' });
  res.json({ users:db.prepare('SELECT COUNT(*) as c FROM users').get().c, games:db.prepare('SELECT COUNT(*) as c FROM games').get().c, reports:db.prepare(`SELECT COUNT(*) as c FROM reports WHERE status='open'`).get().c, purchases:db.prepare('SELECT COUNT(*) as c FROM purchases').get().c, livePlayers:rooms.totalPlayers() });
});

app.use(staticHandler(path.join(__dirname,'../frontend')));

const server=http.createServer((req,res)=>{
  const len=Number(req.headers['content-length']||0);
  if (len>BODY_LIMIT){ res.statusCode=413; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({error:'Request too large'})); return; }
  app.handle(req,res);
});
const wsConnectionLimiter = createConnectionLimiter(20);
server.on('upgrade',(req,socket)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if (!url.pathname.startsWith('/ws')){ socket.destroy(); return; }
    const ip=req.socket.remoteAddress||'x';
    const releaseIpSlot = wsConnectionLimiter.acquire(ip);
    if (!releaseIpSlot) { socket.destroy(); return; }
    // Release the slot even when authentication/ticket validation fails before
    // game handlers are attached. Idempotence handles error + close both firing.
    socket.once('close', releaseIpSlot);
    socket.once('error', releaseIpSlot);
    const ws=acceptWebSocket(req,socket);
    if (!ws) { releaseIpSlot(); return; }
    // TICKET ONLY — long-lived JWT in URL is rejected
    const ticket=url.searchParams.get('ticket');
    if (!ticket){ try{ws.send(JSON.stringify({type:'error',error:'ticket_required'}));}catch(_){} ws.close(); return; }
    if (url.searchParams.get('token')){ try{ws.send(JSON.stringify({type:'error',error:'jwt_url_rejected'}));}catch(_){} ws.close(); return; }
    const payload=parseTicket(ticket,SECRET);
    if (!payload){ ws.close(); return; }
    const th=crypto.createHash('sha256').update(ticket).digest('hex');
    const row=db.prepare('SELECT * FROM ws_tickets WHERE ticket_hash=?').get(th);
    if (!row||row.used||new Date(row.expires_at)<new Date()){ ws.close(); return; }
    if (row.user_id!==payload.sub||row.game_id!==payload.game||row.server_id!==payload.server){ ws.close(); return; }
    db.prepare('UPDATE ws_tickets SET used=1 WHERE ticket_hash=?').run(th);
    const userId=payload.sub;
    const gameId=payload.game;
    const serverId=payload.server;
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (!user||user.status!=='active'){ ws.close(); return; }
    const g=db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
    if (!g||(g.state!=='PUBLISHED'&&!collab.canView(g.id,user.id))){ ws.close(); return; }
    const srv=db.prepare('SELECT * FROM game_servers WHERE id=? AND game_id=?').get(serverId,gameId);
    if (!srv||rooms.count(serverId)>=srv.max_players){ ws.close(); return; }
    let def=null;
    try {
      const drow=db.prepare('SELECT definition_json FROM game_definitions WHERE game_id=?').get(gameId);
      if (drow) def=JSON.parse(drow.definition_json);
    } catch(_){}
    const objects=db.prepare('SELECT * FROM game_objects WHERE game_id=?').all(gameId);
    if (def) rooms.createFromDefinition(serverId, def, { gameId, maxPlayers: srv.max_players });
    else rooms.setColliders(serverId, objects);

    const spawn=objects.find(o=>o.type==='spawn')||{x:100,y:200};
    user.ws=ws;
    rooms.join(serverId,user,spawn,{ gameId, maxPlayers: srv.max_players });
    presence.set(user.id,{ status:'playing', game:g.name, gameId:g.id, serverId });
    const rt=rooms.getRuntime(serverId);
    ws.send(JSON.stringify({ type:'welcome', game:g, objects, definition: def||null, you:user.id, players:rooms.snapshot(serverId), entities: rt?rt.entitySnapshot():[], full: rt?rt.fullState():null }));
    rooms.broadcast(serverId,{ type:'join', players:rooms.snapshot(serverId) });
    rooms.broadcast(serverId,{ type:'event', event:'onPlayerJoin', userId:user.id });
    ws.on('message',(buf)=>{
      let msg; try { if (buf.length>4096) return; msg=JSON.parse(buf.toString()); } catch { return; }
      try {
        // INPUT ONLY — ignore client position/health/win
        if (msg.type==='buy'){
          const r=rooms.buy(serverId,user.id,msg.shopId,msg.itemId);
          ws.send(JSON.stringify({type:'buyResult',...r}));
        } else if (msg.type==='input'){
          const view=rooms.applyInput(serverId,user.id,msg);
          if (view){
            rooms.broadcast(serverId,{ type:'state', players:rooms.snapshot(serverId) });
            if (!view.alive){
              rooms.broadcast(serverId,{ type:'event', event:'onPlayerDeath', userId:user.id });
              setTimeout(()=>{
                const r=rooms.respawn(serverId,user.id);
                if (r) rooms.broadcast(serverId,{ type:'state', players:rooms.snapshot(serverId), event:'onPlayerSpawn' });
              }, 1500);
            }
          }
        } else if (msg.type==='state' || msg.x!==undefined || msg.health!==undefined){
          // reject client-authoritative state silently
          return;
        } else if (msg.type==='ping') ws.send(JSON.stringify({type:'pong',t:Date.now()}));
      } catch(_){}
    });
    let cleaned = false;
    function cleanup(){
      if (cleaned) return;
      cleaned = true;
      rooms.leave(serverId,user.id);
      presence.set(user.id,{status:'online',game:null});
      rooms.broadcast(serverId,{type:'leave',userId:user.id,players:rooms.snapshot(serverId)});
      rooms.broadcast(serverId,{type:'event',event:'onPlayerLeave',userId:user.id});
    }
    ws.on('close',cleanup); ws.on('error',cleanup);
  } catch { try{socket.destroy();}catch(_){} }
});



/* ========== Bangladesh payments (SSLCommerz) ========== */
const bdPay = require('./payments/bangladesh');

app.get('/api/payments/bd/status', (req, res) => {
  res.json(bdPay.status());
});

app.post('/api/payments/bd/create-order', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (!rl(req, res, 'bd-order:' + u.id, { windowMs: 60000, max: 10 })) return;
  try {
    if (process.env.NODE_ENV === 'production' && process.env.SANDBOX_PAYMENTS === 'true') {
      // sandbox gateway may still be used if SSLCOMMERZ_MODE is not live
    }
    const result = await bdPay.createOrder({
      userId: u.id,
      productId: String(req.body?.productId || '')
    });
    res.status(201).json(result);
  } catch (e) {
    const st = e.code === 'NOT_CONFIGURED' ? 503 : 400;
    res.status(st).json({ error: e.message, code: e.code });
  }
});

app.get('/api/payments/bd/orders', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json({ orders: bdPay.listOrders(u.id) });
});

app.get('/api/payments/bd/orders/:id', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const o = bdPay.getOrder(req.params.id);
  if (!o || o.user_id !== u.id) return res.status(404).json({ error: 'Not found' });
  res.json({
    order: {
      id: o.id,
      productId: o.product_id,
      amountBdt: o.amount_bdt,
      kavx: o.kavx_amount,
      status: o.status,
      createdAt: o.created_at,
      completedAt: o.completed_at
    }
  });
});

// IPN / server callback — no user session; verified via provider validation API
app.post('/api/payments/bd/ipn', async (req, res) => {
  try {
    const payload = { ...(req.body || {}), ...(req.query || {}) };
    const result = await bdPay.handleIpnOrCallback(payload);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code });
  }
});


/* ========== Team Studio collaboration ========== */
app.get('/api/collab/invites', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json({ invites: collab.listIncomingInvites(u.id) });
});
app.post('/api/collab/invites/:id/accept', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try { res.json(collab.respondInvite({ inviteId: req.params.id, userId: u.id, accept: true })); }
  catch (e) { res.status(e.code==='NOT_FOUND'?404:400).json({ error: e.message, code: e.code }); }
});
app.post('/api/collab/invites/:id/decline', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try { res.json(collab.respondInvite({ inviteId: req.params.id, userId: u.id, accept: false })); }
  catch (e) { res.status(400).json({ error: e.message, code: e.code }); }
});
app.get('/api/games/:id/collab', (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (!collab.canView(req.params.id, u.id)) return res.status(403).json({ error: 'Forbidden' });
  const role = collab.getRole(req.params.id, u.id);
  res.json({
    role,
    members: collab.listMembers(req.params.id),
    revision: collab.getRevision(req.params.id),
    activity: collab.activity(req.params.id, 30),
    canEdit: collab.canEdit(req.params.id, u.id),
    canPublish: collab.canPublish(req.params.id, u.id),
    canManage: collab.canManageMembers(req.params.id, u.id)
  });
});
app.post('/api/games/:id/collab/invite', (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (!rl(req, res, 'collab-inv:' + u.id, { max: 30 })) return;
  try {
    res.status(201).json(collab.invite({
      gameId: req.params.id,
      inviterId: u.id,
      inviteeUsername: req.body?.username,
      role: req.body?.role
    }));
  } catch (e) {
    res.status(e.code==='FORBIDDEN'?403:400).json({ error: e.message, code: e.code });
  }
});
app.post('/api/games/:id/collab/role', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try {
    res.json(collab.setRole({
      gameId: req.params.id,
      ownerId: u.id,
      targetUserId: req.body?.userId,
      role: req.body?.role
    }));
  } catch (e) {
    res.status(e.code==='FORBIDDEN'?403:400).json({ error: e.message, code: e.code });
  }
});
app.post('/api/games/:id/collab/remove', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try {
    res.json(collab.removeMember({
      gameId: req.params.id,
      actorId: u.id,
      targetUserId: req.body?.userId
    }));
  } catch (e) {
    res.status(e.code==='FORBIDDEN'?403:400).json({ error: e.message, code: e.code });
  }
});
app.post('/api/games/:id/collab/revision', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try {
    res.json(collab.bumpRevision(req.params.id, u.id, req.body?.baseRevision));
  } catch (e) {
    res.status(e.code==='CONFLICT'?409:e.code==='FORBIDDEN'?403:400).json({
      error: e.message, code: e.code, currentRevision: e.currentRevision
    });
  }
});

/* ========== Videos / gameplay clips ========== */
const videos = require('./services/videos');
const { parseMultipart } = require('./services/multipart');

app.get('/api/videos', (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const gameId = req.query.gameId || null;
    res.json({ videos: videos.listPublic({ page, limit, gameId }), page, limit });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

app.get('/api/videos/mine', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try {
    res.json({
      videos: videos.listOwner(u.id),
      settings: videos.profileVideoSettings(u.id)
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/users/:username/videos', (req, res) => {
  try {
    res.json(videos.listProfilePublic(req.params.username));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/videos/:id', (req, res) => {
  try {
    const v = videos.getVideo(req.params.id);
    if (!v || v.status === 'deleted') return res.status(404).json({ error: 'Not found' });
    let viewerId = null;
    let isAdmin = false;
    try {
      const u = auth(req, res, { optional: true });
      // auth() may send 401 — use soft parse
    } catch (_) {}
    // Soft auth
    try {
      const hdr = req.headers.authorization || '';
      const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
      if (tok) {
        const jwt = require('jsonwebtoken');
        const payload = jwt.verify(tok, SECRET);
        viewerId = payload.sub;
        const row = db.prepare('SELECT role FROM users WHERE id=?').get(viewerId);
        isAdmin = row && (row.role === 'admin' || isOwner(viewerId));
      }
    } catch (_) {}
    if (!videos.canView(v, viewerId, isAdmin)) return res.status(404).json({ error: 'Not found' });
    res.json({ video: videos.publicRow(v) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


app.post('/api/videos/:id/stream-ticket', (req, res) => {
  try {
    const v = videos.getVideo(req.params.id);
    if (!v || v.status === 'deleted') return res.status(404).json({ error: 'Not found' });
    const u = auth(req, res); if (!u) return;
    const isAdmin = u.role === 'admin' || isOwner(u.id);
    if (!videos.canView(v, u.id, isAdmin)) return res.status(404).json({ error: 'Not found' });
    const ticket = videos.createStreamTicket(v.id, u.id);
    res.json({ ticket, expiresInSec: 120 });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/videos/:id/stream-ticket-public', (req, res) => {
  try {
    const v = videos.getVideo(req.params.id);
    if (!v || v.status === 'deleted') return res.status(404).json({ error: 'Not found' });
    let viewerId = null;
    try {
      const hdr = req.headers.authorization || '';
      const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
      if (tok) {
        const payload = sessions.verifyAccess(tok);
        viewerId = payload.sub;
      }
    } catch (_) {}
    const isAdmin = viewerId && (isOwner(viewerId));
    if (!videos.canView(v, viewerId, isAdmin)) return res.status(404).json({ error: 'Not found' });
    // Only issue ticket for public/unlisted without forcing login when allowed
    const ticket = videos.createStreamTicket(v.id, viewerId);
    res.json({ ticket, expiresInSec: 120 });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/videos/:id/stream', (req, res) => {
  try {
    const v = videos.getVideo(req.params.id);
    if (!v || v.status === 'deleted') return res.status(404).end();
    let viewerId = null;
    let isAdmin = false;
    try {
      const hdr = req.headers.authorization || '';
      const streamTicket = req.query.ticket || null;
      if (streamTicket) {
        const st = videos.consumeStreamTicket(streamTicket, req.params.id);
        if (st) {
          viewerId = st.userId;
          if (viewerId) {
            const row = db.prepare('SELECT role FROM users WHERE id=?').get(viewerId);
            isAdmin = row && (row.role === 'admin' || isOwner(viewerId));
          }
        }
      } else {
        const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
        if (tok) {
          try {
            const payload = sessions.verifyAccess(tok);
            viewerId = payload.sub;
            const row = db.prepare('SELECT role FROM users WHERE id=?').get(viewerId);
            isAdmin = row && (row.role === 'admin' || isOwner(viewerId));
          } catch (_) {}
        }
      }
    } catch (_) {}
    if (!videos.canView(v, viewerId, isAdmin)) return res.status(404).end();
    const file = videos.readFileStream(v);
    if (!file) return res.status(404).end();
    const viewerKey = viewerId || clientIp(req);
    videos.recordView(v.id, viewerKey);
    const stat = require('fs').statSync(file.path);
    const range = req.headers.range;
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (start >= stat.size) return res.status(416).end();
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', end - start + 1);
        require('fs').createReadStream(file.path, { start, end }).pipe(res);
        return;
      }
    }
    res.setHeader('Content-Length', stat.size);
    require('fs').createReadStream(file.path).pipe(res);
  } catch (e) {
    res.status(400).end();
  }
});

app.post('/api/videos/upload', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (!rl(req, res, 'vid-up:' + u.id, { windowMs: 3600000, max: 20 })) return;
  try {
    const { fields, file } = await parseMultipart(req, { maxBytes: videos.MAX_BYTES });
    if (!file || !file.buffer) return res.status(400).json({ error: 'No video file', code: 'NO_FILE' });
    const row = videos.createFromUpload({
      ownerId: u.id,
      title: fields.title,
      description: fields.description,
      visibility: fields.visibility,
      gameId: fields.gameId || null,
      buffer: file.buffer,
      declaredMime: file.mime
    });
    res.status(201).json({ video: row });
  } catch (e) {
    const code = e.code === 'TOO_LARGE' ? 413 : e.code === 'RATE' ? 429 : 400;
    res.status(code).json({ error: e.message, code: e.code });
  }
});

app.patch('/api/videos/:id', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try {
    const admin = u.role === 'admin' || isOwner(u.id);
    const row = videos.updateMeta(u.id, req.params.id, req.body || {}, admin);
    res.json({ video: row });
  } catch (e) {
    const st = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
    res.status(st).json({ error: e.message, code: e.code });
  }
});

app.delete('/api/videos/:id', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try {
    const admin = u.role === 'admin' || isOwner(u.id);
    res.json(videos.softDelete(u.id, req.params.id, admin));
  } catch (e) {
    const st = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
    res.status(st).json({ error: e.message, code: e.code });
  }
});

app.put('/api/users/me/video-settings', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try {
    const s = videos.setProfileVideoSettings(u.id, {
      videosEnabled: req.body?.videosEnabled,
      defaultVisibility: req.body?.defaultVisibility
    });
    res.json({ settings: s });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/users/me/video-settings', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json({ settings: videos.profileVideoSettings(u.id) });
});

app.post('/api/videos/:id/report', (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (!rl(req, res, 'vid-rep:' + u.id, { windowMs: 600000, max: 10 })) return;
  try {
    res.json(videos.reportVideo({ videoId: req.params.id, reporterId: u.id, reason: req.body?.reason }));
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});


const PORT=Number(process.env.PORT||8080);
if (require.main === module) {
  // Multiplayer registry (memory default; Redis when MULTIPLAYER_MODE=redis & REDIS_URL)
  (async () => {
    try {
      const { initRegistry, getMode } = require('./multiplayer/roomRegistry');
      const reg = await initRegistry();
      if (rooms.attachRegistry) await rooms.attachRegistry(reg);
      console.log('[multiplayer] mode=' + getMode());
    } catch (e) {
      console.warn('[multiplayer] registry init:', e.message);
    }
  })();

  // Google Play acknowledgement retry (does not revoke grants)
  const ackTimer = setInterval(() => {
    try {
      const { processAckQueue } = require('./payments/verify');
      processAckQueue().catch(() => {});
    } catch (_) {}
  }, 60000);
  if (typeof ackTimer.unref === 'function') ackTimer.unref();

  server.listen(PORT, () => console.log('Kavryon listening on ' + PORT));
}
module.exports = { app, server, SECRET };
