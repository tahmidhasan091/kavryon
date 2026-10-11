# Gameplay Videos

## What it does
Users upload MP4/WebM gameplay clips, set visibility, and publish them for others to watch.

## Limits (defaults)
- Max file size: **50 MB** (`KAVRYON_VIDEO_MAX_BYTES`)
- Formats: MP4, WebM (magic-byte validated)
- Upload rate: 10–20 per hour per user
- Storage: local disk under `backend/storage/videos` (or `KAVRYON_VIDEO_ROOT`)

## Visibility
| Mode | Discovery | Direct link |
|------|-----------|-------------|
| public | Yes (if profile Videos enabled) | Yes |
| unlisted | No | Yes |
| private | No | Owner/admin only |

Profile setting **videos_enabled** hides all public clips from others when off.

## API
- `GET /api/videos` — public discovery
- `GET /api/videos/mine` — owner library + settings
- `POST /api/videos/upload` — multipart (auth)
- `GET /api/videos/:id` / `.../stream` — metadata / Range stream
- `PATCH` / `DELETE /api/videos/:id`
- `PUT /api/users/me/video-settings`
- `POST /api/videos/:id/report`

## Production notes
- Local disk is fine for small deployments; for scale use object storage and set a reverse-proxy path.
- Bandwidth and disk grow with uploads — budget hosting accordingly.
- Thumbnails are optional; player uses native HTML5 video.
- Not unlimited free hosting.

## UI
Videos tab in main nav; My Videos under Profile; SVG icons only.
