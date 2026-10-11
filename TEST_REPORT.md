# Test report

```bash
node tests/run-tests.js
node tests/video-tests.js
node tests/bedwars-e2e.js
node tests/gamepass-tests.js
node tests/security-hardening-tests.js
node tests/bd-payment-tests.js
```

| Suite | Result |
|-------|--------|
| run-tests | PASS |
| video-tests | PASS |
| bedwars-e2e | PASS |
| gamepass-tests | PASS |
| security-hardening | PASS |
| bd-payment-tests | PASS |
| Live SSLCommerz / live bKash | BLOCKED (no merchant credentials) |
| Signed AAB | BLOCKED (no SDK/keystore) |
