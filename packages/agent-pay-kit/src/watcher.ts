import type { Address, Rpc, Signature, SolanaRpcApi } from '@solana/kit'
import { SUPPORTED_MEMO_PROGRAM_ADDRESSES } from '@solana-program/memo'
import type { PaymentToken } from './tokens'

export type SolanaRpc = Rpc<SolanaRpcApi>

/**
 * Successful signatures that include `reference`, oldest first. Pages through the whole history
 * (up to `maxPages` × 1000), so a flood of failed transactions can't push the real payment out of view.
 */
export async function findSignaturesByReference(rpc: SolanaRpc, reference: Address, maxPages = 20): Promise<Signature[]> {
  const ok: Signature[] = []
  let before: Signature | undefined
  for (let page = 0; page < maxPages; page++) {
    const batch = await rpc.getSignaturesForAddress(reference, { limit: 1000, before, commitment: 'confirmed' }).send()
    for (const s of batch) if (s.err === null) ok.push(s.signature)
    if (batch.length < 1000) break
    before = batch.at(-1)!.signature
  }
  return ok.reverse()
}

/** Oldest successful signature that includes `reference`, or null if nothing has been sent yet. */
export async function findSignatureByReference(rpc: SolanaRpc, reference: Address): Promise<Signature | null> {
  return (await findSignaturesByReference(rpc, reference))[0] ?? null
}

export interface ExpectedPayment {
  recipient: Address
  token: PaymentToken
  /** Base units. The payment is valid if the recipient received at least this much. */
  amount: bigint
}

export type VerifiedPayment =
  | {
      ok: true
      signature: Signature
      payer: Address | null
      received: bigint
      slot: bigint
      blockTime: bigint | null
      /** Text of any memo instructions in the transaction. */
      memos: string[]
      /** How the payer's balance of every mint changed in this transaction (negative = spent or burned). */
      payerDeltas: Record<string, bigint>
      /**
       * The net change of every mint across all accounts in the transaction. A burn shows as negative;
       * a transfer between wallets nets to zero. Use it to tell "spent" from "moved".
       */
      mintDeltas: Record<string, bigint>
    }
  /** `retryable`: the RPC hasn't caught up yet; check again rather than treating it as a bad payment. */
  | { ok: false; signature: Signature; reason: string; retryable?: boolean; memos?: string[] }

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
  if (!tx) return { ok: false, signature, reason: 'Transaction not found', retryable: true }
  if (!tx.meta) return { ok: false, signature, reason: 'Transaction has no metadata', retryable: true }
  const memoPrograms = new Set<string>(SUPPORTED_MEMO_PROGRAM_ADDRESSES)
  const memos = (tx.transaction.message.instructions as readonly { programId?: string; parsed?: unknown }[])
    .filter((ix) => ix.programId && memoPrograms.has(ix.programId) && typeof ix.parsed === 'string')
    .map((ix) => ix.parsed as string)
  if (tx.meta.err) return { ok: false, signature, reason: 'Transaction failed onchain', memos }

  const pre = tx.meta.preTokenBalances as readonly TokenBalance[] | undefined
  const post = tx.meta.postTokenBalances as readonly TokenBalance[] | undefined
  const mint = expected.token.mint
  const received = balanceOf(post, expected.recipient, mint) - balanceOf(pre, expected.recipient, mint)
  if (received < expected.amount) {
    return { ok: false, signature, reason: `Recipient received ${received}, expected ${expected.amount}`, memos }
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

  // Paid entirely with points (nothing of `mint` moved): the payer is the fee payer, the first signer.
  if (!payer) {
    const keys = tx.transaction.message.accountKeys as readonly (string | { pubkey: string; signer?: boolean })[]
    const first = keys.find((k) => typeof k !== 'string' && k.signer) ?? keys[0]
    if (first) payer = (typeof first === 'string' ? first : first.pubkey) as Address
  }

  const payerDeltas: Record<string, bigint> = {}
  if (payer) {
    const mints = new Set([...(pre ?? []), ...(post ?? [])].filter((b) => b.owner === payer).map((b) => b.mint))
    for (const m of mints) payerDeltas[m] = balanceOf(post, payer, m) - balanceOf(pre, payer, m)
  }

  const mintDeltas: Record<string, bigint> = {}
  for (const b of post ?? []) mintDeltas[b.mint] = (mintDeltas[b.mint] ?? 0n) + BigInt(b.uiTokenAmount.amount)
  for (const b of pre ?? []) mintDeltas[b.mint] = (mintDeltas[b.mint] ?? 0n) - BigInt(b.uiTokenAmount.amount)

  return { ok: true, signature, payer, received, slot: tx.slot, blockTime: tx.blockTime, memos, payerDeltas, mintDeltas }
}

export type PaymentSearch =
  | { status: 'paid'; payment: Extract<VerifiedPayment, { ok: true }> }
  /** Something carrying the reference arrived, but none of it is a valid payment (e.g. underpaid). */
  | { status: 'mismatch'; reason: string }
  | { status: 'none' }

/**
 * Looks at every transaction carrying `reference` and accepts the first valid payment.
 * Anyone can see the reference in the QR, so one bad or dust transaction must not block the real one.
 */
export async function findPayment(
  rpc: SolanaRpc,
  reference: Address,
  expected: ExpectedPayment,
  /**
   * Signatures already known not to be a valid payment. Pass the same set on every poll: each
   * transaction is then fetched once, so a flood of dust can't slow the watcher down.
   */
  rejected: Set<string> = new Set(),
): Promise<PaymentSearch> {
  let mismatch: string | null = null
  const fresh = (await findSignaturesByReference(rpc, reference)).filter((s) => !rejected.has(s))
  for (let i = 0; i < fresh.length; i += 10) {
    const results = await Promise.all(fresh.slice(i, i + 10).map((signature) => verifyPayment(rpc, signature, expected)))
    for (const result of results) {
      if (result.ok) return { status: 'paid', payment: result }
      if (result.retryable) continue
      rejected.add(result.signature)
      mismatch = result.reason
    }
  }
  return mismatch ? { status: 'mismatch', reason: mismatch } : { status: 'none' }
}

export interface WaitForPaymentOptions {
  intervalMs?: number
  signal?: AbortSignal
}

/** Polls until a valid payment carrying `reference` arrives, or `signal` aborts. */
export async function waitForPayment(
  rpc: SolanaRpc,
  reference: Address,
  expected: ExpectedPayment,
  { intervalMs = 2000, signal }: WaitForPaymentOptions = {},
): Promise<VerifiedPayment> {
  // One set across polls, so each junk transaction on the reference is fetched only once.
  const rejected = new Set<string>()
  while (!signal?.aborted) {
    const found = await findPayment(rpc, reference, expected, rejected)
    if (found.status === 'paid') return found.payment
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs)
      signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })
  }
  throw new Error('Stopped waiting for payment')
}
