# Bug → fix matrix (this pass)

| Issue | Fix | Verification |
|-------|-----|--------------|
| `collab-tests.js` omitted from `npm test` | Added to package.json test chain | Full npm test |
| Collab viewers blocked from draft game API | `canAccessGame` uses `collab.canView` | Code + collab tests |
| Test server / rollback owner-only | `collab.canEdit` | Code review |
| WS draft join owner-only | `collab.canView` | Code review |
| Stale Android assets risk | `npm run sync:android` + size check | Script exit 0 |
| Weak prod config silent | `npm run validate:prod` | Script |
