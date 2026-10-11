/**
 * Kavryon Engine3D — real WebGL via Three.js (not fake canvas perspective).
 * Server remains authoritative for gameplay; this module is client presentation + local camera.
 * Falls back to a clear error state if WebGL is unavailable.
 */
/* global THREE */
const Engine3D = (() => {
  const TYPE_COLORS = {
    block: 0x4b6cb7,
    platform: 0x3ee0c4,
    wall: 0x64748b,
    floor: 0x334155,
    spawn: 0x22c55e,
    checkpoint: 0xfbbf24,
    finish: 0xa78bfa,
    hazard: 0xef4444,
    bed: 0xfb7185,
    generator: 0xf59e0b,
    shop: 0x14b8a6,
    enemy: 0xf97316,
    npc: 0xe2e8f0,
    decoration: 0x94a3b8,
    default: 0x94a3b8
  };

  let renderer = null;
  let scene = null;
  let camera = null;
  let root = null;
  let playerMeshes = new Map();
  let objectMeshes = new Map();
  let animId = 0;
  let canvasEl = null;
  let quality = 'medium';
  let disposed = true;

  function webglOk() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch (_) {
      return false;
    }
  }

  function setQuality(q) {
    quality = q || 'medium';
    if (renderer) {
      const pr = quality === 'low' ? 0.75 : quality === 'high' ? Math.min(2, window.devicePixelRatio || 1) : 1;
      renderer.setPixelRatio(pr);
      if (quality === 'low') {
        renderer.shadowMap.enabled = false;
      } else {
        renderer.shadowMap.enabled = true;
      }
    }
  }

  function init(canvas, opts = {}) {
    dispose();
    disposed = false;
    canvasEl = canvas;
    if (typeof THREE === 'undefined') {
      return { ok: false, error: 'Three.js not loaded' };
    }
    if (!webglOk()) {
      return { ok: false, error: 'WebGL not available' };
    }
    const w = canvas.clientWidth || canvas.width || 640;
    const h = canvas.clientHeight || canvas.height || 360;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', alpha: false, powerPreference: 'high-performance' });
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(quality === 'low' ? 0.75 : Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x0b1a33, 1);
    renderer.shadowMap.enabled = quality !== 'low';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b1a33, 80, 420);

    camera = new THREE.PerspectiveCamera(60, w / Math.max(1, h), 0.5, 800);
    camera.position.set(0, 28, 48);

    // Lights
    const hemi = new THREE.HemisphereLight(0xb1d0ff, 0x334155, 0.85);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1d6, 0.9);
    sun.position.set(40, 80, 20);
    sun.castShadow = quality !== 'low';
    if (sun.castShadow) {
      sun.shadow.mapSize.width = quality === 'high' ? 1024 : 512;
      sun.shadow.mapSize.height = sun.shadow.mapSize.width;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 200;
      sun.shadow.camera.left = -60;
      sun.shadow.camera.right = 60;
      sun.shadow.camera.top = 60;
      sun.shadow.camera.bottom = -60;
    }
    scene.add(sun);

    // Ground grid helper (subtle)
    const grid = new THREE.GridHelper(200, 40, 0x2dd4bf, 0x1e293b);
    grid.position.y = 0;
    scene.add(grid);

    root = new THREE.Group();
    scene.add(root);

    // Sky dome
    const skyGeo = new THREE.SphereGeometry(400, 16, 12);
    const skyMat = new THREE.MeshBasicMaterial({ color: 0x1e3a5f, side: THREE.BackSide });
    scene.add(new THREE.Mesh(skyGeo, skyMat));

    return { ok: true };
  }

  function resize() {
    if (!renderer || !camera || !canvasEl) return;
    const w = canvasEl.clientWidth || canvasEl.width || 640;
    const h = canvasEl.clientHeight || canvasEl.height || 360;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  function colorFor(type) {
    return TYPE_COLORS[type] || TYPE_COLORS.default;
  }

  function boxMesh(w, h, d, color, opts = {}) {
    const geo = new THREE.BoxGeometry(Math.max(0.5, w), Math.max(0.5, h), Math.max(0.5, d));
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.roughness != null ? opts.roughness : 0.75,
      metalness: opts.metalness != null ? opts.metalness : 0.05,
      emissive: opts.emissive || 0x000000,
      emissiveIntensity: opts.emissiveIntensity || 0
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Map 2D game definition coords (x,y plane) into 3D (x, height, z). */
  function mapObject(o) {
    const w = (o.w || o.scale_x * 36 || 36) / 10;
    const h = (o.h || o.scale_y * 20 || 20) / 10;
    const d = (o.d || o.props?.depth || w);
    const x = (o.x || 0) / 10;
    const y = h / 2 + (o.props?.elevation || 0);
    const z = (o.z != null ? o.z : (o.y || 0)) / 10;
    return { x, y, z, w, h, d };
  }

  function syncObjects(objects) {
    if (!root) return;
    const seen = new Set();
    for (const o of objects || []) {
      const id = String(o.id || o.name || Math.random());
      seen.add(id);
      let mesh = objectMeshes.get(id);
      const m = mapObject(o);
      const col = colorFor(o.type);
      if (!mesh) {
        mesh = boxMesh(m.w, m.h, m.d, col, {
          emissive: o.type === 'hazard' ? 0x7f1d1d : o.type === 'spawn' ? 0x14532d : 0,
          emissiveIntensity: o.type === 'hazard' || o.type === 'spawn' ? 0.25 : 0
        });
        mesh.userData.kavId = id;
        root.add(mesh);
        objectMeshes.set(id, mesh);
      }
      mesh.position.set(m.x, m.y, m.z);
      mesh.scale.set(1, 1, 1);
      if (o.rotation) mesh.rotation.y = (Number(o.rotation) * Math.PI) / 180;
      if (mesh.material && mesh.material.color) mesh.material.color.setHex(col);
    }
    for (const [id, mesh] of objectMeshes) {
      if (!seen.has(id)) {
        root.remove(mesh);
        mesh.geometry?.dispose();
        mesh.material?.dispose();
        objectMeshes.delete(id);
      }
    }
  }

  function syncPlayers(players, localId) {
    if (!root) return;
    const seen = new Set();
    for (const p of players || []) {
      if (p.spectating) continue;
      const id = String(p.id);
      seen.add(id);
      let mesh = playerMeshes.get(id);
      if (!mesh) {
        const body = boxMesh(1.2, 2.2, 1.2, p.id === localId ? 0x2dd4bf : 0xe2e8f0);
        const head = boxMesh(0.9, 0.9, 0.9, 0xfde68a);
        head.position.y = 1.55;
        mesh = new THREE.Group();
        mesh.add(body);
        mesh.add(head);
        root.add(mesh);
        playerMeshes.set(id, mesh);
      }
      const x = (p.x || 0) / 10;
      const z = (p.y || 0) / 10; // 2D y → 3D z
      mesh.position.set(x, 1.1, z);
    }
    for (const [id, mesh] of playerMeshes) {
      if (!seen.has(id)) {
        root.remove(mesh);
        playerMeshes.delete(id);
      }
    }
  }

  function updateCamera(cam, focusPlayer) {
    if (!camera) return;
    const c = cam || {};
    if (focusPlayer) {
      const px = (focusPlayer.x || 0) / 10;
      const pz = (focusPlayer.y || 0) / 10;
      const dist = c.dist != null ? c.dist : 28;
      const yaw = c.yaw != null ? c.yaw : 0.6;
      const pitch = c.pitch != null ? c.pitch : 0.35;
      camera.position.set(
        px + Math.sin(yaw) * dist,
        12 + Math.sin(pitch) * 18,
        pz + Math.cos(yaw) * dist
      );
      camera.lookAt(px, 2, pz);
    } else {
      camera.position.set(c.x || 20, c.y || 30, c.z || 40);
      camera.lookAt(c.lx || 20, 0, c.lz || 20);
    }
  }

  /**
   * Compatibility entry used by play loop.
   * Prefer init() once, then renderFrame each tick.
   */
  function drawWorld(ctxOrCanvas, W, H, objects, players, entities, cam) {
    // If called with 2d context (legacy), try to use its canvas
    const canvas = ctxOrCanvas && ctxOrCanvas.canvas ? ctxOrCanvas.canvas : ctxOrCanvas;
    if (!canvas || !canvas.getContext) return;
    if (disposed || !renderer || canvasEl !== canvas) {
      const r = init(canvas);
      if (!r.ok) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#0b1a33';
          ctx.fillRect(0, 0, W || canvas.width, H || canvas.height);
          ctx.fillStyle = '#f87171';
          ctx.font = '14px sans-serif';
          ctx.fillText(r.error || '3D unavailable', 16, 32);
          ctx.fillStyle = '#94a3b8';
          ctx.fillText('Use a WebGL-capable browser or 2D mode.', 16, 52);
        }
        return;
      }
    }
    if (W && H) {
      canvas.width = W;
      canvas.height = H;
      resize();
    }
    syncObjects(objects);
    const local = (players || []).find((p) => p.local) || (players || [])[0];
    syncPlayers(players, local && local.id);
    updateCamera(cam, local);
    renderer.render(scene, camera);
  }

  function renderFrame(objects, players, cam, localId) {
    if (!renderer || disposed) return;
    syncObjects(objects);
    syncPlayers(players, localId);
    const focus = (players || []).find((p) => p.id === localId) || (players || [])[0];
    updateCamera(cam, focus);
    renderer.render(scene, camera);
  }

  function dispose() {
    disposed = true;
    if (animId) cancelAnimationFrame(animId);
    animId = 0;
    for (const mesh of objectMeshes.values()) {
      root?.remove(mesh);
      mesh.geometry?.dispose?.();
      mesh.material?.dispose?.();
    }
    objectMeshes.clear();
    playerMeshes.clear();
    if (renderer) {
      renderer.dispose();
      renderer = null;
    }
    scene = null;
    camera = null;
    root = null;
    canvasEl = null;
  }

  function pick(clientX, clientY) {
    if (!renderer || !camera || !canvasEl) return null;
    const rect = canvasEl.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const meshes = [...objectMeshes.values()];
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    return hits[0].object.userData.kavId || null;
  }

  return {
    init,
    dispose,
    resize,
    setQuality,
    drawWorld,
    renderFrame,
    pick,
    webglOk,
    isWebGL: true
  };
})();
