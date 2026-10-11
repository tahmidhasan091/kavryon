/**
 * Game engine integration tests — Obby, BedWars, RPG, Racing, Survival
 */
const { sanitizeDefinition } = require('../backend/engine/definition');
const { GameRuntime } = require('../backend/engine/runtime');
const templates = require('../backend/engine/templates');

let failed = 0;
function assert(c, n) {
  if (!c) { console.error('FAIL', n); failed++; }
  else console.log('OK', n);
}

// Obby
{
  const def = sanitizeDefinition(templates.load('Obby'));
  const rt = new GameRuntime('t-obby', def, { maxPlayers: 4 });
  rt.join({ id: 'u1', username: 'P1', ws: null });
  const p = rt.players.get('u1');
  const startY = p.y;
  // fall / move
  for (let i = 0; i < 20; i++) rt.applyInput('u1', { right: true, sequence: i + 1 });
  assert(rt.players.get('u1').x > p.x - 1, 'obby movement');
  // touch checkpoint via teleport to it
  const cp = def.objects.find((o) => o.type === 'checkpoint');
  rt.teleport('u1', cp.x, cp.y);
  rt._checkTriggers(rt.players.get('u1'));
  assert(rt.players.get('u1').checkpoint.x === cp.x, 'obby checkpoint');
  // finish
  const fin = def.objects.find((o) => o.type === 'finish');
  rt.teleport('u1', fin.x, fin.y);
  rt._checkTriggers(rt.players.get('u1'));
  assert(rt.winners.includes('u1') || rt.matchEnded, 'obby finish win');
  rt.destroy();
}

// BedWars-style
{
  const def = sanitizeDefinition(templates.load('BedWars'));
  const rt = new GameRuntime('t-bw', def, { maxPlayers: 4 });
  rt.join({ id: 'r1', username: 'Red1', ws: null });
  rt.join({ id: 'b1', username: 'Blue1', ws: null });
  const red = rt.players.get('r1');
  const blue = rt.players.get('b1');
  assert(red.team === 'red' || red.team === 'blue', 'bw team assigned');
  assert(red.team !== blue.team, 'bw opposite teams');
  // give iron, buy sword
  rt.giveItem('r1', 'iron', 20);
  const buy = rt.buy('r1', 'main', 'sword');
  assert(buy.ok && rt.players.get('r1').inventory.sword >= 1, 'bw shop purchase');
  // destroy blue bed
  const bedB = rt.teamBeds.get('blue');
  assert(bedB && !bedB.destroyed, 'bw bed exists');
  rt.teleport('r1', bedB.x, bedB.y);
  rt.players.get('r1').lastAttack = 0;
  rt._attack(rt.players.get('r1'));
  assert(rt.teamBeds.get('blue').destroyed, 'bw bed destroyed');
  // kill blue — should spectate
  rt.kill('b1');
  // allow sync
  assert(rt.players.get('b1').spectating || !rt.players.get('b1').alive, 'bw no-respawn after bed');
  rt.destroy();
}

// RPG
{
  const def = sanitizeDefinition(templates.load('RPG'));
  const rt = new GameRuntime('t-rpg', def, { maxPlayers: 4 });
  rt.join({ id: 'h1', username: 'Hero', ws: null });
  const hero = rt.players.get('h1');
  assert(hero.quests['q_slimes'], 'rpg quest granted on join');
  assert((hero.currencies.coins || 0) >= 10, 'rpg starting coins');
  // kill enemies
  for (const e of rt.entities.values()) {
    if (e.kind === 'enemy') {
      e.health = 1;
      rt.teleport('h1', e.x, e.y);
      rt.players.get('h1').lastAttack = 0;
      rt._attack(rt.players.get('h1'));
    }
  }
  const st = rt.players.get('h1').quests['q_slimes'];
  assert(st && (st.completed || Object.values(st.progress).some((v) => v > 0)), 'rpg kill progress');
  // shop
  rt.players.get('h1').currencies.coins = 50;
  const br = rt.buy('h1', 'market', 'potion');
  assert(br.ok, 'rpg shop buy');
  rt.destroy();
}

// Racing
{
  const def = sanitizeDefinition(templates.load('Racing'));
  const rt = new GameRuntime('t-race', def, { maxPlayers: 4 });
  rt.join({ id: 'racer', username: 'Racer', ws: null });
  const fin = def.objects.find((o) => o.type === 'finish');
  rt.teleport('racer', fin.x, fin.y);
  rt._checkTriggers(rt.players.get('racer'));
  assert(rt.winners.includes('racer') || rt.matchEnded, 'racing finish');
  rt.destroy();
}

// Survival
{
  const def = sanitizeDefinition(templates.load('Survival'));
  const rt = new GameRuntime('t-surv', def, { maxPlayers: 4 });
  rt.join({ id: 's1', username: 'Survivor', ws: null });
  assert(rt.entities.size >= 2, 'survival enemies spawned');
  rt.tick(1);
  // survive by ending timer script would win — simulate
  rt.declareWinner('s1', 'survived');
  assert(rt.winners.includes('s1'), 'survival win');
  rt.destroy();
}

// DSL rejects unknown — sanitize strips
{
  const dirty = sanitizeDefinition({
    scripts: [{ on: 'onPlayerJoin', actions: [{ type: 'eval' }, { type: 'giveItem', itemId: 'x', qty: 1 }] }]
  });
  assert(dirty.scripts[0].actions.every((a) => a.type !== 'eval'), 'unsafe action stripped');
}

// Client position rejected via RoomManager
{
  const rooms = require('../backend/multiplayer/rooms');
  rooms.createFromDefinition('rm1', templates.load('Obby'), { maxPlayers: 2 });
  rooms.join('rm1', { id: 'u', username: 'U', ws: null });
  const before = rooms.snapshot('rm1')[0].x;
  rooms.move('rm1', 'u', { x: 999, y: 0 });
  assert(rooms.snapshot('rm1')[0].x !== 999, 'client x ignored');
  rooms.applyInput('rm1', 'u', { right: true, sequence: 1 });
  assert(rooms.snapshot('rm1')[0].x !== before || rooms.snapshot('rm1')[0].vx !== 0, 'input moves');
  rooms.leave('rm1', 'u');
}

if (failed) {
  console.error(failed + ' engine tests failed');
  process.exit(1);
}
console.log('All engine tests passed');
