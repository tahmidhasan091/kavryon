# Gift system

## API

`POST /api/gifts/send`

```json
{ "username": "Nova", "amount": 25, "idempotencyKey": "client-unique-string" }
```

`GET /api/gifts/history?limit=20&offset=0`

`GET /api/notifications`

## Rules

- Authenticated sender
- Recipient exists, active, not self
- Amount integer, `GIFT_MIN`–`GIFT_MAX`
- Daily send amount and count caps
- Idempotency key required; duplicates return prior result without double spend
- Atomic: debit, credit, gift row, both ledger rows, notification — or full rollback

## UI

Friends list → **Gift** → modal amount → Confirm.
Wallet shows gift history.
