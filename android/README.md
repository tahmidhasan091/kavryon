# Kavryon Android

Gradle application module packaging the Kavryon web client in a WebView.

## Configure API URL

```bash
export KAVRYON_API_URL=https://your-api.example
```

Debug builds default to `http://10.0.2.2:8080` (Android emulator → host).

## Build

Requires Android SDK + JDK 17.

```bash
cd android
# install wrapper once if missing: gradle wrapper
./gradlew assembleDebug
```

APK: `app/build/outputs/apk/debug/app-debug.apk`
