const online = new Map();

function set(userId, data) {
  online.set(userId, { status: data.status || 'online', game: data.game || null, at: Date.now() });
}

function clear(userId) {
  online.delete(userId);
}

function get(userId) {
  const p = online.get(userId);
  if (!p) return { status: 'offline', game: null };
  if (Date.now() - p.at > 45000) return { status: 'offline', game: null };
  return p;
}

module.exports = { set, clear, get };
