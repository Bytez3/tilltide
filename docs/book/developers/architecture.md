# How it fits together

Tilltide is a pnpm monorepo with three parts.

| Part | Path | What it is |
| --- | --- | --- |
| The app | `apps/seeker-app` | Expo / React Native till for Android (and a browser sandbox). Signs with Mobile Wallet Adapter; holds no keys. |
| The API | `agent` | Hono server on Node 22 with Postgres. Payments, PayPal, loyalty, reports, the Claude agent, and a background watcher. |
| The kit | `packages/agent-pay-kit` | MIT library for Solana Pay payments, verification, loyalty, redemption and sweeps. Used by the API. |

```
 Phone (till)                    API (Railway)                         Outside
 ─────────────                   ─────────────                         ───────
 Charge ──POST /shop/payments──► price basket, create sale ──Orders v2──► PayPal
   QR ◄──────────── url ───────── Solana Pay URL / PayPal link
                                 watcher ──getSignatures/getTransaction─► Solana RPC
 Paid ✓ ◄──GET /shop/payments/:id── status from PayPal capture or chain
 Assistant ──POST /shop/chat──► Claude + tools (read; propose only) ───► Anthropic API
 Approve ──wallet signature────► verify, then refund (PayPal) / confirm sweep (chain)
```

## Payment rails

* **PayPal:** a PayPal Orders v2 order with the shop as `payee` and Tilltide's fee in `platform_fees`. The QR opens PayPal checkout. The order is captured when the customer returns, or by the watcher if they don't.
* **Wallet:** a Solana Pay transfer request (or a transaction request, when spending points) with a unique `reference`. The watcher finds the payment by its reference and verifies it from token balance changes.
* **Cash and card:** recorded as paid on creation; no money passes through Tilltide.

## The money rules

* The phone never holds a private key. The till wallet signs through Mobile Wallet Adapter.
* The loyalty mint authority lives only in the server's environment.
* The agent can read, and can **propose** sweeps and refunds. Moving money always needs the owner's wallet signature, checked by the server.
* Every money flow is a small state machine in Postgres (sweeps, refunds, points), built so a retry or lost response can't pay twice.

## Data

Postgres tables: `merchants`, `payments` (one row per sale on any rail, with the basket as JSON), `items`, `sweeps`, `refunds`, `loyalty_codes`, `auth_nonces`, `sessions`, `staff_invites`, `daily_reports`, `export_tokens` and `agent_usage`. PayPal customers' points are a ledger worked out from their paid sales. `agent/src/db/schema.sql` is idempotent and runs on every start.
