# Legacy Name Scan Report

## Intentional migration-only references
| Location | Reason |
|----------|--------|
| db.js / production-config.js | VYNTRIX_DB env fallback so existing DB paths are not lost |
| seed.js | One-time rename of vyntrix_admin → kavryon_admin |
| economy.js | vyn_* product aliases so existing purchases resolve |
| auth.js / server.js | 'vyntrix' in reserved usernames |
| api.js | One-time localStorage migration then delete |
| BRANDING_MIGRATION.md / LEGACY_NAME_SCAN.md | Historical documentation |

## Removed
Root folder name, VYN_PACKAGES export, vyn: primary field, vyn.svg, user-facing docs using old name as current brand.

Covered by tests/branding-regression-tests.js.
