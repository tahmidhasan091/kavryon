# Kavryon Android Build Status

Application ID: `com.kavryon.platform`  
Display name: Kavryon  
Version: 1.3.0 (versionCode 4)

## Debug API URL

| Environment | KAVRYON_API_URL |
|-------------|-----------------|
| Android Emulator | `http://10.0.2.2:8080` (default) |
| Physical phone (same Wi-Fi) | `http://YOUR_COMPUTER_LAN_IP:8080` e.g. `http://192.168.0.105:8080` |
| Production release | Must be real `https://...` (localhost / 10.0.2.2 rejected) |

## Local build (requires Android SDK + JDK 17)
```bash
cd android
chmod +x gradlew
export KAVRYON_API_URL=http://10.0.2.2:8080   # or your LAN IP for physical phone
./gradlew assembleDebug --no-daemon
# APK: app/build/outputs/apk/debug/app-debug.apk
```

## Free CI (GitHub Actions)
Push to GitHub → workflow builds and uploads `kavryon-debug-apk` artifact.
See BANGLA_BUILD_GUIDE.md for phone steps.
