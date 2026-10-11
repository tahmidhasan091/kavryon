# Bug-Fix & Legacy Cleanup Report — Kavryon (2026-10-11)

## Defects fixed
1. Obsolete Vyntrix branding in root folder, docs, env vars, seed admin, currency field, product export, asset, token key.
2. GitHub Actions release job lacked optional AAB (bundleRelease).
3. Physical-device debug URL not documented (10.0.2.2 is emulator-only).

## Key changes
- Packaged root: KAVRYON/
- db.js / production-config: KAVRYON_DB primary; VYNTRIX_DB migration fallback only
- seed.js: renames vyntrix_admin → kavryon_admin in place
- auth publicUser: kavx + balance (not primary vyn)
- products.js: VYN_PACKAGES export removed; getPackage keeps aliases
- economy aliases retained so purchase history / product IDs keep working
- api.js: migrate token then removeItem legacy key
- vyn.svg deleted
- docs updated; BRANDING_MIGRATION is historical archive only
- CI: debug APK + release APK + optional AAB
- tests/branding-regression-tests.js added; run-tests branding assert fixed

## Tests executed
node tests/run-tests.js → All tests passed
node tests/branding-regression-tests.js → passed
node tests/release-config-tests.js → passed

User data (wallets, admin ownership, purchase product IDs) preserved via migration paths.
