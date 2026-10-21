# Tilltide

A mobile-first AI payments agent for small businesses on Solana.

*Till* — the shop counter. *Tide* — payments flowing in and out on their own, from the Cornish coast to anywhere.

A shop takes USDC or PYUSD on a Solana Seeker (or any Android phone). Customers pay from any Solana wallet and earn onchain loyalty points, or pay with PayPal if they don't have a wallet. An AI agent reconciles the takings, answers "how did we do today?", and suggests moving money to the owner, who approves every transfer with a tap. The payments and agent layer underneath is an open-source kit.

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

**PayPal rail.** For customers without a crypto wallet, the merchant flips Charge to *PayPal*. The API creates a PayPal order (Orders v2) and the QR opens PayPal's checkout, where the customer pays with PayPal or a card. The order is captured when PayPal sends them back, or by the watcher if they close the page, and the sale lands in the same ledger. PayPal takings settle to the shop's PayPal balance and don't earn points yet.

**Sign-in.** The merchant signs in with the till wallet using Sign In With Solana over Mobile Wallet Adapter. The API checks the signature and a one-time nonce, then issues a session token. Every shop route lives under `/shop` and only ever sees the signed-in wallet's shop.

The agent (Claude, with tool use) has four tools: `get_payments`, `get_daily_summary` (with optional chain reconciliation), `issue_points` (retry only), and `sweep_to_owner`. A sweep is only ever a **proposal**: the app shows a confirm card, and the merchant signs with Mobile Wallet Adapter. The transaction carries a `tilltide:sweep:<id>` memo. Before marking the sweep done, the backend checks that memo onchain, that it came from the till, that it went to the owner, and that the amount is right. A look-alike manual transfer never counts. Once a sweep is submitted it can't be signed again until the chain shows the first transaction can't land.

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

The end-to-end suite starts `solana-test-validator` with copies of the devnet USDC and PYUSD mints (mint authority swapped to a test key), a stand-in PayPal Orders API, and a fresh Postgres database. It then drives the real API through 22 scenarios:
- Sign-in: forged signatures, replayed nonces and the wrong domain are all rejected.
- Paying: USDC and PYUSD (Token-2022) payments, including a dust transfer on the reference, underpayment, payment after expiry, and expiry itself.
- Points: never minted twice, even after an interrupted mint.
- Reconciliation: money outside the ledger is flagged.
- Sweeps: they must come from the till, a signature can't be replayed, a look-alike manual transfer never counts, a dropped transaction is handled, and a lost signature is recovered.
- PayPal: capture on return, capture by the watcher, a capture held for review, and expired requests.
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

## Funding routes

- **Solana Foundation grant:** `agent-pay-kit` as a public good
- **Solana Mobile grant:** the Seeker app with SKR loyalty
- **Colosseum Eternal:** the startup version
- **PayPal AI Hackathon:** PayPal checkout + PYUSD alongside the agent ([checklist](docs/paypal-hackathon.md))

## Status

Built: M1–M3 plus the PayPal rail and wallet sign-in. Verified by the end-to-end suite on a local validator, and payment verification also checked against real devnet USDC transfers. Not yet run: a device build with a live wallet, the agent against the live Claude API (needs `ANTHROPIC_API_KEY`), and PayPal's real sandbox (needs sandbox keys).
