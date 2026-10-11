# Owner actions still required

1. `JWT_SECRET` ≥ 32 chars; `NODE_ENV=production`; `SANDBOX_PAYMENTS=false`
2. Persistent `KAVRYON_DB` and `KAVRYON_VIDEO_ROOT` (not `/tmp`)
3. HTTPS API URL for Android release (`KAVRYON_API_URL=https://...`)
4. Android SDK 36 + JDK 17 + signing keystore → `./gradlew bundleRelease`
5. Google Play products + service account for live IAP
6. SSLCommerz merchant KYC for Bangladesh BDT checkout
7. Optional Redis for multi-instance room registry

Never commit real secrets. Use `.env.example` as template only.
