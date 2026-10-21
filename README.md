# Tilltide

A PayPal-first till and AI back office for small shops, with PayPal USD on Solana.

*Till* — the shop counter. *Tide* — payments flowing in and out on their own, from the Cornish coast to anywhere.

A shop runs its till on a Solana Seeker or any Android phone.
- **Paying:** most customers pay with PayPal or a card by scanning a PayPal checkout QR. The money goes straight to the shop's own PayPal account. Customers with a Solana wallet pay in PYUSD (PayPal's stablecoin) or USDC instead.
- **Cash and card reader:** sales taken in cash or on the shop's existing card reader are recorded on the till (with change worked out for cash), so takings, the end-of-day report, the agent and the bookkeeper's CSV cover every sale. No money moves through Tilltide for these, so there's no fee. The owner can void one recorded by mistake.
- **Menu:** the owner sets up items (Pasty £4.50, Coffee £3.00) and the till taps them into a basket, with the keypad for anything else. The server prices every basket from the shop's own menu, so a till can't change a price, and each sale keeps a copy of what was sold at what price. Best sellers appear in the daily summary and end-of-day report, and the agent can answer "what sold best today?".
- **Loyalty:** every customer earns points and can spend them at the till. Wallet customers' points are held onchain. PayPal customers' points are kept in Tilltide's ledger and spent with the loyalty code on their receipt. An AI agent reconciles the takings, answers "how did we do today?", and suggests moving money to the owner, who approves every transfer with a tap. The payments and agent layer underneath is an open-source kit.

## Repo

| Path | What |
| --- | --- |
| [`apps/seeker-app`](apps/seeker-app) | Expo / React Native merchant app. Charge (amount → Solana Pay QR → "Paid ✓"), Activity, Agent chat, Settings |
| [`agent`](agent) | Node/TS API (Hono + Postgres): payment requests, chain watcher, PayPal checkout, points issuing, Claude agent |
| [`packages/agent-pay-kit`](packages/agent-pay-kit) | MIT kit: Solana Pay requests, payment verification, loyalty points, sweeps |

## How a sale works

1. The merchant types an amount. The API creates a payment with a fresh `reference` key and returns a Solana Pay URL. The app shows it as a QR code.
2. The customer scans and pays USDC from any wallet.
3. The watcher polls `getSignaturesForAddress(reference)`, then checks the merchant's token balance went up by at least the amount. The payment is marked paid and the payer recorded.
4. Points are minted to the payer at the shop's rate (default 1 point per 1 USDC). The mint authority key exists only in the server's env.
5. The app's poll sees `paid` and shows "Paid ✓".

**Spending points.** With "Let the customer use their points" switched on, the QR is a Solana Pay *transaction request*. The customer's wallet fetches a transaction from the API that pays the rest of the bill and burns the points, in one signature. The sale only counts as paid if the cash received plus the points burned (at the shop's point value) covers the price, and the points part stays within the shop's cap (default 50%). The check is based on what the transaction actually did, so a customer can't game it.

**Prices in pounds.** Shops price in GBP by default (EUR and USD too). PayPal charges in the shop's own currency. Wallet sales convert at the European Central Bank rate, and the exact token amount and rate are stored on each sale.

**Staff tills.** The owner pairs a staff phone with a one-time code. Staff can take payments, but the server refuses anything that moves money or changes the shop.

**End of day and accounts.** At closing time Tilltide writes the day's report, with an optional Claude note on top of facts computed without AI. The owner can export a month of sales, refunds and sweeps as CSV, via a one-time link.

**Seeker bonus.** A shop can give Seeker owners extra points (×1.5, ×2 or ×3). A customer counts as a Seeker owner if their wallet holds a Seeker Genesis Token, checked with Solana Mobile's `@solana-mobile/skr-genesis-token`, or at least 1 SKR. Both are checked on mainnet, even while payments run on devnet. The receipt says when the bonus applied.

**Receipts.** After a sale the till shows a receipt QR. The customer's receipt page (`/r/<id>`) shows what they paid, the points they used and earned, and their points balance.

