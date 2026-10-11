# Security notes

## Implemented
- Unified single server (`backend/server.js`) — all frontend APIs mount here
- CORS allowlist via `ALLOWED_ORIGINS` (not `*`)
- Rate limits on auth, gifts, purchase, publish, play, likes, reports
- JSON body size limit (`JSON_BODY_LIMIT`)
- Session jti + revoke on logout; refresh token rotation foundation
- Password reset foundation (hashed tokens)
- Suspended accounts blocked on auth and sensitive actions
- Unpublished/suspended games cannot be played by normal users
- Short-lived WS tickets preferred over long-lived JWT-only URL auth
- Unique game likes; friend request reverse auto-accept; block table foundation
- Owner commands only when `OWNER_USER_ID` matches authenticated id
- Gifts remain atomic + idempotent; UI disables Confirm while sending
- Creator rewards server-side with unique event keys

## DEVELOPMENT ONLY
- `SANDBOX_PAYMENTS=true` enables sandbox purchase tokens
- Password reset may return `devResetToken` in sandbox
- Default JWT_SECRET must be changed for production

## Not production-complete
- Google Play receipt verification still requires Play Developer API wiring
- RoomManager is in-memory (not multi-node); abstraction ready for Redis
- Scripting is restricted event text, not a full isolated VM
- Capacitor Android still needs `npx cap add android` on a machine with Android SDK
