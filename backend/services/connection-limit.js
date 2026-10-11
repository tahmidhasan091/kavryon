/** Tracks active WebSocket slots per peer, with idempotent release and bounded keys. */
function createConnectionLimiter(maxPerPeer = 20) {
  const active = new Map();
  const limit = Math.max(1, Math.floor(Number(maxPerPeer) || 20));

  function acquire(peer) {
    const key = String(peer || 'unknown');
    const current = active.get(key) || 0;
    if (current >= limit) return null;
    active.set(key, current + 1);
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      const count = active.get(key) || 0;
      if (count <= 1) active.delete(key);
      else active.set(key, count - 1);
    };
  }

  return {
    acquire,
    count(peer) { return active.get(String(peer || 'unknown')) || 0; },
    peerCount() { return active.size; }
  };
}

module.exports = { createConnectionLimiter };
