# Team Studio architecture

## Roles (server-enforced)
| Role | Edit | Publish | Manage members |
|------|------|---------|----------------|
| Owner | yes | yes | yes |
| Editor | yes | no | no |
| Viewer | no | no | no |

## APIs
- `GET /api/games/:id/collab` — members, role, revision, activity
- `POST /api/games/:id/collab/invite` — owner only
- `POST /api/collab/invites/:id/accept|decline`
- `POST /api/games/:id/collab/role|remove`
- `POST /api/games/:id/collab/revision` — optimistic concurrency

## Real-time co-editing status
**Serialized foundation:** revision numbers + conflict (409) on stale saves.  
**Not verified:** simultaneous multi-cursor live mesh streaming between two browsers (UNVERIFIED / partial).

Presence indicators in UI are based on membership list; live cursor sync is not claimed.
