/**
 * Gameplay video clips — server-authoritative visibility & ownership.
 * Files stored on disk under storage/videos; never inside SQLite BLOBs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../database/db');
const { uuid } = require('./crypto');

const STORAGE_ROOT = process.env.KAVRYON_VIDEO_ROOT
  || path.join(__dirname, '..', 'storage');
const VIDEO_DIR = path.join(STORAGE_ROOT, 'videos');
const THUMB_DIR = path.join(STORAGE_ROOT, 'thumbs');

const MAX_BYTES = Number(process.env.KAVRYON_VIDEO_MAX_BYTES || 50 * 1024 * 1024); // 50MB
const MAX_TITLE = 80;
const MAX_DESC = 500;
const MAX_UPLOADS_PER_HOUR = Number(process.env.KAVRYON_VIDEO_UPLOADS_PER_HOUR || 10);
const ALLOWED_MIME = new Set(['video/mp4', 'video/webm']);
const ALLOWED_EXT = new Set(['.mp4', '.webm']);

function ensureDirs() {
  for (const d of [VIDEO_DIR, THUMB_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
ensureDirs();

const streamTickets = new Map(); // ticket -> { videoId, userId, exp }

function createStreamTicket(videoId, userId) {
  const ticket = crypto.randomBytes(24).toString('hex');
  streamTickets.set(ticket, {
    videoId,
    userId: userId || null,
    exp: Date.now() + 120000 // 2 minutes
  });
  // prune occasionally
  if (streamTickets.size > 5000) {
    const now = Date.now();
    for (const [k, v] of streamTickets) if (v.exp < now) streamTickets.delete(k);
  }
  return ticket;
}

function consumeStreamTicket(ticket, videoId) {
  const row = streamTickets.get(ticket);
  if (!row) return null;
  if (row.exp < Date.now()) { streamTickets.delete(ticket); return null; }
  if (row.videoId !== videoId) return null;
  // keep valid for range requests during playback — do not delete immediately
  return row;
}


function detectVideoMagic(buf) {
  if (!buf || buf.length < 12) return null;
  // WebM / Matroska EBML
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { mime: 'video/webm', ext: '.webm' };
  }
  // MP4 / ISO BMFF — ftyp box
  const brand = buf.slice(4, 8).toString('ascii');
  if (brand === 'ftyp') {
    return { mime: 'video/mp4', ext: '.mp4' };
  }
  return null;
}

function safeKey() {
  return crypto.randomBytes(16).toString('hex');
}

function pathForKey(key) {
  // Prevent path traversal — key is hex only
  if (!/^[a-f0-9]+(\.(mp4|webm))?$/i.test(key)) {
    throw Object.assign(new Error('Invalid storage key'), { code: 'BAD_KEY' });
  }
  return path.join(VIDEO_DIR, key);
}

function profileVideoSettings(userId) {
  let p = db.prepare('SELECT videos_enabled, default_video_visibility FROM profiles WHERE user_id=?').get(userId);
  if (!p) {
    db.prepare('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)').run(userId);
    p = { videos_enabled: 1, default_video_visibility: 'public' };
  }
  return {
    videosEnabled: p.videos_enabled !== 0,
    defaultVisibility: ['public', 'unlisted', 'private'].includes(p.default_video_visibility)
      ? p.default_video_visibility
      : 'public'
  };
}

function setProfileVideoSettings(userId, { videosEnabled, defaultVisibility }) {
  db.prepare('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)').run(userId);
  if (typeof videosEnabled === 'boolean') {
    db.prepare('UPDATE profiles SET videos_enabled=? WHERE user_id=?').run(videosEnabled ? 1 : 0, userId);
  }
  if (defaultVisibility && ['public', 'unlisted', 'private'].includes(defaultVisibility)) {
    db.prepare('UPDATE profiles SET default_video_visibility=? WHERE user_id=?').run(defaultVisibility, userId);
  }
  return profileVideoSettings(userId);
}

function canView(video, viewerId, isAdmin) {
  if (!video || video.status === 'deleted') return false;
  if (video.moderation_status === 'removed' || video.moderation_status === 'restricted') {
    return !!(isAdmin || (viewerId && viewerId === video.owner_id));
  }
  if (video.owner_id === viewerId || isAdmin) return true;
  if (video.visibility === 'private') return false;
  if (video.visibility === 'unlisted') return true; // link-only; not in discovery
  if (video.visibility === 'public') {
    const settings = profileVideoSettings(video.owner_id);
    return settings.videosEnabled;
  }
  return false;
}

function publicRow(video, extra = {}) {
  const owner = db.prepare('SELECT username, display_name FROM users WHERE id=?').get(video.owner_id);
  let game = null;
  if (video.game_id) {
    const g = db.prepare(
      `SELECT id, name, thumbnail, state FROM games WHERE id=?`
    ).get(video.game_id);
    if (g && g.state === 'PUBLISHED') {
      game = { id: g.id, name: g.name, thumbnail: g.thumbnail || null };
    }
  }
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    visibility: video.visibility,
    status: video.status,
    mime: video.mime,
    sizeBytes: video.size_bytes,
    durationSec: video.duration_sec,
    viewCount: video.view_count || 0,
    createdAt: video.created_at,
    publishedAt: video.published_at,
    owner: owner ? { username: owner.username, displayName: owner.display_name } : null,
    game,
    hasThumb: !!video.thumb_key,
    ...extra
  };
}

function getVideo(id) {
  return db.prepare('SELECT * FROM videos WHERE id=?').get(id);
}

function createFromUpload({
  ownerId,
  title,
  description,
  visibility,
  gameId,
  buffer,
  declaredMime
}) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw Object.assign(new Error('No file'), { code: 'NO_FILE' });
  }
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('File too large'), { code: 'TOO_LARGE' });
  }
  if (buffer.length < 32) {
    throw Object.assign(new Error('File too small'), { code: 'BAD_FILE' });
  }

  // Rate limit
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = db.prepare(
    `SELECT COUNT(*) as c FROM videos WHERE owner_id=? AND created_at > ? AND status != 'deleted'`
  ).get(ownerId, hourAgo).c;
  if (recent >= MAX_UPLOADS_PER_HOUR) {
    throw Object.assign(new Error('Upload rate limit'), { code: 'RATE' });
  }

  const magic = detectVideoMagic(buffer);
  if (!magic) {
    throw Object.assign(new Error('Unsupported or invalid video format (MP4/WebM only)'), { code: 'BAD_FORMAT' });
  }
  if (declaredMime && !ALLOWED_MIME.has(declaredMime) && declaredMime !== 'application/octet-stream') {
    // still trust magic over client MIME
  }

  const cleanTitle = String(title || 'Untitled clip').trim().slice(0, MAX_TITLE) || 'Untitled clip';
  const cleanDesc = String(description || '').trim().slice(0, MAX_DESC);
  let vis = visibility;
  if (!['public', 'unlisted', 'private'].includes(vis)) {
    vis = profileVideoSettings(ownerId).defaultVisibility;
  }

  if (gameId) {
    const g = db.prepare('SELECT id, state, creator_id FROM games WHERE id=?').get(gameId);
    if (!g) throw Object.assign(new Error('Game not found'), { code: 'NO_GAME' });
    // Only associate published games (or own drafts for private notes — require published for public links)
    if (g.state !== 'PUBLISHED' && g.creator_id !== ownerId) {
      throw Object.assign(new Error('Game not available'), { code: 'NO_GAME' });
    }
  }

  const id = uuid();
  const key = safeKey() + magic.ext;
  const full = pathForKey(key);
  ensureDirs();

const streamTickets = new Map(); // ticket -> { videoId, userId, exp }

function createStreamTicket(videoId, userId) {
  const ticket = crypto.randomBytes(24).toString('hex');
  streamTickets.set(ticket, {
    videoId,
    userId: userId || null,
    exp: Date.now() + 120000 // 2 minutes
  });
  // prune occasionally
  if (streamTickets.size > 5000) {
    const now = Date.now();
    for (const [k, v] of streamTickets) if (v.exp < now) streamTickets.delete(k);
  }
  return ticket;
}

function consumeStreamTicket(ticket, videoId) {
  const row = streamTickets.get(ticket);
  if (!row) return null;
  if (row.exp < Date.now()) { streamTickets.delete(ticket); return null; }
  if (row.videoId !== videoId) return null;
  // keep valid for range requests during playback — do not delete immediately
  return row;
}

  fs.writeFileSync(full, buffer);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO videos
     (id, owner_id, game_id, title, description, visibility, status, storage_key, mime, size_bytes, created_at, updated_at, published_at, moderation_status)
     VALUES (?,?,?,?,?,?, 'ready', ?,?,?,?,?,?, 'ok')`
  ).run(
    id,
    ownerId,
    gameId || null,
    cleanTitle,
    cleanDesc,
    vis,
    key,
    magic.mime,
    buffer.length,
    now,
    now,
    vis === 'public' || vis === 'unlisted' ? now : null
  );

  return publicRow(getVideo(id));
}

function updateMeta(ownerId, videoId, patch, isAdmin) {
  const v = getVideo(videoId);
  if (!v || v.status === 'deleted') throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
  if (v.owner_id !== ownerId && !isAdmin) throw Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' });

  let title = v.title;
  let description = v.description;
  let visibility = v.visibility;
  let gameId = v.game_id;

  if (patch.title != null) title = String(patch.title).trim().slice(0, MAX_TITLE) || title;
  if (patch.description != null) description = String(patch.description).trim().slice(0, MAX_DESC);
  if (patch.visibility != null) {
    if (!['public', 'unlisted', 'private'].includes(patch.visibility)) {
      throw Object.assign(new Error('Invalid visibility'), { code: 'BAD_VIS' });
    }
    visibility = patch.visibility;
  }
  if (patch.gameId !== undefined) {
    if (patch.gameId === null || patch.gameId === '') gameId = null;
    else {
      const g = db.prepare('SELECT id, state FROM games WHERE id=?').get(patch.gameId);
      if (!g || g.state !== 'PUBLISHED') throw Object.assign(new Error('Game not available'), { code: 'NO_GAME' });
      gameId = g.id;
    }
  }

  const now = new Date().toISOString();
  let publishedAt = v.published_at;
  if ((visibility === 'public' || visibility === 'unlisted') && !publishedAt) publishedAt = now;
  if (visibility === 'private') publishedAt = null;

  db.prepare(
    `UPDATE videos SET title=?, description=?, visibility=?, game_id=?, updated_at=?, published_at=? WHERE id=?`
  ).run(title, description, visibility, gameId, now, publishedAt, videoId);

  return publicRow(getVideo(videoId));
}

function softDelete(ownerId, videoId, isAdmin) {
  const v = getVideo(videoId);
  if (!v || v.status === 'deleted') throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
  if (v.owner_id !== ownerId && !isAdmin) throw Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' });

  db.prepare(`UPDATE videos SET status='deleted', visibility='private', updated_at=? WHERE id=?`)
    .run(new Date().toISOString(), videoId);

  // Cleanup file
  try {
    const fp = pathForKey(v.storage_key);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}
  if (v.thumb_key) {
    try {
      const tp = path.join(THUMB_DIR, path.basename(v.thumb_key));
      if (fs.existsSync(tp)) fs.unlinkSync(tp);
    } catch (_) {}
  }
  return { ok: true };
}

function listPublic({ page = 1, limit = 20, gameId = null } = {}) {
  const lim = Math.min(40, Math.max(1, Number(limit) || 20));
  const offset = (Math.max(1, Number(page) || 1) - 1) * lim;
  let sql = `
    SELECT v.* FROM videos v
    JOIN profiles p ON p.user_id = v.owner_id
    JOIN users u ON u.id = v.owner_id
    WHERE v.status = 'ready'
      AND v.visibility = 'public'
      AND v.moderation_status = 'ok'
      AND p.videos_enabled = 1
      AND u.status = 'active'
  `;
  const args = [];
  if (gameId) {
    sql += ` AND v.game_id = ?`;
    args.push(gameId);
  }
  sql += ` ORDER BY COALESCE(v.published_at, v.created_at) DESC LIMIT ? OFFSET ?`;
  args.push(lim, offset);
  return db.prepare(sql).all(...args).map((r) => publicRow(r));
}

function listOwner(ownerId, { includePrivate = true } = {}) {
  const rows = db.prepare(
    `SELECT * FROM videos WHERE owner_id=? AND status != 'deleted' ORDER BY created_at DESC`
  ).all(ownerId);
  return rows
    .filter((v) => includePrivate || v.visibility === 'public')
    .map((r) => publicRow(r));
}

function listProfilePublic(username) {
  const u = db.prepare(`SELECT id, status FROM users WHERE username=? COLLATE NOCASE`).get(username);
  if (!u || u.status !== 'active') return { enabled: false, videos: [] };
  const settings = profileVideoSettings(u.id);
  if (!settings.videosEnabled) return { enabled: false, videos: [] };
  const rows = db.prepare(
    `SELECT * FROM videos WHERE owner_id=? AND status='ready' AND visibility='public' AND moderation_status='ok' ORDER BY published_at DESC`
  ).all(u.id);
  return { enabled: true, videos: rows.map((r) => publicRow(r)) };
}

function recordView(videoId, viewerKey) {
  const day = new Date().toISOString().slice(0, 10);
  const key = String(viewerKey || 'anon').slice(0, 64);
  try {
    db.prepare(`INSERT OR IGNORE INTO video_views (video_id, viewer_key, day) VALUES (?,?,?)`)
      .run(videoId, key, day);
    const changes = db.prepare(`SELECT changes() as c`).get().c;
    if (changes > 0) {
      db.prepare(`UPDATE videos SET view_count = view_count + 1 WHERE id=?`).run(videoId);
    }
  } catch (_) {}
}

function reportVideo({ videoId, reporterId, reason }) {
  const v = getVideo(videoId);
  if (!v || v.status === 'deleted') throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
  const r = String(reason || 'inappropriate').trim().slice(0, 200);
  db.prepare(
    `INSERT OR IGNORE INTO video_reports (id, video_id, reporter_id, reason, created_at) VALUES (?,?,?,?,?)`
  ).run(uuid(), videoId, reporterId, r, new Date().toISOString());
  return { ok: true };
}

function moderate(videoId, { status }, adminId) {
  if (!['ok', 'restricted', 'removed'].includes(status)) {
    throw Object.assign(new Error('Bad status'), { code: 'BAD' });
  }
  const v = getVideo(videoId);
  if (!v) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
  db.prepare(`UPDATE videos SET moderation_status=?, updated_at=? WHERE id=?`)
    .run(status, new Date().toISOString(), videoId);
  if (status === 'removed') {
    db.prepare(`UPDATE videos SET visibility='private', status='deleted' WHERE id=?`).run(videoId);
  }
  return publicRow(getVideo(videoId));
}

function readFileStream(video) {
  const fp = pathForKey(video.storage_key);
  if (!fs.existsSync(fp)) return null;
  return { path: fp, mime: video.mime, size: video.size_bytes };
}

module.exports = {
  createStreamTicket,
  consumeStreamTicket,
  MAX_BYTES,
  ALLOWED_MIME,
  createFromUpload,
  updateMeta,
  softDelete,
  listPublic,
  listOwner,
  listProfilePublic,
  getVideo,
  canView,
  publicRow,
  recordView,
  reportVideo,
  moderate,
  readFileStream,
  profileVideoSettings,
  setProfileVideoSettings,
  detectVideoMagic,
  VIDEO_DIR
};
