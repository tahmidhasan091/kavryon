const { uuid, hashPassword } = require('../services/crypto');
const db = require('./db');
try { require('./migrate').migrate(); } catch (e) { console.error('Migration warning:', e.message); }

function seed() {
  const adminUser = process.env.ADMIN_BOOTSTRAP_USERNAME || 'kavryon_admin';
  let adminPass = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!adminPass) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('ADMIN_BOOTSTRAP_PASSWORD not set — skipping admin bootstrap in production');
      adminPass = null;
    } else {
      adminPass = 'ChangeThisAdminPassword';
    }
  }
  let admin = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(adminUser);
  if (!admin && adminPass) {
    const legacy = db.prepare(`SELECT * FROM users WHERE username = 'vyntrix_admin' COLLATE NOCASE`).get();
    if (legacy) {
      db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(adminUser, legacy.id);
      admin = db.prepare('SELECT * FROM users WHERE id = ?').get(legacy.id);
      console.log('[seed] Migrated legacy admin username to', adminUser);
    }
  }
  if (!admin && adminPass) {
    const id = uuid();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, display_name, avatar_id, developer_mode, status, role, created_at)
       VALUES (?, ?, ?, 'Kavryon Admin', 'default', 1, 'active', 'admin', ?)`
    ).run(id, adminUser, hashPassword(adminPass), now);
    db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(id);
    db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 0)').run(id);
    admin = { id };
  }

  const items = [
    ['item_trailcoat', 'Trailcoat', 'outfit'],
    ['item_facet_hair', 'Facet Hair', 'hair'],
    ['item_prism_pin', 'Prism Pin', 'accessory']
  ];
  for (const [id, name, kind] of items) {
    db.prepare('INSERT OR IGNORE INTO items (id, name, kind, data_json) VALUES (?, ?, ?, ?)').run(id, name, kind, '{}');
  }

  if (!admin || !admin.id) {
    console.warn('[seed] No admin — skipping demo games');
    return;
  }

  const demos = [
    ['Sky Arena', 'Open-air prism arena. Last team standing across floating facets.', 'Arena', 'Arena'],
    ['Neon Runner', 'Relay dashes through luminous corridors. Tag checkpoints as a squad.', 'Racing', 'Racing'],
    ['Crystal Survival', 'Hold the shard fields while hazards pulse across the map.', 'Survival', 'Survival'],
    ['Mystery Island', 'Co-op exploration of a faceted island with hidden goals.', 'Adventure', 'Empty World'],
    ['Block Battle', 'Competitive block control. Capture platforms, avoid hazards.', 'Casual', 'Platformer']
  ];

  const creatorId = admin.id;
  for (const [name, desc, cat, template] of demos) {
    const exists = db.prepare('SELECT id FROM games WHERE name = ?').get(name);
    if (exists) continue;
    const id = uuid();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO games (id, creator_id, name, description, category, max_players, template, state, likes, plays, created_at, updated_at, published_at, published_version, version)
       VALUES (?, ?, ?, ?, ?, 10, ?, 'PUBLISHED', 12, 40, ?, ?, ?, 1, 1)`
    ).run(id, creatorId, name, desc, cat, template, now, now, now);
    const add = (type, n, x, y) => {
      db.prepare(
        `INSERT INTO game_objects (id, game_id, type, name, x, y, rotation, scale_x, scale_y, collision, visibility, props_json)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, 1, 1, '{}')`
      ).run(uuid(), id, type, n, x, y);
    };
    add('spawn', 'A', 70, 220);
    add('spawn', 'B', 560, 220);
    add('block', 'Floor', 320, 340);
    add('platform', 'Mid', 320, 200);
    add('goal', 'Core', 320, 80);
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        `INSERT INTO game_servers (id, game_id, name, region, max_players, is_test, status, created_at)
         VALUES (?, ?, ?, 'local', 10, 0, 'online', ?)`
      ).run(uuid(), id, `Server ${i}`, now);
    }
  }

  // First playable showcase: Crystal Siege (BedWars-inspired, original)
  try {
    const templates = require('../engine/templates');
    const { sanitizeDefinition, objectsToLegacyRows } = require('../engine/definition');
    const existing = db.prepare(`SELECT id FROM games WHERE name = 'Crystal Siege' LIMIT 1`).get();
    if (!existing) {
      const def = sanitizeDefinition(templates.load('BedWars'));
      const gid = uuid();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO games (id, creator_id, name, description, category, max_players, template, state, likes, plays, created_at, updated_at, published_at, published_version, version)
         VALUES (?,?,?,?,?,8,'BedWars','PUBLISHED',5,0,?,?,?,1,1)`
      ).run(
        gid,
        admin.id,
        'Crystal Siege',
        'Protect your crystal. Collect iron and gold, buy gear at shops (press E), attack with J. Destroy the enemy crystal, then eliminate rivals. Last team standing wins.',
        'Arena',
        now,
        now,
        now
      );
      db.prepare(`INSERT OR REPLACE INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`)
        .run(gid, JSON.stringify(def), now);
      for (const row of objectsToLegacyRows(gid, def.objects || [])) {
        db.prepare(
          `INSERT INTO game_objects (id,game_id,type,name,x,y,scale_x,scale_y,rotation,collision,visibility,props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(row.id, gid, row.type, row.name, row.x, row.y, row.scale_x, row.scale_y, row.rotation, row.collision, row.visibility, row.props_json);
      }
      for (let i = 1; i <= 3; i++) {
        db.prepare(
          `INSERT INTO game_servers (id, game_id, name, region, max_players, is_test, status, created_at) VALUES (?,?,?,'local',8,0,'online',?)`
        ).run(uuid(), gid, 'Siege ' + i, now);
      }
      console.log('[seed] Crystal Siege published');
    }
  } catch (e) {
    console.warn('[seed] Crystal Siege skipped:', e.message);
  }
}

seed();
module.exports = { seed };
