/**
 * Idempotent schema migration for Kavryon / Kavx.
 * Never deletes balances. Safe to run twice.
 */
const db = require('./db');

function columnExists(table, col) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((r) => r.name === col);
  } catch {
    return false;
  }
}

function tableExists(name) {
  const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return !!r;
}

function migrate() {
  // Schema additions (IF NOT EXISTS)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creator_rewards (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      game_id TEXT,
      event_type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      unique_event_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gifts (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      sender_tx_id TEXT,
      recipient_tx_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      data_json TEXT DEFAULT '{}',
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS economy_daily (
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      gift_sent_amount INTEGER NOT NULL DEFAULT 0,
      gift_sent_count INTEGER NOT NULL DEFAULT 0,
      creator_earned INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );

    CREATE TABLE IF NOT EXISTS creator_game_daily (
      creator_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      day TEXT NOT NULL,
      earned INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (creator_id, game_id, day)
    );

    CREATE INDEX IF NOT EXISTS idx_gifts_sender ON gifts(sender_id);
    CREATE INDEX IF NOT EXISTS idx_gifts_recipient ON gifts(recipient_id);
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_rewards_creator ON creator_rewards(creator_id);
    
    CREATE TABLE IF NOT EXISTS player_game_data (
      game_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (game_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS game_definitions (
      game_id TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_likes (
      game_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (game_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      target_user_id TEXT,
      amount INTEGER,
      reason TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_versions (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      scripts_json TEXT DEFAULT '[]',
      objects_json TEXT DEFAULT '[]',
      publisher_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(game_id, version)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id TEXT NOT NULL,
      blocked_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id)
    );

    CREATE TABLE IF NOT EXISTS game_invites (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      server_id TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invites_receiver ON game_invites(receiver_id, status);
    CREATE INDEX IF NOT EXISTS idx_invites_game ON game_invites(game_id, status);

    CREATE TABLE IF NOT EXISTS ws_tickets (
      ticket_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

  `);

  // Mark currency display migration without changing balances
  const mid = 'kavx_currency_label_v1';
  const done = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(mid);
  if (!done) {
    // Update stored currency label on existing rows for display consistency (balances unchanged)
    try {
      db.prepare(`UPDATE currency_transactions SET currency = 'KAVX' WHERE currency = 'VYN' OR currency = 'Vyn' OR currency IS NULL`).run();
    } catch (_) {}
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(mid, new Date().toISOString());
  }


  try {
    if (!columnExists('games', 'thumbnail')) {
      db.exec("ALTER TABLE games ADD COLUMN thumbnail TEXT DEFAULT ''");
    }
  } catch (e) { /* ignore */ }

  
  try {
    const cols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
    if (!cols.includes('refresh_token_hash')) db.exec('ALTER TABLE sessions ADD COLUMN refresh_token_hash TEXT');
    if (!cols.includes('revoked_at')) db.exec('ALTER TABLE sessions ADD COLUMN revoked_at TEXT');
    if (!cols.includes('last_used_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_used_at TEXT');
  } catch (_) {}
  
  try {
    const cols = db.prepare('PRAGMA table_info(games)').all().map(c => c.name);
    if (!cols.includes('published_at')) db.exec("ALTER TABLE games ADD COLUMN published_at TEXT");
    if (!cols.includes('published_version')) db.exec('ALTER TABLE games ADD COLUMN published_version INTEGER DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_games_state_pub ON games(state, published_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_games_plays ON games(state, plays)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_games_likes ON games(state, likes)');
  } catch (_) {}

  // Video clips
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      game_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'private',
      status TEXT NOT NULL DEFAULT 'ready',
      storage_key TEXT NOT NULL UNIQUE,
      thumb_key TEXT,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      duration_sec REAL,
      width INTEGER,
      height INTEGER,
      view_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      moderation_status TEXT NOT NULL DEFAULT 'ok'
    );
    CREATE INDEX IF NOT EXISTS idx_videos_owner ON videos(owner_id);
    CREATE INDEX IF NOT EXISTS idx_videos_visibility ON videos(visibility, status, moderation_status);
    CREATE INDEX IF NOT EXISTS idx_videos_game ON videos(game_id);
    CREATE TABLE IF NOT EXISTS video_views (
      video_id TEXT NOT NULL,
      viewer_key TEXT NOT NULL,
      day TEXT NOT NULL,
      PRIMARY KEY (video_id, viewer_key, day)
    );
    CREATE TABLE IF NOT EXISTS video_reports (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      reporter_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(video_id, reporter_id)
    );
  `);
  if (!columnExists('profiles', 'videos_enabled')) {
    try { db.exec(`ALTER TABLE profiles ADD COLUMN videos_enabled INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
  }
  if (!columnExists('profiles', 'default_video_visibility')) {
    try { db.exec(`ALTER TABLE profiles ADD COLUMN default_video_visibility TEXT NOT NULL DEFAULT 'public'`); } catch (_) {}
  }


  // Team Studio collaboration
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_members (
      game_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (game_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

    CREATE TABLE IF NOT EXISTS project_invites (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      inviter_id TEXT NOT NULL,
      invitee_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      responded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_project_invites_invitee ON project_invites(invitee_id, status);

    CREATE TABLE IF NOT EXISTS project_activity (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      user_id TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_activity_game ON project_activity(game_id, created_at);

    CREATE TABLE IF NOT EXISTS project_revisions (
      game_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
  `);

  return { ok: true };


}


module.exports = { migrate };
