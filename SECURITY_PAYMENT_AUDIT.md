# Security & payment audit (summary)

- Kavx grants only via server ledger; BD SSLCommerz disabled without merchant env
- Google Play path requires service account; no client-trusted amounts
- Video stream tickets (not long-lived JWT in URL)
- Creator Mode free; gamepass 60/40 server-side
- Secrets: use `.env` only; never commit
