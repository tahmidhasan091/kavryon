PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_id TEXT DEFAULT 'default',
  developer_mode INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  role TEXT NOT NULL DEFAULT 'player',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio TEXT DEFAULT '',
  body TEXT DEFAULT 'core',
  head TEXT DEFAULT 'round',
  hair TEXT DEFAULT 'short',
  face TEXT DEFAULT 'calm',
  outfit TEXT DEFAULT 'trailcoat',
  accessory TEXT DEFAULT 'none'
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_jti TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)
);

CREATE TABLE IF NOT EXISTS currency_transactions (
  transaction_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KAVX',
  purchase_id TEXT,
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_transaction_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  verified_at TEXT,
  raw_receipt_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(provider, provider_transaction_id)
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  UNIQUE(from_user_id, to_user_id)
);

CREATE TABLE IF NOT EXISTS friends (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  thumbnail TEXT DEFAULT '',
  max_players INTEGER NOT NULL DEFAULT 8,
  min_players INTEGER NOT NULL DEFAULT 1,
  template TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'free-for-all',
  friendly_fire INTEGER NOT NULL DEFAULT 0,
  respawn INTEGER NOT NULL DEFAULT 1,
  duration_sec INTEGER NOT NULL DEFAULT 300,
  state TEXT NOT NULL DEFAULT 'DRAFT',
  likes INTEGER NOT NULL DEFAULT 0,
  plays INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  published_version INTEGER DEFAULT 0,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_versions (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  scripts_json TEXT DEFAULT '[]',
  objects_json TEXT DEFAULT '[]',
  publisher_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(game_id, version)
);

CREATE TABLE IF NOT EXISTS game_objects (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  rotation REAL NOT NULL DEFAULT 0,
  scale_x REAL NOT NULL DEFAULT 1,
  scale_y REAL NOT NULL DEFAULT 1,
  collision INTEGER NOT NULL DEFAULT 1,
  visibility INTEGER NOT NULL DEFAULT 1,
  props_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS game_scripts (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_servers (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'local',
  max_players INTEGER NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'online',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_players (
  server_id TEXT NOT NULL REFERENCES game_servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  qty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS creator_earnings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_tx_user ON currency_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_games_state ON games(state);

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
