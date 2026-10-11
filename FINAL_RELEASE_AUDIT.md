# FINAL_RELEASE_AUDIT — Kavryon

## Completed
- **Android target/compile SDK 36** (versionCode 3, versionName 1.2.0)
- AGP 8.7.3 + Gradle 8.9 wrapper properties
- Free Creator Mode + Game Pass 60/40 (prior)
- **Multiplayer registry**: memory default; Redis when `MULTIPLAYER_MODE=redis` + `REDIS_URL`
- Production fail-fast if `MULTIPLAYER_REQUIRE_REDIS=true` and Redis down
- Health + private servers + moderation + atomic economy (prior)

## Android AAB
**Not verified in this environment** — `ANDROID_HOME` unset / build timed out downloading toolchain.
Owner must run: `cd android && KAVRYON_API_URL=https://… bash gradlew bundleRelease`
See `android/RELEASE_BUILD.md`.

## Multiplayer
- Single-process physics still process-local (sticky sessions recommended with Redis metadata)
- Not a fully shared simulation fabric; honest limitation

## Tests executed (all passed)
run-tests, engine, studio, discovery-e2e, invite, ai-provider, platform, billing, moderation-private, gamepass

## External remaining
1. Signed AAB on machine with SDK 36
2. `JWT_SECRET`, Play billing credentials
3. Optional Redis + `ioredis` for multi-instance

## Status

**NOT_READY_FOR_RELEASE**

API 36 migration is in source; production AAB and live Redis multiplayer verification remain owner-side.


## Repair pass addendum — 2026-10-10

- Fixed `app.patch` startup crash by adding PATCH support to the mini router.
- Server HTTP smoke test added to `npm test`; suite now starts the actual backend.
- Hardened forwarded-IP handling, bounded in-memory rate-limit buckets, and restricted Android WebView navigation/settings.
- Current exact results and remaining release blockers: see `REPAIR_REPORT.md`.
