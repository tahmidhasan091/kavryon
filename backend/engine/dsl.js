/**
 * Restricted game event DSL executor.
 * Actions are declarative JSON only — no eval, no require, no network.
 */
const MAX_ACTIONS_PER_TICK = 40;
const MAX_EVENTS_PER_SECOND = 80;

function matchFilter(filter, ctx) {
  if (!filter || !Object.keys(filter).length) return true;
  if (filter.objectType && ctx.object?.type !== filter.objectType) return false;
  if (filter.objectId && ctx.object?.id !== filter.objectId) return false;
  if (filter.team && ctx.player?.team !== filter.team) return false;
  if (filter.itemId && ctx.itemId !== filter.itemId) return false;
  if (filter.npcId && ctx.npc?.id !== filter.npcId) return false;
  if (filter.zone && ctx.zone !== filter.zone) return false;
  return true;
}

function runScripts(runtime, eventName, ctx) {
  if (runtime.disabled) return;
  runtime.eventCount = (runtime.eventCount || 0) + 1;
  if (runtime.eventCount > MAX_EVENTS_PER_SECOND * 5) {
    runtime.scriptErrors = (runtime.scriptErrors || 0) + 1;
    if (runtime.scriptErrors > 20) runtime.disabled = true;
    return;
  }
  let executed = 0;
  for (const sc of runtime.def.scripts || []) {
    if (sc.on !== eventName) continue;
    if (!matchFilter(sc.filter, ctx)) continue;
    for (const action of sc.actions || []) {
      if (executed++ > MAX_ACTIONS_PER_TICK) return;
      try {
        applyAction(runtime, action, ctx);
      } catch (e) {
        runtime.scriptErrors = (runtime.scriptErrors || 0) + 1;
        if (runtime.scriptErrors > 30) runtime.disabled = true;
      }
    }
  }
}

function applyAction(rt, action, ctx) {
  const p = ctx.player;
  const type = action.type;
  switch (type) {
    case 'broadcast':
      rt.broadcast({ type: 'message', text: String(action.message || action.text || '').slice(0, 120) });
      break;
    case 'message':
      if (p) rt.send(p.id, { type: 'message', text: String(action.message || '').slice(0, 120) });
      break;
    case 'setHealth':
      if (p) rt.setHealth(p.id, Number(action.value) || 0);
      break;
    case 'damage':
      if (p) rt.damage(p.id, Number(action.amount) || 0, ctx.sourceId || null);
      break;
    case 'heal':
      if (p) rt.heal(p.id, Number(action.amount) || 0);
      break;
    case 'kill':
      if (p) rt.kill(p.id);
      break;
    case 'respawn':
      if (p) rt.respawnPlayer(p.id);
      break;
    case 'teleport':
      if (p) rt.teleport(p.id, Number(action.x) || 0, Number(action.y) || 0);
      break;
    case 'setCheckpoint':
      if (p) {
        const oid = action.objectId || ctx.object?.id;
        const obj = (rt.def.objects || []).find((o) => o.id === oid) || ctx.object;
        if (obj) p.checkpoint = { x: obj.x, y: obj.y };
      }
      break;
    case 'giveItem':
      if (p) rt.giveItem(p.id, String(action.itemId || ''), Number(action.qty) || 1);
      break;
    case 'takeItem':
      if (p) rt.takeItem(p.id, String(action.itemId || ''), Number(action.qty) || 1);
      break;
    case 'addScore':
      if (p) p.score = (p.score || 0) + (Number(action.amount) || 0);
      break;
    case 'addXp':
      if (p) rt.addXp(p.id, Number(action.amount) || 0);
      break;
    case 'setTeam':
      if (p) p.team = String(action.team || '').slice(0, 24);
      break;
    case 'eliminateTeam':
      rt.eliminateTeam(String(action.team || ''));
      break;
    case 'startRound':
      rt.startRound();
      break;
    case 'endRound':
      rt.endRound(action.winnerTeam || null);
      break;
    case 'win':
      if (p) rt.declareWinner(p.id, action.reason || 'win');
      break;
    case 'lose':
      if (p) rt.declareLoser(p.id, action.reason || 'lose');
      break;
    case 'setTimer':
      rt.setTimer(String(action.name || 'main'), Number(action.seconds) || 0);
      break;
    case 'openShop':
      if (p) rt.send(p.id, { type: 'shop', shopId: action.shopId || ctx.object?.props?.shopId });
      break;
    case 'grantQuest':
      if (p) rt.grantQuest(p.id, String(action.questId || ''));
      break;
    case 'completeObjective':
      if (p) rt.completeObjective(p.id, String(action.questId || ''), String(action.objectiveId || ''));
      break;
    case 'spawnEntity':
      rt.spawnNpc(action);
      break;
    case 'setVar':
      rt.vars[String(action.name || '').slice(0, 32)] = action.value;
      break;
    case 'incVar': {
      const k = String(action.name || '').slice(0, 32);
      rt.vars[k] = (Number(rt.vars[k]) || 0) + (Number(action.amount) || 1);
      break;
    }
    case 'addCurrency':
      if (p) {
        const c = String(action.currency || 'coins');
        p.currencies = p.currencies || {};
        p.currencies[c] = (p.currencies[c] || 0) + (Number(action.amount) || 0);
      }
      break;
    case 'takeCurrency':
      if (p) {
        const c = String(action.currency || 'coins');
        p.currencies = p.currencies || {};
        p.currencies[c] = Math.max(0, (p.currencies[c] || 0) - (Number(action.amount) || 0));
      }
      break;
    case 'spectate':
      if (p) { p.alive = false; p.spectating = true; }
      break;
    default:
      break;
  }
}

module.exports = { runScripts, applyAction, matchFilter };
