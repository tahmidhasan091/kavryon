# Android setup

## Debug (emulator)
```bash
export KAVRYON_API_URL=http://10.0.2.2:8080
cd android
./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```
Requires Android SDK + JDK 17.

## Release AAB (Play Store)
```bash
export KAVRYON_API_URL=https://YOUR_PRODUCTION_API
export KAVRYON_STORE_FILE=/path/to/keystore.jks
export KAVRYON_STORE_PASSWORD=...
export KAVRYON_KEY_ALIAS=...
export KAVRYON_KEY_PASSWORD=...
cd android
./gradlew clean bundleRelease
# AAB: app/build/outputs/bundle/release/app-release.aab
```
Release **fails** if API URL is localhost/10.0.2.2.

**OWNER ACTION**: create keystore yourself; never commit secrets.
See also `android/RELEASE_BUILD.md`.
