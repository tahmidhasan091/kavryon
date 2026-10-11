/**
 * Restricted AI Game Creation tools.
 * AI may ONLY mutate the owned game definition — never wallet, auth, or admin.
 */
const { sanitizeDefinition } = require('../engine/definition');
const templates = require('../engine/templates');
const db = require('../database/db');
const { uuid } = require('../services/crypto');
const { objectsToLegacyRows } = require('../engine/definition');
const undo = require('./undo');

const ALLOWED_TOOLS = new Set([
  'list_tools',
  'get_definition',
  'load_template',
  'set_dimension',
  'set_rules',
  'add_object',
  'update_object',
  'delete_object',
  'add_team',
  'add_npc',
  'add_item',
  'add_shop',
  'add_quest',
  'add_script',
  'clear_scripts',
  'validate_game',
  'plan_build',
  'undo_last'
]);

function assertOwner(userId, gameId) {
  const g = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!g) { const e = new Error('Game not found'); e.code = 'NOT_FOUND'; throw e; }
  if (g.creator_id !== userId) { const e = new Error('Not your game'); e.code = 'FORBIDDEN'; throw e; }
  if (g.state === 'PUBLISHED') { const e = new Error('Unpublish or edit draft version first'); e.code = 'PUBLISHED'; throw e; }
  return g;
}

function loadDef(gameId) {
  const row = db.prepare('SELECT definition_json FROM game_definitions WHERE game_id=?').get(gameId);
  if (row) return sanitizeDefinition(JSON.parse(row.definition_json));
  return sanitizeDefinition({});
}

function saveDef(gameId, def) {
  try {
    const prev = db.prepare('SELECT definition_json FROM game_definitions WHERE game_id=?').get(gameId);
    if (prev) undo.pushSnapshot(gameId, prev.definition_json);
  } catch (_) {}
  const d = sanitizeDefinition(def);
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`).run(gameId, JSON.stringify(d), now);
  db.prepare('DELETE FROM game_objects WHERE game_id=?').run(gameId);
  for (const row of objectsToLegacyRows(gameId, d.objects)) {
    db.prepare(`INSERT INTO game_objects (id,game_id,type,name,x,y,scale_x,scale_y,rotation,collision,visibility,props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, gameId, row.type, row.name, row.x, row.y, row.scale_x, row.scale_y, row.rotation, row.collision, row.visibility, row.props_json);
  }
  db.prepare(`INSERT INTO audit_log (id, actor_user_id, action, target_user_id, amount, reason, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(uuid(), null, 'AI_GAME_EDIT', null, 0, gameId, JSON.stringify({ objects: d.objects.length }), now);
  return d;
}

function logAction(userId, gameId, tool, status, detail) {
  try {
    db.prepare(`INSERT INTO audit_log (id, actor_user_id, action, target_user_id, amount, reason, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(uuid(), userId, 'AI_TOOL', null, 0, status, JSON.stringify({ gameId, tool, detail: String(detail || '').slice(0, 200) }), new Date().toISOString());
  } catch (_) {}
}

/**
 * Deterministic "AI" planner — no external LLM required.
 * Interprets natural language into tool calls for common game types.
 */
function planFromPrompt(prompt, dimension = '2d') {
  const p = String(prompt || '').toLowerCase();
  const steps = [];
  let template = 'Empty World';
  if (/bed\s*wars|bedwars/.test(p)) template = 'BedWars';
  else if (/rpg|quest|fantasy/.test(p)) template = 'RPG';
  else if (/obby|obstacle/.test(p)) template = 'Obby';
  else if (/surviv/.test(p)) template = 'Survival';
  else if (/rac(e|ing)/.test(p)) template = 'Racing';
  else if (/horror/.test(p)) template = 'Horror';
  else if (/tycoon/.test(p)) template = 'Tycoon';
  else if (/simulat/.test(p)) template = 'Simulator';
  else if (/arena|fight/.test(p)) template = 'Arena';
  else if (/team/.test(p)) template = 'Team Battle';
  else if (/platform/.test(p)) template = 'Platformer';
  else if (/adventure/.test(p)) template = 'Adventure';

  steps.push({ tool: 'load_template', args: { name: template } });
  if (/3d|three.?d|first.?person|third.?person/.test(p) || dimension === '3d') {
    steps.push({ tool: 'set_dimension', args: { dimension: '3d' } });
  }
  if (/4.?team|four team/.test(p) && template === 'BedWars') {
    steps.push({ tool: 'add_team', args: { id: 'green', name: 'Green', color: '#4ade80' } });
    steps.push({ tool: 'add_team', args: { id: 'yellow', name: 'Yellow', color: '#facc15' } });
    steps.push({ tool: 'add_object', args: { type: 'spawn', x: 200, y: 100, team: 'green', name: 'Green Spawn' } });
    steps.push({ tool: 'add_object', args: { type: 'spawn', x: 400, y: 100, team: 'yellow', name: 'Yellow Spawn' } });
    steps.push({ tool: 'add_object', args: { type: 'bed', x: 200, y: 120, team: 'green', name: 'Green Bed' } });
    steps.push({ tool: 'add_object', args: { type: 'bed', x: 400, y: 120, team: 'yellow', name: 'Yellow Bed' } });
  }
  if (/open.?world|large/.test(p)) {
    steps.push({ tool: 'set_rules', args: { maxPlayers: 16 } });
  }
  steps.push({ tool: 'validate_game', args: {} });
  return { template, steps, summary: `Build from template "${template}" with ${steps.length} steps.` };
}

