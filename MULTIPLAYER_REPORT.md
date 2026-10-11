# Multiplayer architecture

- Transport: WebSocket with short-lived join tickets
- Authority: `backend/engine/runtime.js` simulates physics/combat; clients send inputs only
- Rooms: in-process Map; optional Redis registry for multi-instance discovery (physics still sticky per process)
- Tests: bedwars-e2e, invite, security-hardening (automated)
- Two-browser live session: UNVERIFIED in this environment
