# PayPal AI Hackathon

Deadline: **Nov 12, 2026, 12pm PST.**

The brief asks for:
- a working prototype that meaningfully integrates PayPal's developer platform with an AI tool
- a public repo with a licence
- documentation
- a demo
- the AI tools used
- a demo video under 3 minutes

The submission write-up is in [`submission/SUBMISSION.md`](submission/SUBMISSION.md), and the video script in [`submission/DEMO-SCRIPT.md`](submission/DEMO-SCRIPT.md).

## How Tilltide uses PayPal (it's central, not bolted on)

| PayPal piece | What Tilltide does with it | Code |
| --- | --- | --- |
| **Partner Referrals** (`/v2/customer/partner-referrals`) | "Connect PayPal" onboards each shop as a merchant under Tilltide as the platform. The connection is confirmed with the merchant-integrations API, never from the return link alone. | `agent/src/services/paypal-onboarding.ts` |
| **Orders v2** (`/v2/checkout/orders`) | Every till sale. The QR opens PayPal checkout, and the customer pays with PayPal or a card. The shop is the `payee`, and the sale is in the shop's own currency (GBP for UK shops). | `agent/src/paypal.ts`, `agent/src/services/payments.ts` |
| **Platform fees** (`payment_instruction.platform_fees`) + BN code | Tilltide's 0.5% on each sale. This is how the product pays for its AI. | `agent/src/services/payments.ts` |
| **Payments v2 refunds** + `PayPal-Auth-Assertion` | Refunds from the shop's own PayPal, proposed by the AI agent and approved by the owner. A `PayPal-Request-Id` makes retries safe. | `agent/src/services/refunds.ts` |
| **PYUSD** on Solana | The default token for wallet payments. Customers can pay in PayPal's stablecoin. | `packages/agent-pay-kit/src/tokens.ts` |
| **Loyalty for PayPal customers** | They earn points and spend them on a later PayPal bill with the code on their receipt. | `agent/src/services/paypal-loyalty.ts` |

## AI tools used

- **Claude API** (`claude-opus-5`, low effort, adaptive thinking) with tool use, via the Anthropic TypeScript SDK's tool runner. The agent has five tools: `get_payments`, `get_daily_summary`, `issue_points`, `sweep_to_owner`, `refund_paypal_payment`.
  - The agent can look up and propose, but **never moves money**. Every refund or sweep needs the owner's wallet signature.
  - Each shop has a daily question cap, and token usage is recorded per shop.
- **End-of-day report:** the facts are written without AI; Claude adds a short note on top.
- **Claude Code** was used to build the project.

## Before submitting

- [ ] Make the GitHub repo public (the rules require a public repo with a visible licence; MIT is already there)
- [ ] PayPal sandbox app: set `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` on the API
- [ ] Partner features in sandbox: set `PAYPAL_PARTNER_MERCHANT_ID` and `PAYPAL_BN_CODE` (from your PayPal developer or partner contact). Without them, shops can name a PayPal email instead.
- [x] API live at https://tilltide.bytez3.com and judge demo at https://demo.tilltide.bytez3.com (Railway services `api` and `demo`)
- [ ] Run one real sandbox sale and refund with a sandbox buyer account
- [ ] Set `ANTHROPIC_API_KEY` and try the agent questions from the demo script
- [ ] Record the video (under 3 minutes) from `submission/DEMO-SCRIPT.md`, upload it publicly to YouTube
- [ ] Paste `submission/SUBMISSION.md` into Devpost, add the repo and video links, submit
