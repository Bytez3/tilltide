# PayPal AI Hackathon

Deadline: **Nov 12, 2026, 12pm PST.** The brief asks for a working prototype that meaningfully integrates PayPal's developer platform with an AI tool, a public repo with a licence, documentation, a demo, the AI tools used, and a demo video under 3 minutes.

## How Tilltide fits

**Tilltide is PayPal-first.** PayPal is the default way to pay at the till, each shop is onboarded as a PayPal merchant with Tilltide as the platform, and PayPal's stablecoin PYUSD is the default for wallet payments.

- **PayPal Partner Referrals onboarding.** Each shop connects its own PayPal, and Tilltide confirms the connection with PayPal's merchant-integrations API. Code: `agent/src/services/paypal-onboarding.ts`.
- **Platform model.** Every PayPal order names the shop as `payee` and carries Tilltide's fee in `payment_instruction.platform_fees`, with the partner attribution (BN) code. That's how Tilltide earns, and it pays for the AI.
- **PayPal loyalty.** PayPal customers earn points and spend them with a code from their receipt. Points held by an open order can't be spent twice. Code: `agent/src/services/paypal-loyalty.ts`.

- **PayPal Orders v2 checkout** as a second payment rail. A customer without a crypto wallet scans the same till QR and pays with PayPal or a card. Code: `agent/src/paypal.ts`, `agent/src/services/payments.ts`.
- **PYUSD on Solana.** A shop can take PayPal's stablecoin instead of USDC (Settings → token). Code: `packages/agent-pay-kit/src/tokens.ts`.
- **AI agent across both rails.** Claude, with tool use, reconciles crypto and PayPal takings in one ledger. It answers "what did I take today?" and proposes sweeps that the owner approves. Code: `agent/src/agent/index.ts`.
- **Agent-driven PayPal refunds.** The owner says "refund the cream tea, the scone was cold". The agent finds the PayPal payment and proposes a refund. The owner approves it by signing the refund's exact wording with their wallet. The server then refunds through PayPal's Payments v2 API, using an idempotency key so a retry can never refund twice. Code: `agent/src/services/refunds.ts`.

## AI tools used

- Claude API (`claude-opus-5`) with tool use via the TypeScript SDK's tool runner. Tools: `get_payments`, `get_daily_summary`, `issue_points`, `sweep_to_owner`, `refund_paypal_payment`.
- Claude Code to build the project.

## Before submitting

- [ ] Make the GitHub repo public (it is private today)
- [ ] Create a PayPal sandbox app and set `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`
- [ ] Deploy the API (Railway) and set `PUBLIC_URL` so PayPal's return link reaches it from a customer's phone
- [ ] Run one real sandbox payment end to end with a sandbox buyer account
- [ ] Record the demo (under 3 min): charge in USDC → Paid ✓ and points; charge with PayPal → Paid ✓; ask the agent "what did I take today?" → reconciliation across both rails → "refund the cream tea" → owner approves in wallet → PayPal refund ✓ → sweep proposal → owner confirms
- [ ] Submit with the repo link, video and this page

## Ideas if there's time

- Let PayPal customers claim points later by linking a wallet.
- Take PayPal orders in GBP for UK shops (`PAYPAL_CURRENCY=GBP`), with the ledger converting to USD.