**PayPal first.** The till opens on PayPal.
- **The shop's own account:** each shop connects its own PayPal through PayPal's Partner Referrals onboarding. The connection is confirmed by asking PayPal directly, never from the return link alone.
- **Each sale:** a PayPal Orders v2 order with the shop as `payee` and Tilltide's 0.5% in `platform_fees`. The QR opens PayPal checkout, where the customer pays with PayPal or a card. The order is captured when PayPal sends the customer back, or by the watcher if they close the page.
- **Refunds:** made on the shop's behalf (`PayPal-Auth-Assertion`).
- **Not connected:** in live mode PayPal sales are refused until the shop connects. Without partner status, a shop can instead name a PayPal email to be paid to, with no Tilltide fee.
- **Loyalty:** PayPal customers earn ledger points, and the loyalty code on their receipt spends them on a later PayPal bill. Points held by an open sale can't be spent twice.

**Sign-in.** The merchant signs in with the till wallet using Sign In With Solana over Mobile Wallet Adapter. The API checks the signature and a one-time nonce, then issues a session token. Every shop route lives under `/shop` and only ever sees the signed-in wallet's shop.

The agent (Claude, with tool use) has five tools: `get_payments`, `get_daily_summary` (with optional chain reconciliation), `issue_points` (retry only), `sweep_to_owner`, and `refund_paypal_payment`. A PayPal refund is also only a proposal: the owner approves it by signing the refund's exact wording with their wallet, and the server refunds through PayPal with an idempotency key, so it can never refund twice. A sweep is only ever a **proposal**: the app shows a confirm card, and the merchant signs with Mobile Wallet Adapter. The transaction carries a `tilltide:sweep:<id>` memo. Before marking the sweep done, the backend checks that memo onchain, that it came from the till, that it went to the owner, and that the amount is right. A look-alike manual transfer never counts. Once a sweep is submitted it can't be signed again until the chain shows the first transaction can't land.

## Try it in a browser (sandbox)

```bash
pnpm --filter @tilltide/agent sandbox          # local Solana chain + API on :8787 (needs the Postgres container)
pnpm --filter @tilltide/seeker-app web:sandbox # the app on http://localhost:8081
```

The sandbox runs a local Solana validator with test USDC and PYUSD, a funded test customer, loyalty points, and a stand-in PayPal. In the browser, a local test wallet signs in place of the phone wallet (it refuses to run outside the sandbox). The QR screen gets "act as the customer" buttons, so you can click through a whole day: charge, pay, points, send takings to the owner with the fee, and PayPal refunds. Agent chat needs `ANTHROPIC_API_KEY` in `agent/.env.sandbox`.

## Run it locally

Needs Node 22, pnpm, Docker, Android Studio (emulator or a device), and an MWA wallet on the device (e.g. Phantom or Solflare, set to devnet).

```bash
pnpm install

# Postgres
docker run -d --name tilltide-db -e POSTGRES_USER=tilltide -e POSTGRES_PASSWORD=tilltide -e POSTGRES_DB=tilltide -p 5432:5432 postgres:17

# API
cp agent/.env.example agent/.env      # set AUTH_DOMAIN; add ANTHROPIC_API_KEY, and PayPal sandbox keys for the PayPal rail
pnpm --filter @tilltide/agent migrate
pnpm --filter @tilltide/agent create-points-mint   # paste the printed POINTS_* lines into agent/.env
pnpm agent

# App (custom dev build; Expo Go can't run Mobile Wallet Adapter)
cp apps/seeker-app/.env.example apps/seeker-app/.env
pnpm --filter @tilltide/seeker-app android
```

