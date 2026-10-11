# কাভরিয়ন (Kavryon) Android APK — সম্পূর্ণ ফ্রি বিল্ড ও ইনস্টল গাইড

এই গাইডটি **শুধুমাত্র ফ্রি টুল** দিয়ে তৈরি। কোনো টাকা খরচ করতে হবে না।  
আপনার প্রজেক্ট: `KAVRYON-ANDROID-APK-READY.zip`

---

## ১. প্রজেক্ট কী আছে (সংক্ষেপে)

- অ্যাপ আইডি: `com.kavryon.platform`
- নাম: **Kavryon**
- কারেন্সি: **Kavx**
- Creator Mode বিনামূল্যে
- গেমপাস আয় ভাগাভাগি: ক্রিয়েটর ৬০% / প্ল্যাটফর্ম ৪০%
- বিল্ড সিস্টেম: Gradle + GitHub Actions (ফ্রি)

**মনে রাখবেন:** এই পরিবেশে আমি নিজে APK তৈরি করতে পারিনি (Android SDK নেই)। কিন্তু প্রজেক্ট এমনভাবে সাজানো আছে যাতে **GitHub Actions**-এ ফ্রি বিল্ড চালিয়ে APK ডাউনলোড করতে পারবেন।

---

## ২. GitHub-এ প্রজেক্ট আপলোড (ফ্রি)

### ধাপ ২.১ — GitHub অ্যাকাউন্ট
1. ফোনে বা কম্পিউটারে https://github.com খুলুন।
2. বিনামূল্যে সাইন আপ করুন (যদি না থাকে)।

### ধাপ ২.২ — নতুন রিপোজিটরি তৈরি
1. GitHub-এ **New repository** ক্লিক করুন।
2. Repository name দিন: `kavryon` (বা যেকোনো নাম)।
3. **Public** রাখুন (ফ্রি Actions চালাতে Public সহজ)।
4. **Create repository** চাপুন।  
   (README বা .gitignore অটো যোগ করার দরকার নেই।)

### ধাপ ২.৩ — প্রজেক্ট আপলোড (সিক্রেট ছাড়া)
**গুরুত্বপূর্ণ:** `.env`, পাসওয়ার্ড, keystore, API কী কখনো আপলোড করবেন না।

**সহজ উপায় (কম্পিউটার থেকে):**
1. ZIP ফাইল আনজিপ করুন → `KAVRYON` ফোল্ডার পাবেন।
2. GitHub ডেস্কটপ অ্যাপ (ফ্রি) ইনস্টল করুন, অথবা টার্মিনালে:
```bash
cd KAVRYON
git init
git add .
git commit -m "Kavryon Android ready"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/kavryon.git
git push -u origin main
```
3. ব্রাউজারে GitHub রিপো খুলে দেখুন সব ফাইল এসেছে কিনা।

**ফোন থেকে:** GitHub অ্যাপ বা Web থেকে ZIP আপলোড করা কঠিন। কম্পিউটার/ইন্টারনেট ক্যাফে ব্যবহার করুন।

---

## ৩. GitHub Actions দিয়ে ডিবাগ APK বিল্ড (ফ্রি)

1. GitHub রিপোজিটরিতে যান।
2. উপরের ট্যাব থেকে **Actions** ক্লিক করুন।
3. বাম পাশে **Android Build** ওয়ার্কফ্লো দেখবেন।
4. যদি প্রথমবার হয়: **I understand my workflows, go ahead and enable them** চাপুন।
5. `main` ব্রাঞ্চে কোড পুশ করলে অটোমেটিক বিল্ড শুরু হবে।
6. **Actions** ট্যাবে হলুদ/সবুজ রান দেখবেন। ক্লিক করে লগ দেখুন।
7. সফল হলে নিচে **Artifacts** সেকশনে `kavryon-debug-apk` দেখাবে।
8. সেখানে ক্লিক করে **Download** করুন (ZIP আসবে)।
9. ZIP খুলে `app-debug.apk` পাবেন।

### ফ্রি লিমিট (জানুন)
- GitHub Free: প্রাইভেট রিপোতে মাসে ~২০০০ মিনিট, পাবলিক রিপোতে বেশি।
- একবার বিল্ড সাধারণত ৫–১৫ মিনিট লাগে।
- অতিরিক্ত বেশি বিল্ড করলে লিমিট শেষ হতে পারে — তখন পরের মাস অপেক্ষা করুন বা Public রিপো ব্যবহার করুন।

---

## ৪. অ্যান্ড্রয়েড ফোনে APK ইনস্টল

