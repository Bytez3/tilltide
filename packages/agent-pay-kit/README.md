# agent-pay-kit

Small, dependency-light building blocks for taking stablecoin payments on Solana and letting an AI agent work with them. Built on [`@solana/kit`](https://github.com/anza-xyz/kit). MIT licensed.

| Module | What it does |
| --- | --- |
| `solana-pay` | `encodeTransferRequest` / `parseTransferRequest` for [Solana Pay](https://docs.solanapay.com/spec) QR codes, with a unique `reference` per sale |
| `watcher` | `findSignatureByReference`, `verifyPayment`, `waitForPayment`: find a payment by its reference and check the recipient actually received the amount (from token balance deltas, so it works with any wallet) |
| `loyalty` | `calculatePoints` and `getIssuePointsInstructions` to mint SPL loyalty points to the payer |
| `sweep` | `getSweepInstructions` to move takings to the owner's wallet, signed by the merchant's wallet |
| `tokens` | USDC (Token) and PYUSD (Token-2022) mints for devnet and mainnet |
| `amount` | `toBaseUnits` / `fromBaseUnits`: bigint money, no floats |

```ts
import { createSolanaRpc, generateKeyPairSigner, address } from '@solana/kit'
import { encodeTransferRequest, waitForPayment, toBaseUnits, TOKENS } from '@tilltide/agent-pay-kit'

const rpc = createSolanaRpc('https://api.devnet.solana.com')
const token = TOKENS.devnet.USDC
const recipient = address('…shop wallet…')
const reference = (await generateKeyPairSigner()).address
const amount = toBaseUnits('4.50', token.decimals)

const url = encodeTransferRequest({ recipient, amount, token, reference, label: 'Pasty Shop' })
// render `url` as a QR code, then:
const result = await waitForPayment(rpc, reference, { recipient, token, amount })
if (result.ok) console.log(`Paid by ${result.payer}`)
```

Agent tools (`get_payments`, `get_daily_summary`, `issue_points`, `sweep_to_owner`) live in [`agent/`](../../agent) for now and move into this package at M4.
