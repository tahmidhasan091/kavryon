# Kavx economy

Currency code: `KAVX` · Display: **Kavx**

## Sources

| Type | Description |
|------|-------------|
| PURCHASE | Verified store packages only |
| CREATOR_REWARD | Server events (publish, unique play engagement) |
| GIFT_SENT / GIFT_RECEIVED | Peer transfers |
| ADMIN_ADJUSTMENT | Admin only |
| SPEND | Developer Mode etc. |

## Creator rewards (server-side)

Configured in `backend/services/economy.js`:

- Publish approved game: `REWARD_PUBLISH` (default 50), unique `publish:{gameId}`
- Unique player engagement: `REWARD_PLAY_MILESTONE` (default 10), unique `play:{gameId}:{playerId}`
- Daily creator cap / per-game cap enforced
- Self-play does not reward
- Client cannot submit reward amounts

## Packages

`kavx_100` … `kavx_5500` with legacy aliases `vyn_*`.

Amounts never taken from the client.
