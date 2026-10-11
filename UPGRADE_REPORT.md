# Kavryon upgrade report

## Bugs fixed
A. `/api/games/discover` missing quote → syntax error fixed; server parses
B. `game_versions` schema aligned (`scripts_json`, `objects_json`, `publisher_id`, `data_json` with definition)
C. `objectsToLegacyRows` always sets `name` (NOT NULL-safe)
D. Editor objects/scripts PUT sync into `game_definitions` (canonical)
E. Publish stores full definition in version `data_json`
F. Android/Web asset paths relative (`css/`, `js/`) not root-absolute
G. Production refuses weak/default JWT_SECRET
H. Release API URL placeholder `REPLACE_WITH_YOUR_API_HOST` (not fake live domain)
I. Active architecture remains unified `backend/server.js` + services (routes/* are legacy docs/unused)
J. Tests: unit + engine + studio

## New
- Restricted AI Game Builder (`/api/studio/ai/*`) — tool allowlist, no Kavx/admin
- Deterministic prompt→template planner (BedWars, RPG, Obby, …)
- Dimension 2d|3d on definitions
- Lightweight 3D canvas renderer (`engine3d.js`) for 3D-mode play
- Studio AI panel in editor

## Limitations
- AI is rule/template-based, not an external LLM
- 3D is box-primitive perspective, not full mesh/PBR engine
- Undo/redo/autosave UI not fully productized
- Android APK still needs local SDK/`gradle wrapper`
