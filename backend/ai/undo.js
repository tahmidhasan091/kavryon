/** Per-game AI undo stack (in-memory + last snapshot in audit). */
const stacks = new Map(); // gameId -> [{definition_json, at}]
const MAX = 20;

function pushSnapshot(gameId, definitionJson) {
  if (!stacks.has(gameId)) stacks.set(gameId, []);
  const s = stacks.get(gameId);
  s.push({ definition_json: definitionJson, at: Date.now() });
  if (s.length > MAX) s.shift();
}

function popSnapshot(gameId) {
  const s = stacks.get(gameId) || [];
  return s.pop() || null;
}

function peekCount(gameId) {
  return (stacks.get(gameId) || []).length;
}

module.exports = { pushSnapshot, popSnapshot, peekCount };
