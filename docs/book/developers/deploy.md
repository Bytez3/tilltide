# Deploying

Tilltide runs on [Railway](https://railway.app) from `agent/Dockerfile` (see `railway.json`), with a Railway Postgres database. Pushes to `main` deploy automatically. Migrations run on every start.

## Environment

| Variable | Required | What it's for |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres |
| `AUTH_DOMAIN` | yes | The domain in Sign In With Solana messages, e.g. `tilltide.bytez3.com` |
| `PUBLIC_URL` | yes in production | Public URL for receipts, PayPal return links and Solana Pay requests (defaults to `http://localhost:8787`; must be https on mainnet) |
| `SOLANA_CLUSTER` / `SOLANA_RPC_URL` | | `devnet` (default) or `mainnet`, and a private RPC for mainnet |
| `POINTS_MINT` / `POINTS_AUTHORITY_SECRET` | for loyalty | The loyalty token and its mint authority |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_ENV` | for PayPal | REST app credentials; `sandbox` or `live` |
| `PAYPAL_PARTNER_MERCHANT_ID` / `PAYPAL_BN_CODE` | for partner fees | From PayPal's partner programme |
| `PAYPAL_FEE_BPS` / `PAYPAL_REQUIRE_CONNECTED` | | Tilltide's PayPal fee (default 50 = 0.5%), and whether a shop must connect its PayPal before taking PayPal sales (default: true on `live`) |
| `TREASURY_WALLET` / `SWEEP_FEE_BPS` | for sweep fees | Where Tilltide's sweep fee goes, and the fee (default 50 = 0.5%, max 500) |
| `ANTHROPIC_API_KEY` / `AGENT_MODEL` / `AGENT_EFFORT` / `AGENT_DAILY_LIMIT` | for the assistant | Claude access, and a per-shop daily cap (default 50 questions) |
| `SEEKER_RPC_URL` / `SEEKER_SKR_MINIMUM` | | Mainnet RPC for the Seeker bonus check |
| `CORS_ORIGINS` | | Allowed browser origins |
| `ORIGIN_SECRET` | | Header value Cloudflare adds, to refuse direct requests |
| `ANDROID_CERT_SHA256` | | For Digital Asset Links |
| `ALERT_WEBHOOK_URL` | | Discord or Slack webhook for anything that needs a human |
| `POINTS_NEW_ACCOUNTS_PER_SHOP_DAY` / `POINTS_NEW_ACCOUNTS_PER_DAY` | | Daily limits on new customer points accounts (defaults 50 per shop, 500 overall) |
| `PAYPAL_CURRENCY` / `PAYPAL_API_BASE` | | Override PayPal's currency and API host (testing) |
| `FX_RATES` | | Fixed exchange rates for testing (refused on mainnet) |
| `SEEKER_TEST_WALLETS` | | Wallets treated as Seeker owners in the sandbox and tests |
| `PORT` | | Port to listen on (default 8787) |
| `RATE_LIMIT_PER_IP` / `RATE_LIMIT_AUTH` / `WATCH_INTERVAL_MS` | | Tuning |

## Custom domain with Cloudflare

1. In Railway, add the custom domain and note the CNAME target and TXT verification record.
2. In Cloudflare DNS, add the CNAME (proxied) and the TXT record.
3. Add a Transform Rule that sets the `x-tilltide-origin` request header to your `ORIGIN_SECRET`.
4. Set `AUTH_DOMAIN`, `PUBLIC_URL` and `ORIGIN_SECRET` in Railway, and point the app's `EXPO_PUBLIC_API_URL` at the domain.

## Checks

* `/health`: the process is up (Railway's health check).
* `/ready`: the database and Solana RPC answer (for an uptime monitor).
