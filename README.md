# Tilltide

A mobile-first AI payments agent for small businesses on Solana.

*Till* — the shop counter. *Tide* — payments flowing in and out on their own, from the Cornish coast to anywhere.

A shop takes USDC on a Solana Seeker (or any Android phone). Customers pay from any Solana wallet and earn onchain loyalty points. An AI agent reconciles the takings, answers "how did we do today?", and suggests moving money to the owner, who approves every transfer with a tap. The payments and agent layer underneath is an open-source kit.

## Repo

| Path | What |
| --- | --- |
| [`apps/seeker-app`](apps/seeker-app) | Expo / React Native merchant app. Charge (amount → Solana Pay QR → "Paid ✓"), Activity, Agent chat, Settings |
| [`agent`](agent) | Node/TS API (Hono + Postgres): payment requests, chain watcher, points issuing, Claude agent |
| [`packages/agent-pay-kit`](packages/agent-pay-kit) | MIT kit: Solana Pay requests, payment verification, loyalty points, sweeps |

## How a sale works

1. The merchant types an amount. The API creates a payment with a fresh `reference` key and returns a Solana Pay URL. The app shows it as a QR code.
2. The customer scans and pays USDC from any wallet.
3. The watcher polls `getSignaturesForAddress(reference)`, then checks the merchant's token balance went up by at least the amount. The payment is marked paid and the payer recorded.
4. Points are minted to the payer at the shop's rate (default 1 point per 1 USDC). The mint authority key exists only in the server's env.
5. The app's poll sees `paid` and shows "Paid ✓".

The agent (Claude, with tool use) has four tools: `get_payments`, `get_daily_summary` (with optional chain reconciliation), `issue_points` (retry only), and `sweep_to_owner`. A sweep is only ever a **proposal**: the app shows a confirm card, the merchant signs with Mobile Wallet Adapter, and the backend verifies the transfer onchain before marking it done.

## Run it locally

Needs Node 22, pnpm, Docker, Android Studio (emulator or a device), and an MWA wallet on the device (e.g. Phantom or Solflare, set to devnet).

```bash
pnpm install

# Postgres
docker run -d --name tilltide-db -e POSTGRES_USER=tilltide -e POSTGRES_PASSWORD=tilltide -e POSTGRES_DB=tilltide -p 5432:5432 postgres:17

# API
cp agent/.env.example agent/.env      # add ANTHROPIC_API_KEY
pnpm --filter @tilltide/agent migrate
pnpm --filter @tilltide/agent create-points-mint   # paste the printed POINTS_* lines into agent/.env
pnpm agent

# App (custom dev build; Expo Go can't run Mobile Wallet Adapter)
cp apps/seeker-app/.env.example apps/seeker-app/.env
pnpm --filter @tilltide/seeker-app android
```

Get devnet USDC for a test customer wallet from [faucet.circle.com](https://faucet.circle.com) and devnet SOL from [faucet.solana.com](https://faucet.solana.com).

```bash
pnpm test        # kit unit tests
pnpm typecheck   # kit, agent and app
```

## Deploy

`agent/railway.json` configures the API on Railway: set the service's config path to `agent/railway.json`, add a Postgres database, and set the env vars from `agent/.env.example`. Migrations run before each deploy.

## Rules

- Devnet until M4.
- No private keys in the app. The merchant signs through Mobile Wallet Adapter.
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
- **PayPal AI Hackathon:** the agent, with PayPal integration (see below)

## Status

Built so far: M1–M3 code paths end to end. Verified against devnet: payment request creation, reference lookup, payment verification on real USDC transfers, reconciliation reads, sweep proposals. Not yet run: a device build with a live wallet, points minting (the setup script needs devnet SOL), and the agent against the live Claude API (needs `ANTHROPIC_API_KEY`).
