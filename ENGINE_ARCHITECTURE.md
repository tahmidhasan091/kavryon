# Kavryon Engine Architecture

## What changed
`frontend/js/engine3d.js` now uses **Three.js r160** (`frontend/js/vendor/three.min.js`) with:
- `WebGLRenderer`, `PerspectiveCamera`, `Scene`
- Hemisphere + directional lighting (optional shadows)
- Box meshes for world objects and simple player capsules
- Fog, sky sphere, grid helper
- Raycasting pick for studio selection
- `init` / `renderFrame` / `dispose` lifecycle
- Quality presets: low / medium / high (pixel ratio + shadows)

## What stayed
- **Server-authoritative** physics, combat, inventory, match rules in `backend/engine/runtime.js`
- **2D path** via `engine.js` for dimension=`2d` games
- Existing game-definition JSON and BedWars-style templates

## Honest limits
- Characters are colored boxes, not full skeletal avatars
- World objects are axis-aligned boxes mapped from the definition schema
- Not a full voxel streaming / infinite terrain engine
- Multiplayer state is still process-local unless Redis registry is configured

## Fallback
If WebGL or Three.js is missing, the client shows an error on the canvas and 2D mode remains available.
