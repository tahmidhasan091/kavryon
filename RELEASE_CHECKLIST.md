# Kavryon Release Checklist

## Verified
- [x] Free Creator Mode, 60/40 split
- [x] Obsolete branding removed from active code/assets (migration fallbacks only)
- [x] Data-preserving migrations (token, admin, product aliases)
- [x] Full test suite + branding regression + release-config tests PASS
- [x] CI: debug APK, release APK, optional AAB
- [x] Physical-device debug URL documented

## Outstanding (owner)
- [ ] Signed release APK/AAB with real keystore
- [ ] Production HTTPS API + JWT_SECRET + ALLOWED_ORIGINS (include appassets.androidplatform.net)
- [ ] Persistent KAVRYON_DB + backups
- [ ] Google Play products + service-account JSON
- [ ] Device QA

## Verdicts
| Area | Status |
|------|--------|
| Source tests | PASS |
| Debug APK | Ready via CI / local SDK |
| Release APK signing | Config ready; not produced (no keystore) |
| Real-device | Not tested here |
| Overall readiness | NOT READY until outstanding items complete |
