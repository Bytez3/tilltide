# Solana Mobile grant application (draft)

> Fill in the [bracketed] parts. Every claim below matches what's built in this repo as of 21 Oct 2026. Update the traction section after the pilots.

## Project

**Tilltide**: a PayPal-first till for small shops, built for the Solana Seeker. It's an Android app that turns a Seeker into a shop counter.

- **Paying:** customers pay with PayPal or a card, or with PYUSD or USDC from any Solana wallet.
- **Loyalty:** every customer earns points and can spend them at the till.
- **AI back office:** it reconciles takings and writes the end-of-day report.
- **Seeker owners** earn bonus points as customers.

**Links:** repo https://github.com/Bytez3/tilltide · demo video [link] · live API [link]

## Why Seeker

- **The merchant device.** A shop's till is a phone on the counter. With Seed Vault and Mobile Wallet Adapter, the owner signs every money movement on the device itself: sign-in, sending takings home, approving refunds. Tilltide never holds keys.
- **The customer device.** Customers who pay from a Seeker get the shop's **Seeker bonus** (×1.5–×3 points). A customer counts as a Seeker owner if their wallet holds a **Seeker Genesis Token** (verified with `@solana-mobile/skr-genesis-token`) or at least 1 **SKR**. Shops give Seeker owners a reason to pay with their phone, and Seeker owners give shops a reason to accept it.
- **The dApp Store.** Tilltide ships as a Seeker app, with an Android build path already verified (`expo prebuild` and a Gradle debug build).

## What's built

- **Android app** (Expo / React Native, Mobile Wallet Adapter): Charge, Activity, an Agent chat, Settings, staff till devices, and a browser sandbox for demos.
- **Wallet payments:** Solana Pay transfer requests (USDC and Token-2022 PYUSD) and transaction requests, so points can be spent in a single customer signature.
- **Payment checks that can't be gamed:** a payment is verified from the token balance changes in the transaction itself. Junk transactions sent to the payment reference, underpayments and late payments are all handled.
- **Loyalty:** onchain points minted to wallet payers, a ledger for PayPal payers, redemption at the till, and the Seeker bonus.
- **Owner-signed safety:** sweeps carry an onchain memo and are locked until the chain shows the outcome. Refunds need a wallet signature over their exact wording.
- **Quality:** a 38-scenario end-to-end suite against a local validator, run in CI on every push.

## What the grant funds

| Milestone | Deliverable | Timing | Amount |
| --- | --- | --- | --- |
| 1. Seeker pilot | 1–2 Cornwall shops taking real payments on Seeker devices; pilot report with sales, payment split, repeat customers and Seeker-bonus uptake | [Nov–Dec 2026] | [$] |
| 2. dApp Store release | Signed release build, store listing, onboarding flow for new shops | [Dec 2026] | [$] |
| 3. Seeker-native features | Seeker-first checkout (tap-to-pay feel with Seed Vault), push notifications for paid sales, offline-tolerant till | [Q1 2027] | [$] |
| 4. Ten shops | Onboard 10 shops in Cornwall; publish the playbook for other towns | [Q1 2027] | [$] |

## Team

[Steven Isaac, Bytez3: role, background, links.] [Others.]

## Traction

[After pilots: number of shops, sales, % paid by wallet vs PayPal, repeat-customer rate, Seeker-bonus sales.]

## Open source

The payments and agent layer is the MIT-licensed `@tilltide/agent-pay-kit`, packaged with ESM, CommonJS and TypeScript types. See the Solana Foundation application.
