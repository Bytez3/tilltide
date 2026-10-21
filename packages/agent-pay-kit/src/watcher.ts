import type { Address, Rpc, Signature, SolanaRpcApi } from '@solana/kit'
import type { PaymentToken } from './tokens'

export type SolanaRpc = Rpc<SolanaRpcApi>

/** Newest confirmed signature that includes `reference`, or null if the customer hasn't paid yet. */
export async function findSignatureByReference(rpc: SolanaRpc, reference: Address): Promise<Signature | null> {
  const sigs = await rpc.getSignaturesForAddress(reference, { limit: 10, commitment: 'confirmed' }).send()
  const ok = sigs.find((s) => s.err === null)
  return ok?.signature ?? null
}

export interface ExpectedPayment {
  recipient: Address
  token: PaymentToken
  /** Base units. The payment is valid if the recipient received at least this much. */
  amount: bigint
}

export type VerifiedPayment =
  | { ok: true; signature: Signature; payer: Address | null; received: bigint; slot: bigint; blockTime: bigint | null }
  | { ok: false; signature: Signature; reason: string }

interface TokenBalance {
  mint: string
  owner?: string
  uiTokenAmount: { amount: string }
}

function balanceOf(balances: readonly TokenBalance[] | null | undefined, owner: string, mint: string): bigint {
  return (balances ?? [])
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n)
}

/**
 * Checks a transaction actually moved at least `expected.amount` of the token
 * to the recipient. Reads token balance deltas, so it works for any wallet's
 * transaction layout (transfer vs transferChecked, Token vs Token-2022).
 */
export async function verifyPayment(rpc: SolanaRpc, signature: Signature, expected: ExpectedPayment): Promise<VerifiedPayment> {
  const tx = await rpc
    .getTransaction(signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 })
    .send()
  if (!tx) return { ok: false, signature, reason: 'Transaction not found' }
  if (!tx.meta) return { ok: false, signature, reason: 'Transaction has no metadata' }
  if (tx.meta.err) return { ok: false, signature, reason: 'Transaction failed onchain' }

  const pre = tx.meta.preTokenBalances as readonly TokenBalance[] | undefined
  const post = tx.meta.postTokenBalances as readonly TokenBalance[] | undefined
  const mint = expected.token.mint
  const received = balanceOf(post, expected.recipient, mint) - balanceOf(pre, expected.recipient, mint)
  if (received < expected.amount) {
    return { ok: false, signature, reason: `Recipient received ${received}, expected ${expected.amount}` }
  }

  // The payer is whichever owner's balance of this mint went down the most.
  const owners = new Set([...(pre ?? []), ...(post ?? [])].filter((b) => b.mint === mint && b.owner).map((b) => b.owner!))
  let payer: Address | null = null
  let biggestDrop = 0n
  for (const owner of owners) {
    const drop = balanceOf(pre, owner, mint) - balanceOf(post, owner, mint)
    if (drop > biggestDrop) {
      biggestDrop = drop
      payer = owner as Address
    }
  }

  return { ok: true, signature, payer, received, slot: tx.slot, blockTime: tx.blockTime }
}

export interface WaitForPaymentOptions {
  intervalMs?: number
  signal?: AbortSignal
}

/** Polls until a payment carrying `reference` is found and verified, or `signal` aborts. */
export async function waitForPayment(
  rpc: SolanaRpc,
  reference: Address,
  expected: ExpectedPayment,
  { intervalMs = 2000, signal }: WaitForPaymentOptions = {},
): Promise<VerifiedPayment> {
  while (!signal?.aborted) {
    const signature = await findSignatureByReference(rpc, reference)
    if (signature) return verifyPayment(rpc, signature, expected)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('Stopped waiting for payment')
}
