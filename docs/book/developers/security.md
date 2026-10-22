# Security model

## Keys

* **The phone holds no private keys.** The till wallet lives in the wallet app (Seed Vault, Phantom, Solflare) and signs through Mobile Wallet Adapter.
* **The server holds one key:** the loyalty mint authority, in an environment variable. It mints loyalty points and pays the fees and account rent for doing so, so it holds a little SOL. It can't touch any shop's money.
* **The app holds no keys at all,** not even an RPC key: blockhashes for signing come from the server, and the app refuses to start if a key-like value is put in its public settings.
* **No PayPal passwords.** Shops connect through PayPal's partner onboarding; refunds use PayPal-Auth-Assertion on the shop's behalf.

## Sign-in and sessions

* Sign In With Solana with a server nonce, bound to the deployment's domain. Forged signatures, replayed nonces and the wrong domain are rejected.
* Session tokens are random and stored hashed.
* Staff phones get a session limited by a default-deny allowlist: new routes are owner-only unless explicitly allowed.
* Every `/shop` query is scoped to the signed-in shop.

## Money flows

* **The agent proposes, the owner signs.** Sweeps and refunds are stored as proposals. A sweep needs the till wallet's transaction signature; a refund needs a wallet signature over its exact wording.
* **Sweeps** carry a `tilltide:sweep:<id>` memo and are confirmed only when the chain shows that memo, from the till, to the owner, for the right amount. A submitted sweep is locked until the chain proves it can no longer land, so it can't be signed twice.
* **Refunds** use a PayPal idempotency key and a lease, so a retry or lost response can't refund twice.
* **Payments** are verified from token balance changes, and every transaction on the reference is checked, so dust can't block or fake a payment.
* **Baskets** are priced on the server from the shop's own menu.
* **Points** have a state machine (`sending` → `issued`), so they're never minted twice.
* **Points stay with their shop.** All shops share one points token, but each shop honours only the points it issued itself, so one shop's earn rate can't create discounts at another.
* **Spending points means burning them.** A points sale only counts points that left circulation; moving them to another wallet doesn't count.
* **Points-account rent can't be farmed:** each wallet's account is opened once, a first points sale must be at least 1.00, and there are daily limits per shop and overall.
* **PayPal payouts can't be redirected with a session alone:** on live PayPal a payout email can't be set, and a connected PayPal account can't be re-linked from the app.
* **Refunded PayPal sales give back their points** in proportion to the refund.

## The server

* Security headers, a 64 KB body limit, and per-IP rate limits (keyed on Cloudflare's or Railway's client IP header).
* Optional `ORIGIN_SECRET`: a header added by the Cloudflare proxy, so requests that skip Cloudflare are refused.
* On mainnet, the server refuses to start with unsafe settings (public RPC, an http `PUBLIC_URL`, fixed exchange rates, PayPal sales to the platform account).
* Customer-facing pages (receipt, landing page) escape everything and load nothing from other sites.

Found a problem? Email [info@bytez3.com](mailto:info@bytez3.com).