function runTool(userId, gameId, tool, args = {}) {
  if (!ALLOWED_TOOLS.has(tool)) {
    logAction(userId, gameId, tool, 'DENIED', 'unknown tool');
    return { error: 'TOOL_NOT_ALLOWED', tool };
  }
  // Forbidden: anything economy
  if (/kavx|wallet|gift|purchase|owner|admin|password|token/i.test(JSON.stringify(args))) {
    logAction(userId, gameId, tool, 'DENIED', 'forbidden arg');
    return { error: 'FORBIDDEN_ARGS' };
  }

  if (tool === 'list_tools') {
    return { tools: [...ALLOWED_TOOLS] };
  }
  if (tool === 'plan_build') {
    return planFromPrompt(args.prompt, args.dimension);
  }

  const g = assertOwner(userId, gameId);
  let def = loadDef(gameId);

  switch (tool) {
    case 'get_definition':
      logAction(userId, gameId, tool, 'OK', '');
      return { definition: def };
    case 'load_template': {
      const tpl = templates.load(args.name || 'Empty World');
      def = sanitizeDefinition({ ...tpl, dimension: def.dimension || tpl.dimension || '2d' });
      def = saveDef(gameId, def);
      logAction(userId, gameId, tool, 'OK', args.name);
      return { definition: def };
    }
    case 'set_dimension':
      def.dimension = args.dimension === '3d' ? '3d' : '2d';
      def = saveDef(gameId, def);
      return { definition: def };
    case 'set_rules':
      def.rules = { ...def.rules, ...sanitizeDefinition({ rules: args }).rules };
      def = saveDef(gameId, def);
      return { definition: def };
    case 'add_object': {
      const o = {
        id: args.id || `o_${uuid().slice(0, 8)}`,
        type: args.type || 'block',
        name: args.name || args.type || 'obj',
        label: args.name || '',
        x: Number(args.x) || 100,
        y: Number(args.y) || 200,
        w: Number(args.w) || 36,
        h: Number(args.h) || 20,
        team: args.team || null,
        collision: args.collision !== false,
        props: args.props || {}
      };
      def.objects.push(o);
      def = saveDef(gameId, def);
      logAction(userId, gameId, tool, 'OK', o.type);
      return { object: o, definition: def };
    }
    case 'update_object': {
      const o = def.objects.find((x) => x.id === args.id);
      if (!o) return { error: 'NOT_FOUND' };
      Object.assign(o, {
        x: args.x != null ? Number(args.x) : o.x,
        y: args.y != null ? Number(args.y) : o.y,
        w: args.w != null ? Number(args.w) : o.w,
        h: args.h != null ? Number(args.h) : o.h,
        type: args.type || o.type,
        name: args.name || o.name,
        team: args.team !== undefined ? args.team : o.team
      });
      def = saveDef(gameId, def);
      return { object: o, definition: def };
    }
    case 'delete_object':
      def.objects = def.objects.filter((x) => x.id !== args.id);
      def = saveDef(gameId, def);
      return { definition: def };
    case 'add_team':
      if (def.teams.length >= 8) return { error: 'LIMIT' };
      def.teams.push({ id: String(args.id || 'team').slice(0, 24), name: String(args.name || 'Team').slice(0, 32), color: String(args.color || '#5eead4').slice(0, 16) });
      def = saveDef(gameId, def);
      return { definition: def };
    case 'add_npc':
      def.npcs.push({
        id: args.id || `n_${uuid().slice(0, 8)}`,
        name: args.name || 'NPC',
        kind: args.kind || 'enemy',
        x: Number(args.x) || 200,
        y: Number(args.y) || 200,
        health: Number(args.health) || 50,
        damage: Number(args.damage) || 5,
        speed: Number(args.speed) || 1.2,
        ai: args.ai || 'chase',
        dialogue: String(args.dialogue || '').slice(0, 200),
        questId: args.questId || null,
        dropId: args.dropId || null
      });
      def = saveDef(gameId, def);
      return { definition: def };
    case 'add_item':
      def.items.push({
        id: args.id || `item_${uuid().slice(0, 6)}`,
        name: args.name || 'Item',
        type: args.type || 'misc',
        stack: Number(args.stack) || 1,
        damage: Number(args.damage) || 0,
        armor: Number(args.armor) || 0,
        price: Number(args.price) || 0,
        currency: args.currency || 'coins'
      });
      def = saveDef(gameId, def);
      return { definition: def };
    case 'add_shop':
      def.shops.push({
        id: args.id || `shop_${uuid().slice(0, 6)}`,
        name: args.name || 'Shop',
        listings: Array.isArray(args.listings) ? args.listings.slice(0, 20) : []
      });
      def = saveDef(gameId, def);
      return { definition: def };
    case 'add_quest':
      def.quests.push({
        id: args.id || `q_${uuid().slice(0, 6)}`,
        title: args.title || 'Quest',
        description: String(args.description || '').slice(0, 300),
        objectives: args.objectives || [],
        rewards: args.rewards || { xp: 10, coins: 5, items: [] }
      });
      def = saveDef(gameId, def);
      return { definition: def };
    case 'add_script': {
      const actions = Array.isArray(args.actions) ? args.actions : [];
      def.scripts.push({ on: String(args.on || 'onPlayerJoin').slice(0, 40), filter: args.filter || {}, actions });
      def = saveDef(gameId, def);
      return { definition: def };
    }
    case 'clear_scripts':
      def.scripts = [];
      def = saveDef(gameId, def);
      return { definition: def };
    case 'undo_last': {
      const snap = undo.popSnapshot(gameId);
      if (!snap) return { error: 'NOTHING_TO_UNDO', undoCount: 0 };
      const d = sanitizeDefinition(JSON.parse(snap.definition_json));
      // avoid re-pushing the undone state
      const now = new Date().toISOString();
      db.prepare(`INSERT OR REPLACE INTO game_definitions (game_id, definition_json, updated_at) VALUES (?,?,?)`).run(gameId, JSON.stringify(d), now);
      db.prepare('DELETE FROM game_objects WHERE game_id=?').run(gameId);
      for (const row of objectsToLegacyRows(gameId, d.objects)) {
        db.prepare(`INSERT INTO game_objects (id,game_id,type,name,x,y,scale_x,scale_y,rotation,collision,visibility,props_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(row.id, gameId, row.type, row.name, row.x, row.y, row.scale_x, row.scale_y, row.rotation, row.collision, row.visibility, row.props_json);
      }
      logAction(userId, gameId, tool, 'OK', 'undo');
      return { definition: d, undoCount: undo.peekCount(gameId) };
    }
    case 'validate_game': {
      const errors = [];
      const warnings = [];
      if (!def.objects.some((o) => o.type === 'spawn')) errors.push('Missing spawn point');
      if (def.objects.length > 200) errors.push('Too many objects');
      if (def.scripts.length > 60) errors.push('Too many scripts');
      if (def.dimension === '3d' && def.objects.length > 120) warnings.push('3D object count high for mobile');
      if (!def.objects.length) warnings.push('Empty world');
      logAction(userId, gameId, tool, errors.length ? 'FAIL' : 'OK', errors.join(','));
      return { ok: !errors.length, errors, warnings, definition: def };
    }
    default:
      return { error: 'UNHANDLED' };
  }
}

/**
 * Execute a full plan from natural language (deterministic builder, not an external LLM).
 */
function buildFromPrompt(userId, gameId, prompt, dimension) {
  assertOwner(userId, gameId);
  const plan = planFromPrompt(prompt, dimension);
  const results = [];
  for (const step of plan.steps) {
    const r = runTool(userId, gameId, step.tool, step.args || {});
    results.push({ tool: step.tool, result: r.error ? r : { ok: true } });
    if (r.error && step.tool !== 'validate_game') break;
  }
  return { plan, results, definition: loadDef(gameId) };
}


/**
 * Apply a structured plan (from local or external AI) through sandbox tools only.
 */
function applyPlan(userId, gameId, plan) {
  assertOwner(userId, gameId);
  const results = [];
  const steps = (plan && plan.steps) || [];
  for (const step of steps) {
    if (!step || !step.tool) continue;
    if (!ALLOWED_TOOLS.has(step.tool) && step.tool !== 'load_template') {
      results.push({ tool: step.tool, result: { error: 'Tool not allowed' } });
      continue;
    }
    const r = runTool(userId, gameId, step.tool, step.args || {});
    results.push({ tool: step.tool, result: r.error ? r : { ok: true } });
  }
  // Always validate at end
  const v = runTool(userId, gameId, 'validate_game', {});
  results.push({ tool: 'validate_game', result: v });
  return { plan, results, definition: loadDef(gameId) };
}

async function buildFromPromptAsync(userId, gameId, prompt, dimension, providerId) {
  assertOwner(userId, gameId);
  let plan;
  try {
    const aiProviders = require('../services/ai_providers');
    const out = await aiProviders.requestPlan({ userId, providerId, prompt, dimension });
    plan = out.plan || planFromPrompt(prompt, dimension);
    // Normalize plan.steps if LLM returns different shape
    if (plan && !plan.steps && plan.template) {
      plan = planFromPrompt('template ' + plan.template + ' ' + prompt, dimension);
    }
  } catch (_) {
    plan = planFromPrompt(prompt, dimension);
  }
  if (!plan || !plan.steps) plan = planFromPrompt(prompt, dimension);
  return applyPlan(userId, gameId, plan);
}

module.exports = { ALLOWED_TOOLS, runTool, buildFromPrompt, buildFromPromptAsync, applyPlan, planFromPrompt, assertOwner };