1. ফোনে **Settings → Security** (বা Privacy) এ গিয়ে **Install unknown apps** / **Unknown sources** চালু করুন (যে ব্রাউজার/ফাইল ম্যানেজার দিয়ে APK ওপেন করবেন)।
2. ডাউনলোড করা `app-debug.apk` ফাইলে ট্যাপ করুন।
3. **Install** চাপুন।
4. ইনস্টল শেষে **Open** চাপুন।

অ্যাপ খুলবে। অনলাইন ফিচার কাজ করতে হলে ব্যাকএন্ড চালু থাকতে হবে (নিচে দেখুন)।

---

## ৫. ব্যাকএন্ড URL কনফিগার (অনলাইন ফিচারের জন্য)

ডিবাগ APK ডিফল্টভাবে এমুলেটর অ্যাড্রেস `http://10.0.2.2:8080` ব্যবহার করে।  
**আপনার ফিজিক্যাল ফোনে এটা কাজ করবে না।**

### অপশন A — নিজের কম্পিউটারে ব্যাকএন্ড চালান (টেস্টের জন্য)
1. কম্পিউটারে Node.js ইনস্টল করুন (ফ্রি)।
2. প্রজেক্টের `backend` ফোল্ডারে:
```bash
cd backend
npm install
node server.js
```
3. কম্পিউটারের LAN IP জানুন (`ipconfig` বা `ifconfig`) — উদাহরণ: `192.168.0.105`
4. নতুন করে APK বিল্ড করুন (GitHub Actions-এ env সেট করে বা লোকাল):
```bash
export KAVRYON_API_URL=http://192.168.0.105:8080
cd android && ./gradlew assembleDebug
```
5. ফোন ও কম্পিউটার **একই Wi-Fi**-তে থাকতে হবে।

### অপশন B — পরে প্রোডাকশন সার্ভার
যখন আপনার নিজের HTTPS ডোমেইন থাকবে, তখন release বিল্ড করবেন।

---

## ৬. বিল্ড ফেইল হলে লগ পড়া

1. GitHub → **Actions** → ব্যর্থ রান ক্লিক করুন।
2. লাল চিহ্নিত স্টেপ খুলুন।
3. সাধারণ সমস্যা:
   - `SDK location not found` → CI-তে SDK সেটআপ স্টেপ আছে কিনা দেখুন।
   - `three.min.js missing` → `node scripts/sync-android-assets.js` চালু আছে কিনা।
   - Permission denied on gradlew → workflow-এ `chmod +x android/gradlew` আছে।
4. লগ কপি করে সমস্যা খুঁজুন।

---

## ৭. সাইন করা Release APK (পরে)

ডিবাগ APK কাজ করার পর:

1. নিজের কম্পিউটারে keystore তৈরি করুন (একবার):
```bash
keytool -genkey -v -keystore kavryon-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias kavryon
```
2. GitHub রিপো → **Settings → Secrets and variables → Actions** এ যোগ করুন:
   - `KAVRYON_KEYSTORE_BASE64` = keystore ফাইলের base64
   - `KAVRYON_STORE_PASSWORD`
   - `KAVRYON_KEY_ALIAS`
   - `KAVRYON_KEY_PASSWORD`
3. Actions → Android Build → **Run workflow**
   - `api_url` এ দিন: `https://your-real-api.com`
   - চাইলে `build_aab` টিক দিন
4. সফল হলে `kavryon-release-apk` আর্টিফ্যাক্ট ডাউনলোড করুন।

**সতর্কতা:** Keystore ও পাসওয়ার্ড কখনো Git-এ কমিট করবেন না। হারালে Play Store আপডেট দিতে পারবেন না।

---

## ৮. গুরুত্বপূর্ণ সীমাবদ্ধতা (সৎ কথা)

| বিষয় | অবস্থা |
|--------|--------|
| সোর্স কোড টেস্ট | পাস করে (পূর্ববর্তী পাসে) |
| GitHub Actions দিয়ে ডিবাগ APK | প্রজেক্ট রেডি — আপনি ট্রিগার করবেন |
| এই পরিবেশে আসল APK তৈরি | হয়নি (SDK নেই) |
| ফোনে ইনস্টল টেস্ট | এখানে হয়নি |
| পূর্ণ প্রোডাকশন রিলিজ | এখনো রেডি নয় (HTTPS ব্যাকএন্ড + সাইনিং + ডিভাইস QA লাগবে) |

---

## দ্রুত কমান্ড সারাংশ

```bash
# লোকাল ডিবাগ (SDK থাকলে)
cd android
chmod +x gradlew
export KAVRYON_API_URL=http://10.0.2.2:8080
./gradlew assembleDebug --no-daemon
# ফাইল: app/build/outputs/apk/debug/app-debug.apk
```

GitHub-এ পুশ করলে অটো বিল্ড হবে এবং Artifacts থেকে APK নামতে পারবেন।

সফলতা কামনা করছি!
