# Solana Foundation grant application (draft)

> Fill in the [bracketed] parts. The public good is `@tilltide/agent-pay-kit` (MIT), in `packages/agent-pay-kit`.

## Summary

`agent-pay-kit` is a small, dependency-light TypeScript kit for **taking stablecoin payments in physical shops on Solana, and letting AI agents work with them safely**. It's built on `@solana/kit`, works in React Native and Node, and is MIT-licensed. It was extracted from Tilltide, a working PayPal-first till for small shops.

## The problem it solves

Every team building point-of-sale payments on Solana rewrites the same fiddly, money-critical code, and the common shortcuts are unsafe:
- **Spoofable payment checks.** Checking "a transaction with my reference exists" is spoofable. Anyone can see the reference in the QR, and one junk transaction can block or fake a payment.
- **Fragile parsing.** Parsing transfers by instruction layout breaks across wallets, Token versus Token-2022, and `transfer` versus `transferChecked`.
- **Points with no spend path.** Loyalty is usually minted, never redeemed in the same signature as the payment.
- **Agents with too much power.** AI agents are usually given keys. They should only *propose*, with a human signing.

## What's in the kit

| Module | What it does |
| --- | --- |
| `solana-pay` | Spec-correct transfer request encoding and parsing (spaces as `%20`, multiple references). |
| `redeem` | Transaction requests, `planRedemption` (points capped at a % of the bill), and pay-and-burn-points in one signature. |
| `watcher` | `findPayment` reads token balance changes, so it works with any wallet, Token or Token-2022. It checks **every** transaction on the reference (paged, cached, batched), so junk can't block a real payment, and flags RPC lag as retryable instead of failing. It also reports memos and the payer's change on every mint. |
| `loyalty` | `calculatePoints` with exact fractional rates and bonuses, and minting instructions with idempotent token account creation. |
| `sweep` | Moving takings to the owner, with an optional platform fee in the same signature and a memo that identifies the sweep onchain, so a look-alike manual transfer can never be confused for it. |
| `tokens`, `amount` | USDC and PYUSD mints for devnet and mainnet, and bigint money with no floats. |

It's tested by 9 unit tests, plus Tilltide's 36-scenario end-to-end suite against `solana-test-validator`, run in CI.

## Milestones

| Milestone | Deliverable | Timing | Amount |
| --- | --- | --- | --- |
| 1. 1.0 release | Publish to npm, write API docs, a "take a payment" example app, and a security notes page | [Nov 2026] | [$] |
| 2. Agent tools | Move Tilltide's agent tools (proposal-only sweeps and refunds, reconciliation) into the kit, provider-agnostic | [Dec 2026] | [$] |
| 3. Webhook watcher | A Helius/Triton webhook adapter alongside polling, with the same verification guarantees | [Jan 2027] | [$] |
| 4. Adoption | Two integrations by other teams; a workshop at a Solana community event | [Q1 2027] | [$] |

## Team

[Steven Isaac, Bytez3: background, links.]

## Proof it works

Tilltide uses the kit in production code. [Pilot numbers once available.] Repo: https://github.com/Bytez3/tilltide
