# Run it yourself

## The browser sandbox (no phone needed)

```bash
pnpm install
docker run -d --name tilltide-db -e POSTGRES_USER=tilltide -e POSTGRES_PASSWORD=tilltide -e POSTGRES_DB=tilltide -p 5432:5432 postgres:17
pnpm --filter @tilltide/agent sandbox          # local Solana validator + API on :8787
pnpm --filter @tilltide/seeker-app web:sandbox # the app on http://localhost:8081
```

The sandbox starts a local Solana validator with test USDC and PYUSD, a funded test customer, loyalty points and a stand-in PayPal. A local test wallet signs in the browser (it refuses to run outside the sandbox), and the QR screen gets "act as the customer" buttons, so you can click through a whole day. The assistant needs `ANTHROPIC_API_KEY` in `agent/.env.sandbox`.

## On an Android phone

Needs Node 22, pnpm, Docker, Android Studio, and a wallet app on the device (Phantom or Solflare set to devnet, or a Seeker).

```bash
cp agent/.env.example agent/.env      # set AUTH_DOMAIN; add ANTHROPIC_API_KEY and PayPal sandbox keys
pnpm --filter @tilltide/agent migrate
pnpm --filter @tilltide/agent create-points-mint   # paste the printed POINTS_* lines into agent/.env
pnpm agent

cp apps/seeker-app/.env.example apps/seeker-app/.env
pnpm --filter @tilltide/seeker-app android        # a dev build; Expo Go can't run Mobile Wallet Adapter
```

Devnet USDC: [faucet.circle.com](https://faucet.circle.com). Devnet SOL: [faucet.solana.com](https://faucet.solana.com).

## Tests

```bash
pnpm typecheck                        # kit, API and app
pnpm test                             # unit tests
pnpm --filter @tilltide/agent e2e     # end-to-end on a local Solana validator
```

The end-to-end suite starts `solana-test-validator` with copies of the devnet USDC and PYUSD mints, a stand-in PayPal, and a fresh database, then drives the real API through 38 scenarios: sign-in forgery and replay, every payment rail, dust and underpayment, points that are never minted twice, reconciliation, sweeps that can't be replayed or faked, PayPal capture and refunds through lost responses and retries, menu pricing and permissions, cash and card sales and voids, and shop isolation. CI runs it on every push.
