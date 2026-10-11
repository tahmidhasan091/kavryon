# Production deployment

Kavryon intentionally fails fast when production security/payment configuration is incomplete. Do not copy development `.env.example` values into production.

## Required environment
```bash
NODE_ENV=production
JWT_SECRET=<unique random secret, at least 32 characters>
SANDBOX_PAYMENTS=false
GOOGLE_PLAY_PACKAGE=com.kavryon.platform
GOOGLE_APPLICATION_CREDENTIALS=/secure/path/play-service-account.json
KAVRYON_DB=/var/lib/kavryon/kavryon.sqlite
ALLOWED_ORIGINS=https://your-frontend-domain,https://appassets.androidplatform.net
PORT=8080
```

The service-account JSON must be server-only and authorized for the matching Play Console app. Never place it in frontend or Android assets. You may use `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` instead, supplied through a secret manager (not committed `.env` text).

`KAVRYON_DB` and `KAVRYON_VIDEO_ROOT` must use persistent volumes. Put an HTTPS reverse proxy (Caddy/nginx) in front; enable WebSocket upgrade on `/ws`. Configure `TRUST_PROXY=true` only when the trusted edge proxy safely overwrites/appends `X-Forwarded-For`.

Validate the production environment before startup:
```bash
npm run validate:prod
npm start
```

## Android release

Requires Android SDK 36, JDK 17, a reachable Gradle distribution, a production HTTPS API origin, and an owner-managed release keystore.
```bash
export KAVRYON_API_URL=https://your-api-domain
export KAVRYON_STORE_FILE=/secure/path/kavryon-release.jks
export KAVRYON_STORE_PASSWORD='from-secret-manager'
export KAVRYON_KEY_ALIAS='from-secret-manager'
export KAVRYON_KEY_PASSWORD='from-secret-manager'
cd android
bash gradlew bundleRelease
```

Release builds fail closed if the API URL or signing material is missing/unsafe. Do not commit keystore files or passwords. Inspect the resulting signed AAB and test it with Play license testers before publication.

## Payments

Google Play Billing is server-verified; automated mock tests do not establish live payment readiness. Configure products to match the server catalog, enable the Android app in Play Console, and test purchased/pending/cancelled/replayed/refunded states. Bangladesh SSLCommerz checkout stays disabled until merchant credentials, verified callback/IPN URLs, and sandbox/live settlement tests are completed. Never hard-code a personal phone number as a merchant settlement destination.

## Multiplayer scale

Single process uses in-memory rooms. For multi-instance deployment install backend dependencies (including `ioredis`) and configure:
```bash
MULTIPLAYER_MODE=redis
REDIS_URL=redis://your-private-redis-host:6379
MULTIPLAYER_REQUIRE_REDIS=true
INSTANCE_ID=game-instance-1
```

Use sticky WebSocket routing. Room membership metadata can be shared through Redis, but physics/runtime remains on the instance that accepted the connection; multi-instance shared simulation is not implemented by the Redis registry alone.
