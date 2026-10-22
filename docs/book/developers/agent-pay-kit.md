# agent-pay-kit

`@tilltide/agent-pay-kit` is a small MIT-licensed TypeScript library for taking stablecoin payments in physical shops on Solana, and for letting an AI agent work with them safely. It's built on [`@solana/kit`](https://github.com/anza-xyz/kit) and runs in Node and React Native.

```bash
npm install @tilltide/agent-pay-kit @solana/kit @solana-program/token @solana-program/memo
```

## Take a payment

```ts
import { createSolanaRpc, generateKeyPairSigner, address } from '@solana/kit'
import { encodeTransferRequest, waitForPayment, toBaseUnits, TOKENS } from '@tilltide/agent-pay-kit'

const rpc = createSolanaRpc('https://api.devnet.solana.com')
const token = TOKENS.devnet.USDC
const recipient = address('…shop wallet…')
const reference = (await generateKeyPairSigner()).address // unique per sale
const amount = toBaseUnits('4.50', token.decimals)

const url = encodeTransferRequest({ recipient, amount, token, reference, label: 'Pasty Shop' })
// show `url` as a QR code, then:
const paid = await waitForPayment(rpc, reference, { recipient, token, amount })
console.log(`Paid by ${paid.payer}`)
```

## Modules

### `amount`

* `toBaseUnits(value: string, decimals)` → `bigint`. Exact; rejects too many decimals.
* `fromBaseUnits(amount: bigint, decimals)` → `string`, with trailing zeros removed.

Money is always `bigint`; amounts never pass through floating point. (The one number that isn't a bigint is a loyalty earn rate, such as 1.5 points per unit, which is exact to hundredths.)

### `tokens`

`TOKENS[cluster][symbol]` gives the mint, decimals and token program for USDC (Token) and PYUSD (Token-2022) on `devnet` and `mainnet`.

### `solana-pay`

* `encodeTransferRequest({ recipient, amount, token, reference, label?, message?, memo? })` builds a spec-correct `solana:` URL (spaces as `%20`).
* `parseTransferRequest(url)` reads one back.
* `encodeTransactionRequest(link)` wraps an http(s) link for a [transaction request](https://docs.solanapay.com/spec#specification-transaction-request), where the wallet fetches a transaction from your server.

### `watcher`

* `findPayment(rpc, reference, expected, rejected?)` checks **every** transaction carrying the reference and returns `{ status: 'paid', payment }`, `{ status: 'mismatch', reason }` or `{ status: 'none' }`. Pass the same `rejected` set on every poll, so each bad transaction is fetched only once.
* `verifyPayment(rpc, signature, expected)` checks that one transaction moved at least `expected.amount` to the recipient. It reads token balance changes, so it works for any wallet (`transfer` or `transferChecked`, Token or Token-2022). It returns the payer, the amount received, any memos, how the payer's balance of every mint changed (`payerDeltas`), and the net change of every mint across the whole transaction (`mintDeltas`). A burn shows in `mintDeltas` as negative; tokens merely moved to another wallet net to zero, so use it to tell "spent" from "moved".
* `waitForPayment(rpc, reference, expected, { intervalMs?, signal? })` polls until paid, fetching each junk transaction only once, and stops promptly when `signal` aborts.

A result with `retryable: true` means the RPC hasn't caught up yet. Check again; don't treat it as a bad payment.

{% hint style="info" %}
Why check every transaction? The reference is public (it's in the QR code). Checking only "a transaction with my reference exists" lets anyone fake a payment with a dust transfer, or block the real one.
{% endhint %}

### `loyalty`

* `calculatePoints(amount, decimals, { pointsPerUnit, bonusMultiplier? }, bonus?)` gives whole points, rounding down. Rates and multipliers are exact to hundredths (1.25 is fine; 0.015 is treated as 0.02).
* `getIssuePointsInstructions({ payer, mintAuthority, pointsMint, customer, points })` creates the customer's points account if needed and mints into it.

### `redeem`

* `planRedemption(price, pointsBalance, { pointValue, maxPercent })` returns `{ points, discount, toPay }`, capped at a percentage of the bill.
* `getRedeemPaymentInstructions({ customer, recipient, token, toPay, pointsMint, points, reference, memo })` pays the discounted amount and burns the points in one transaction the customer signs. Pass the customer as an `Address` when building it for their wallet to sign (a transaction request).

### `sweep`

* `getSweepInstructions({ from, to, token, amount, fee?, sweepId })` moves takings from the till to the owner, with an optional platform fee in the same transaction and a `tilltide:sweep:<id>` memo that identifies it onchain.
* `sweepFee(gross, bps)` calculates the fee.
* `sweepMemo(id)` returns the memo text, so you can check a confirmed transaction is the sweep you proposed and not a look-alike.

## Using it with an AI agent

The pattern Tilltide follows: give the agent tools that **read** (payments, summaries, reconciliation) and tools that **propose** (a sweep or refund stored as `proposed`). The human signs the exact proposal on their own device, and the server verifies the signed transaction or message before anything moves. The agent never holds a key.

## Publishing

Publish with `pnpm publish`, which swaps in the built `dist` entry points (ESM, CommonJS and types for both). Plain `npm publish` would ship source paths and a broken package.

## Licence

MIT. Source: [`packages/agent-pay-kit`](https://github.com/Bytez3/tilltide/tree/main/packages/agent-pay-kit).
