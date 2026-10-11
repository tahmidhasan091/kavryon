# Bangladesh Kavx payments (SSLCommerz)

## Important limitation about "01716741717"

A **personal bKash/Nagad wallet number is not a merchant settlement API**.

Automated collection in a game platform requires a **registered merchant account** with a payment gateway (e.g. SSLCommerz, or bKash Merchant / Tokenized Checkout). Settlement goes to the **bank or merchant wallet linked during KYC onboarding**, not to a phone number hard-coded in the app.

Kavryon **never**:
- Hard-codes your personal number in the frontend
- Grants Kavx from a user-typed transaction ID or screenshot
- Claims live payment works without merchant credentials

## Selected integration

**SSLCommerz** (common in Bangladesh for cards + mobile financial services including bKash as a payment method inside the gateway).

Flow:
1. Authenticated user selects a package → `POST /api/payments/bd/create-order`
2. Server creates `payment_orders` row with server-side BDT amount and Kavx amount
3. Server calls SSLCommerz session API with store credentials
4. User is redirected to `GatewayPageURL`
5. SSLCommerz IPN → `POST /api/payments/bd/ipn`
6. Server calls **validation API** with `val_id`
7. On VALID + amount match → `grantVerifiedPurchase` (idempotent ledger)

## Owner setup

1. Register as SSLCommerz merchant (business docs / NID as required by provider).
2. Obtain `store_id` and `store_passwd` (sandbox first, then live).
3. Link settlement account as required by SSLCommerz (bank / merchant MFS — **not** an arbitrary personal number in code).
4. Set environment variables (server only):

```bash
SSLCOMMERZ_STORE_ID=your_store_id
SSLCOMMERZ_STORE_PASSWORD=your_store_password
SSLCOMMERZ_MODE=sandbox   # or live
SSLCOMMERZ_SUCCESS_URL=https://your-domain/payment/success
SSLCOMMERZ_FAIL_URL=https://your-domain/payment/fail
SSLCOMMERZ_CANCEL_URL=https://your-domain/payment/cancel
SSLCOMMERZ_IPN_URL=https://your-api/api/payments/bd/ipn
```

5. Without these vars, the API returns **503 / not configured** and the store UI shows that BDT checkout is unavailable.

## Google Play

Android in-app Kavx remains on **Google Play Billing**. External web payments inside a Play-distributed app may be restricted by Google policy — use web/desktop for SSLCommerz if required, or confirm policy with Play Console rules before enabling external IAP in the APK.

## bKash direct

Direct bKash Tokenized Checkout needs separate merchant credentials (`BKASH_APP_KEY`, etc.). Scaffold is not enabled for live charge without those credentials. Prefer SSLCommerz first for broader method coverage.
