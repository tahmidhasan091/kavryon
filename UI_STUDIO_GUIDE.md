# UI & Studio guide

## Design system
- Dark gaming palette (`--bg`, `--accent`, `--kavx`)
- **SVG-only** icons via `assets/icons/sprite.svg` (no emoji)
- CSS variables for spacing, radius, focus rings
- Bottom nav on phones; sticky side nav from 900px+

## Graphics quality
In-game Settings → Graphics: **auto / low / medium / high**
- Auto uses `hardwareConcurrency` + `deviceMemory` heuristics
- Low reduces effects; high draws a light grid overlay on 2D canvas
- Engine is a **lightweight 2D box renderer** (optional perspective 3D helper) — not a full mesh/PBR engine

## Studio
- Create → template → save / publish
- Desktop: hierarchy + viewport + properties layout when CSS loads
- Validation errors shown before publish

## Accessibility
- Visible `:focus-visible` rings
- 44px minimum touch targets on primary controls
- Search input labeled; nav `aria-current`
