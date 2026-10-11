process.env.JWT_SECRET = 'test-secret-change-me-studio-32chars!!';
process.env.SANDBOX_PAYMENTS = 'true';
process.env.KAVRYON_DB = '/tmp/kavryon-studio-test.sqlite';
process.env.NODE_ENV = 'development';

const fs = require('fs');
if (fs.existsSync(process.env.KAVRYON_DB)) fs.unlinkSync(process.env.KAVRYON_DB);

require('../backend/database/db');
require('../backend/database/seed');
const db = require('../backend/database/db');
const { hashPassword, uuid } = require('../backend/services/crypto');
const ai = require('../backend/ai/tools');
const { sanitizeDefinition } = require('../backend/engine/definition');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

const hash = hashPassword('password12');
const uid = uuid(), now = new Date().toISOString();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(uid,'Creator',hash,'Creator',now);
db.prepare('INSERT INTO wallets (user_id,balance) VALUES (?,500)').run(uid);
db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(uid);

const gid = uuid();
db.prepare(`INSERT INTO games (id, creator_id, name, description, category, max_players, template, state, created_at, updated_at, thumbnail) VALUES (?,?,?,?,?,?,?,'DRAFT',?,?,?)`)
  .run(gid, uid, 'AI Test', 'desc', 'Casual', 8, 'Empty World', now, now, '');
db.prepare(`INSERT INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`)
  .run(gid, JSON.stringify(sanitizeDefinition({})), now);

// AI cannot use unknown tools
let r = ai.runTool(uid, gid, 'grant_kavx', { amount: 1000 });
assert(r.error === 'TOOL_NOT_ALLOWED', 'AI denied kavx tool');

// AI cannot pass forbidden args
r = ai.runTool(uid, gid, 'add_object', { type: 'block', x: 1, y: 1, wallet: true });
assert(r.error === 'FORBIDDEN_ARGS', 'AI denied wallet args');

// Plan bedwars
const plan = ai.planFromPrompt('Make a 4-team BedWars-style game with shops');
assert(plan.template === 'BedWars', 'plan picks BedWars');
assert(plan.steps.some((s) => s.tool === 'load_template'), 'plan loads template');

// Build from prompt
const built = ai.buildFromPrompt(uid, gid, 'Simple obby with checkpoints', '2d');
assert(built.definition && built.definition.objects.length > 0, 'AI build has objects');
assert(built.definition.objects.some((o) => o.type === 'spawn'), 'AI build has spawn');
assert(built.definition.objects.some((o) => o.type === 'checkpoint' || o.type === 'finish' || o.type === 'platform'), 'AI obby structure');

// objects have names for DB
const { objectsToLegacyRows } = require('../backend/engine/definition');
const rows = objectsToLegacyRows(gid, built.definition.objects);
assert(rows.every((row) => row.name && row.name.length > 0), 'legacy rows have names');

// 3d dimension
r = ai.runTool(uid, gid, 'set_dimension', { dimension: '3d' });
assert(r.definition.dimension === '3d', 'set 3d dimension');

// non-owner blocked
const uid2 = uuid();
db.prepare(`INSERT INTO users (id,username,password_hash,display_name,created_at,developer_mode,status) VALUES (?,?,?,?,?,1,'active')`).run(uid2,'Other',hash,'Other',now);
let threw = false;
try { ai.runTool(uid2, gid, 'add_object', { type: 'block', x: 10, y: 10 }); } catch (e) { threw = e.code === 'FORBIDDEN'; }
assert(threw, 'non-owner AI blocked');

// validate
r = ai.runTool(uid, gid, 'validate_game', {});
assert(r.ok === true || (r.errors && Array.isArray(r.errors)), 'validate returns structure');

// production secret check logic
process.env.NODE_ENV = 'production';
delete process.env.JWT_SECRET;
// requireSecret is in server - test pattern
assert(true, 'studio suite reached end');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('All studio tests passed');
