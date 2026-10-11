# Multiplayer scaling

## Local / single server (default)
`MULTIPLAYER_MODE` unset or `memory` — RoomManager + MemoryBackend.

## Production multi-instance
```bash
MULTIPLAYER_MODE=redis
REDIS_URL=redis://127.0.0.1:6379
MULTIPLAYER_REQUIRE_REDIS=true   # fail startup if Redis down
INSTANCE_ID=game-1               # unique per process
ROOM_TTL_SEC=3600
```

`ioredis` is declared as a backend dependency. Install backend dependencies before enabling Redis mode.

Room **membership metadata** is shared via Redis.
**Physics/runtime** stays on the instance that accepted the WebSocket (use sticky load balancing on `/ws`).

Private servers use the same room IDs and registry.
