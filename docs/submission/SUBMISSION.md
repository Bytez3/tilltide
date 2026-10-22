# Tilltide

**A PayPal-first till and AI back office for small shops: PayPal at the counter, loyalty that customers actually spend, and an AI assistant that keeps the books but can never move a penny without the owner.**

Try it: **https://demo.tilltide.bytez3.com** · Repo: https://github.com/Bytez3/tilltide · Video: _add YouTube link_ · Licence: MIT

---

## Try it (for judges)

Open **https://demo.tilltide.bytez3.com** in any browser. No account, wallet or install is needed.
1. Type a shop name and press **Sign in with wallet**. A throwaway test wallet is made for you.
2. In **Settings**, press **Connect PayPal** and add a couple of menu items.
3. On **Charge**, tap items and choose PayPal or wallet. The QR screen has "act as the customer" buttons, so you can pay as the customer too.
4. Try **Activity** (refunds, sending takings to the owner, the end-of-day report) and the **Assistant** tab.

The demo runs on its own local Solana chain with a stand-in PayPal, so nothing real is touched. To run it yourself, see "Try it in a browser" in the [README](https://github.com/Bytez3/tilltide#try-it-in-a-browser-sandbox). The phone app (Android, with a Solana wallet such as Phantom or Solflare) talks to the devnet API at https://tilltide.bytez3.com.

## Inspiration

We're based in Cornwall, surrounded by small independent shops: cafés, bakeries, surf hire, pasty shops. They pay card-reader fees on every sale. Their loyalty schemes are paper stamp cards. Their bookkeeping happens at 9pm on a kitchen table.

AI agents that can *pay* are everywhere now. We wanted the opposite: an agent that does the shop's back-office thinking, while the money stays firmly in the owner's hands.

## What it does

**At the counter.** The owner (or a staff member on their own phone) types the price in pounds and the till shows a QR code.
- **PayPal (the default):** the QR opens PayPal checkout, and the customer pays with PayPal or a card. The money lands in **the shop's own PayPal account**, connected through PayPal's partner onboarding.
- **Wallet:** customers with a Solana wallet pay in **PYUSD**, PayPal's stablecoin, at the day's exchange rate.

**Loyalty that customers spend, not just collect.** Every customer earns points, whichever way they pay.
- **PayPal customers** get a loyalty code on their receipt. Next visit, the till takes the code and points come off the PayPal bill.
- **Wallet customers** hold their points onchain and spend them in a single signature at the till.

**An AI back office (Claude).** The owner asks in plain English:
- "What did I take today?"
- "Who are my regulars?"
- "Refund the cream tea, the scone was cold."

The agent reads the ledger, reconciles PayPal and wallet takings together, and writes an end-of-day report at closing time. When something needs doing, like a refund or moving takings to the owner, **the agent only proposes it**. The owner approves by signing the exact wording with their wallet, and only then does the server act through PayPal's API.

**For the bookkeeper.** A one-tap CSV of sales, refunds and transfers for the month.

## How we used PayPal

PayPal is the backbone of the product, not a payment button:
- **Partner Referrals** onboard each shop. Tilltide confirms the connection with PayPal's merchant-integrations API rather than trusting the return link.
- **Orders v2** is every PayPal sale, in the shop's own currency, with the shop as `payee`.
- **Platform fees** (`payment_instruction.platform_fees`) take Tilltide's 0.5%. That fee is the business model, and it pays for the AI.
- **Payments v2 refunds** run on the shop's behalf (`PayPal-Auth-Assertion`). A `PayPal-Request-Id` makes retries safe: tests prove a lost response or a retried error can never refund twice.
- **PYUSD** is the default for wallet payments.

## How we used AI

- **The agent:** Claude (`claude-opus-5`) through the Anthropic TypeScript SDK's tool runner, with five tools: `get_payments`, `get_daily_summary` (with optional reconciliation against the chain), `issue_points`, `sweep_to_owner` and `refund_paypal_payment`. The two money tools only create proposals.
- **Cost control:** effort is kept low for chat, each shop has a daily question cap, and token usage is recorded per shop.
- **End-of-day report:** the facts are always computed without AI, so they're always right. Claude adds a short, warm note on top.
- **Building it:** the project was built with Claude Code.

## How we built it

- **App:** one Expo / React Native codebase for the Solana Seeker and other Android phones (Mobile Wallet Adapter), iPhone (Phantom and Solflare deeplinks), and the web (Wallet Standard), so the owner's keys stay in their own wallet on every phone.
- **API:** Node/TypeScript (Hono + Postgres) on Railway.
- **Open-source kit:** `@tilltide/agent-pay-kit` (MIT). It covers Solana Pay transfer and transaction requests, payment verification that a flood of junk transactions can't fool, loyalty minting and redemption, and sweep instructions with an identifying memo.
- **Testing:** a 40-scenario end-to-end suite runs the real API against a local Solana validator, a stand-in PayPal, and a fresh database. It covers:
  - forged sign-ins and replayed approvals
  - underpayment, overpayment and late payment
  - double refunds after lost responses
  - staff trying to move money
  - parallel refund proposals, spreadsheet formula injection, and more

## Security choices we're proud of

- **No keys in the app.** Owners sign in with their wallet (Sign In With Solana). Every shop route is scoped to the signed-in wallet.
- **The agent can't move money.** Refunds need a wallet signature over the refund's exact wording, plus a single-use challenge. Transfers to the owner are locked until the chain shows whether a signed one landed.
- **A stolen session can't redirect the money.** Changing where takings go needs the till wallet to sign the new address, the same way refunds do.
- **A loyalty code is only good for its owner.** Points on a PayPal bill are spent only if the PayPal account paying is the one that earned them, so a code seen on someone's receipt is useless to anyone else.
- **Staff devices are limited by the server, not just hidden in the app.** They pair with a one-time code, take payments only, and the server refuses everything else by default.
- **Payments are verified from what the transaction actually did**, not from what the server offered. A customer can't game a points discount.

## Challenges

- **Money correctness when networks fail.** A refund that succeeded but whose response was lost must never be retried as a new refund, and a points mint that timed out must never be minted twice. We built small state machines with leases and idempotency keys, then wrote tests that simulate each failure.
- **Pricing in pounds while settling in dollar stablecoins**, with points discounts in between. Each sale stores the exact token amount and rate it was priced at, and verification uses only that.

## What we learned

The interesting part of agentic finance for small businesses isn't letting the AI pay. It's letting the AI *understand*, while keeping every action that moves money a human decision.

## What's next

- Pilots with 1–2 Cornwall shops after Breakpoint London (Nov 15–17).
- Mainnet launch, then the Solana dApp Store for Seeker.
- Bonus points for Seeker holders (SKR).
- Publishing `agent-pay-kit` as a public good.

## Built with

PayPal Orders v2 · PayPal Payments v2 · PayPal Partner Referrals · PYUSD · Claude API (Anthropic) · Solana · Solana Pay · Solana Mobile Wallet Adapter · Expo · React Native · TypeScript · Hono · PostgreSQL · Railway