Get devnet USDC for a test customer wallet from [faucet.circle.com](https://faucet.circle.com) and devnet SOL from [faucet.solana.com](https://faucet.solana.com).

```bash
pnpm test        # kit and PayPal client unit tests
pnpm typecheck   # kit, agent and app
pnpm --filter @tilltide/agent e2e   # full end-to-end run on a local Solana validator
```

The end-to-end suite starts `solana-test-validator` with copies of the devnet USDC and PYUSD mints (mint authority swapped to a test key), a stand-in PayPal Orders API, and a fresh Postgres database. It then drives the real API through 36 scenarios:
- Sign-in: forged signatures, replayed nonces and the wrong domain are all rejected.
- Paying: USDC and PYUSD (Token-2022) payments, including a dust transfer on the reference, underpayment, payment after expiry, and expiry itself.
- Points: never minted twice, even after an interrupted mint.
- Reconciliation: money outside the ledger is flagged.
- Sweeps: they must come from the till, a signature can't be replayed, a look-alike manual transfer never counts, a dropped transaction is handled, and a lost signature is recovered.
- PayPal: capture on return, capture by the watcher, a capture held for review, expired requests, and refunds (wallet-signed approval, forgery, over-refunding, outages, lost responses, retried 4xx, parallel proposals, PENDING).
- Access: one shop can't see another's payments or sweeps.
- Agent: its tools return real data and can't move money.

## Deploy

The API ships as a Docker image (`agent/Dockerfile`, built from the repo root). It runs migrations on start, so a fresh database just works.

On Railway, `railway.json` at the repo root builds the API from `agent/Dockerfile`. Add a Postgres database and set the env vars from `agent/.env.example`. Set `PUBLIC_URL` to the service's public URL so PayPal can send customers back.

```bash
docker build -f agent/Dockerfile -t tilltide-agent .
```

## Live

API (devnet): https://api-production-83900.up.railway.app. It's on Railway, project `tilltide` in the "My Projects" workspace, with Postgres alongside. Pushes to `main` deploy automatically. The app points here by default.

## Running it for real

- **CI:** GitHub Actions runs typecheck, unit tests, lint and the full end-to-end suite (local Solana validator + Postgres) on every push.
- **Alerts:** set `ALERT_WEBHOOK_URL` to a Discord or Slack incoming webhook. Tilltide posts there when a sweep or refund needs a human, the till has money Tilltide didn't take, or the payment watcher is failing.
- **Monitoring:** `/health` is the quick liveness check for Railway. `/ready` checks that the database and Solana RPC answer, for an uptime monitor.
- **Mainnet guard:** on `SOLANA_CLUSTER=mainnet` the API refuses to start with unsafe settings (public RPC, a domain you don't own, http `PUBLIC_URL`, PayPal sales to the platform account, fixed FX rates) and warns about missing ones.
- **Legal:** `/privacy` and `/terms` are drafts awaiting a solicitor's review.
- **Plan:** see [docs/LAUNCH-PLAN.md](docs/LAUNCH-PLAN.md).

## Rules

- Devnet until M4.
- No private keys in the app. The merchant signs (and signs in) through Mobile Wallet Adapter.
- The points mint authority key lives only in server env vars.
- The agent never moves funds. Every transfer needs the owner's tap.
- Keep it small and shippable. Cut scope before cutting the demo.

## Milestones

- **M1, by Nov 1 (Hacker House):** take a payment. Amount → QR with unique reference → customer pays devnet USDC → "Paid ✓".
- **M2, by Nov 8:** loyalty. Auto-issue points to the payer, customer points lookup, merchant-set rate.
- **M3, by Nov 12 (PayPal AI Hackathon):** agent chat, end-of-day reconciliation, sweep with confirm step, 2-minute demo video.
- **M4, by Nov 15 (Breakpoint London):** live demo build, mainnet pilot with 1–2 Cornwall shops, extract `agent-pay-kit` with docs.
- **After Breakpoint:** SKR bonus points for Seeker users (Solana Mobile grant), Colosseum Eternal, Solana Foundation grant.

## Business model

Tilltide takes **0.5% of each sweep**: when the owner moves takings from the till to their own wallet, the same transaction sends the fee to Tilltide's treasury. The confirm card shows "99.50 to you, 0.50 Tilltide fee" before the owner signs, and the server checks both transfers onchain. The fee is off until `TREASURY_WALLET` is set; the rate is set with `SWEEP_FEE_BPS` (default 50 = 0.5%, max 500).

Planned: a Pro plan (more agent questions, staff logins, exports), and PayPal platform fees once PayPal partner approval is in place.

## Funding routes

- **Solana Foundation grant:** `agent-pay-kit` as a public good
- **Solana Mobile grant:** the Seeker app with SKR loyalty
- **Colosseum Eternal:** the startup version
- **PayPal AI Hackathon:** PayPal-first till, partner onboarding, platform fees, agent-driven refunds ([checklist](docs/paypal-hackathon.md), [write-up](docs/submission/SUBMISSION.md), [demo script](docs/submission/DEMO-SCRIPT.md))

## Status

Built: M1–M3 plus the PayPal rail and wallet sign-in. Verified by the end-to-end suite on a local validator, and payment verification also checked against real devnet USDC transfers. Not yet run: a device build with a live wallet, the agent against the live Claude API (needs `ANTHROPIC_API_KEY`), and PayPal's real sandbox (needs sandbox keys).
