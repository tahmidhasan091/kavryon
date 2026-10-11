# Kavryon Release Notes — Android Build Repair Pass (2026-10-10)

## Verdict
**NOT READY for public production or Google Play publication.**

A complete, downloadable project ZIP with a free GitHub Actions Android build path is provided. Signed release APK was not produced in this environment (no keystore, AAPT2 sandbox limitation).

## What was verified
- Full existing test suite (`node tests/run-tests.js`) — **all tests passed**
- Free Creator Mode preserved
- Gamepass revenue split 60 % creator / 40 % platform preserved
- Production config fail-closed behavior
- Android WebView security (no cleartext, restricted navigation, API injection, billing bridge does not grant currency)
- Frontend assets sync into Android package

## What was added / fixed
- `.github/workflows/android-build.yml` — free CI that produces debug APK on every push/PR and optional signed release
- `android/BUILD_STATUS.md` updated with accurate status
- `ANDROID_RELEASE_AUDIT.md` — detailed audit, changed files, test results, blockers
- compileSdk/targetSdk set to 35 for CI reliability (was 36)
- `android/local.properties.example` for developer onboarding

## How to obtain a debug APK
1. Push the project to GitHub
2. Wait for the “Android Build” workflow
3. Download the `kavryon-debug-apk` artifact

Or build locally with Android SDK + JDK 17:
```bash
cd android && ./gradlew assembleDebug
```

## Remaining blockers (owner)
1. Create release keystore and configure GitHub secrets (or local env vars)
2. Deploy production backend with HTTPS, strong JWT_SECRET, ALLOWED_ORIGINS including the Android WebView origin
3. Configure Google Play products + service-account JSON for server-side purchase verification
4. Device / emulator QA of gameplay, multiplayer, Team Studio, and billing flow

See `ANDROID_RELEASE_AUDIT.md` and `android/RELEASE_BUILD.md` for exact commands.
