# Bugfix report

1. Video stream no longer uses long-lived JWT in query string (stream tickets).
2. Bangladesh payment path is **disabled** until SSLCommerz merchant env is set (no fake success).
3. Store UI shows clear unavailable message when BD gateway is not configured.
4. Personal phone numbers are not embedded as settlement destinations in code or public API.
5. Payment orders table + IPN validation before any Kavx grant.
6. Regression suites: core, video, bedwars, gamepass, security, bd-payment.
