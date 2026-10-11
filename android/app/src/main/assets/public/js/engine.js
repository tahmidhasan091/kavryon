const Engine = (() => {
  const TYPES = [
    'block', 'platform', 'wall', 'floor', 'spawn', 'checkpoint', 'finish',
    'hazard', 'trigger', 'door', 'teleport', 'bed', 'generator', 'shop',
    'npc', 'enemy', 'item_pickup', 'zone', 'decoration'
  ];
  const COLORS = {
    block: '#4b6cb7', platform: '#3ee0c4', wall: '#64748b', floor: '#334155',
    spawn: '#22c55e', checkpoint: '#fbbf24', finish: '#a78bfa', hazard: '#ef4444',
    trigger: '#38bdf8', door: '#a16207', teleport: '#c084fc', bed: '#fb7185',
    generator: '#f59e0b', shop: '#14b8a6', npc: '#e2e8f0', enemy: '#f97316',
    item_pickup: '#fde047', zone: '#6366f180', decoration: '#94a3b8'
  };

  function detectQuality() {
    try {
      const cores = navigator.hardwareConcurrency || 2;
      const mem = navigator.deviceMemory || 4;
      if (cores <= 2 || mem <= 2) return 'low';
      if (cores >= 6 && mem >= 6) return 'high';
      return 'medium';
    } catch (_) { return 'medium'; }
  }
  let _quality = 'auto';
  function setQuality(q) { _quality = q || 'auto'; }
  function effectiveQuality() {
    if (_quality === 'auto') return detectQuality();
    return _quality;
  }
  function drawWorld(ctx, w, h, objects, players, selected, entities) {
    const q = effectiveQuality();
    // low: skip subtle effects; high: soft grid
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a1428';
    ctx.fillRect(0, 0, w, h);
    if (q === 'high') {
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    }
    ctx.strokeStyle = '#1b2a48';
    for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    for (const o of objects || []) {
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.rotate(((o.rotation || 0) * Math.PI) / 180);
      const sx = o.w || (o.scale_x || o.scaleX || 1) * 36;
      const sy = o.h || (o.scale_y || o.scaleY || 1) * 20;
      ctx.fillStyle = COLORS[o.type] || '#888';
      ctx.fillRect(-sx / 2, -sy / 2, sx, sy);
      if (o.label || o.type === 'bed' || o.type === 'shop') {
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '9px sans-serif';
        ctx.fillText(o.label || o.type, -sx / 2, -sy / 2 - 4);
      }
      if (selected && selected.id === o.id) {
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(-sx / 2 - 2, -sy / 2 - 2, sx + 4, sy + 4);
      }
      ctx.restore();
    }
    for (const e of entities || []) {
      ctx.fillStyle = COLORS[e.kind] || COLORS.enemy || '#f97316';
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.kind === 'boss' ? 14 : 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fca5a5';
      ctx.fillRect(e.x - 12, e.y - 20, 24 * ((e.health || 1) / (e.maxHealth || 1)), 3);
    }
    for (const p of players || []) {
      if (p.spectating) continue;
      ctx.fillStyle = p.alive === false ? '#64748b' : '#e8eefc';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.fill();
      if (p.team) {
        ctx.strokeStyle = p.team === 'red' ? '#f87171' : p.team === 'blue' ? '#60a5fa' : '#5eead4';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = '#3ee0c4';
      ctx.font = '10px sans-serif';
      ctx.fillText((p.username || '') + (p.health != null ? ' ' + Math.round(p.health) : ''), p.x - 14, p.y - 14);
    }
  }

  function hit(objects, x, y) {
    return [...(objects || [])].reverse().find((o) => {
      const sx = (o.w || (o.scale_x || 1) * 36) / 2;
      const sy = (o.h || (o.scale_y || 1) * 20) / 2;
      return Math.abs(o.x - x) < sx + 4 && Math.abs(o.y - y) < sy + 4;
    });
  }

  return { TYPES, COLORS, drawWorld, hit, setQuality, effectiveQuality, detectQuality };
})();
