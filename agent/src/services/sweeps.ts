import { address, type Signature } from '@solana/kit'
import { findAssociatedTokenPda } from '@solana-program/token'
import { fromBaseUnits, verifyPayment } from '@tilltide/agent-pay-kit'
import { config } from '../config'
import { sql, type MerchantRow, type SweepRow } from '../db'
import { rpc } from '../solana'
import { merchantToken } from './merchants'

/** A signed sweep that hasn't landed after this long can no longer land (its blockhash expired). */
const SUBMIT_EXPIRY_MS = 3 * 60 * 1000

export class SweepError extends Error {}

/** Current balance of the merchant's till token account, in base units. */
export async function tillBalance(merchant: MerchantRow): Promise<bigint> {
  const token = merchantToken(merchant)
  const [account] = await findAssociatedTokenPda({
    owner: address(merchant.wallet),
    mint: token.mint,
    tokenProgram: token.tokenProgram,
  })
  return rpc
    .getTokenAccountBalance(account, { commitment: 'confirmed' })
    .send()
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n)
}

/** Records a sweep proposal. Nothing moves until the owner signs it in the app. */
export async function proposeSweep(merchant: MerchantRow, amount: bigint, reason: string | null): Promise<SweepRow> {
  if (!merchant.ownerWallet) throw new SweepError('No owner wallet set. Add one in Settings first.')
  if (merchant.ownerWallet === merchant.wallet) throw new SweepError('Owner wallet is the same as the till wallet')
  if (amount <= 0n) throw new SweepError('Sweep amount must be more than zero')
  const token = merchantToken(merchant)
  const [inFlight] = await sql`select 1 from sweeps where merchant_id = ${merchant.id} and status = 'submitted'`
  if (inFlight) throw new SweepError('A sweep is still confirming. Wait for it before proposing another.')
  const balance = await tillBalance(merchant)
  if (amount > balance) throw new SweepError(`The till only holds ${fromBaseUnits(balance, token.decimals)} ${token.symbol}`)

  // One open proposal at a time keeps the confirm step unambiguous.
  await sql`update sweeps set status = 'cancelled' where merchant_id = ${merchant.id} and status = 'proposed'`
  const [row] = await sql<SweepRow[]>`
    insert into sweeps (merchant_id, amount, token_symbol, to_wallet, reason)
    values (${merchant.id}, ${amount.toString()}, ${token.symbol}, ${merchant.ownerWallet}, ${reason})
    returning *`
  return row!
}

export async function getSweep(merchant: MerchantRow, id: string): Promise<SweepRow | null> {
  const [row] = await sql<SweepRow[]>`select * from sweeps where id = ${id} and merchant_id = ${merchant.id}`
  return row ?? null
}

/** Checks a transaction is exactly this sweep: from the till, to the owner, at least the amount, after the proposal. */
async function verifySweepTransaction(merchant: MerchantRow, sweep: SweepRow, signature: Signature): Promise<string | null> {
  const result = await verifyPayment(rpc, signature, {
    recipient: address(sweep.toWallet),
    token: config.tokens[sweep.tokenSymbol],
    amount: sweep.amount,
  })
  if (!result.ok) return result.reason
  if (result.payer !== merchant.wallet) return 'That transaction was not sent from the till wallet'
  if (result.blockTime !== null && Number(result.blockTime) * 1000 < sweep.createdAt.getTime() - 60_000) {
    return 'That transaction is older than this sweep proposal'
  }
  return null
}

/**
 * The app reports the signature straight after the wallet signs and sends. From here the sweep is
 * 'submitted' and can't be signed again until the chain shows this transaction can't land.
 */
export async function submitSweep(merchant: MerchantRow, id: string, signature: Signature): Promise<SweepRow> {
  const [usedElsewhere] = await sql`select 1 from sweeps where signature = ${signature} and id <> ${id}`
  if (usedElsewhere) throw new SweepError('That transaction already belongs to another sweep')
  const [row] = await sql<SweepRow[]>`
    update sweeps set status = 'submitted', signature = ${signature}, submitted_at = now()
    where id = ${id} and merchant_id = ${merchant.id} and status = 'proposed' returning *`
  if (!row) {
    const existing = await getSweep(merchant, id)
    if (!existing) throw new SweepError('Sweep not found')
    if (existing.signature === signature) return settleSweep(merchant, existing)
    throw new SweepError(`Sweep is already ${existing.status}`)
  }
  return settleSweep(merchant, row)
}

/**
 * Brings a sweep up to date with the chain:
 * - submitted → confirmed when its transaction verifies, or back to proposed if it failed or expired.
 * - proposed → confirmed if the till already sent a matching transfer (e.g. the app lost the signature).
 */
export async function settleSweep(merchant: MerchantRow, sweep: SweepRow): Promise<SweepRow> {
  if (sweep.status === 'submitted' && sweep.signature) {
    const signature = sweep.signature as Signature
    const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const status = value[0]
    const landed = status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    if (landed) {
      const problem = await verifySweepTransaction(merchant, sweep, signature)
      if (!problem) return markConfirmed(sweep, signature)
      return revertToProposed(sweep, problem)
    }
    if (status?.err) return revertToProposed(sweep, 'The sweep transaction failed onchain; nothing moved')
    const age = Date.now() - (sweep.submittedAt?.getTime() ?? 0)
    if (!status && age > SUBMIT_EXPIRY_MS) return revertToProposed(sweep, 'The sweep never reached the chain; nothing moved')
    return sweep
  }

  if (sweep.status === 'proposed') {
    const token = config.tokens[sweep.tokenSymbol]
    const [till] = await findAssociatedTokenPda({ owner: address(merchant.wallet), mint: token.mint, tokenProgram: token.tokenProgram })
    const since = BigInt(Math.floor(sweep.createdAt.getTime() / 1000) - 60)
    const recent = await rpc.getSignaturesForAddress(till, { limit: 50, commitment: 'confirmed' }).send()
    const used = new Set((await sql<{ signature: string }[]>`select signature from sweeps where signature is not null`).map((r) => r.signature))
    for (const s of recent) {
      if (s.err || s.blockTime === null || s.blockTime < since || used.has(s.signature)) continue
      if (!(await verifySweepTransaction(merchant, sweep, s.signature))) return markConfirmed(sweep, s.signature)
    }
  }
  return sweep
}

async function markConfirmed(sweep: SweepRow, signature: Signature): Promise<SweepRow> {
  const [row] = await sql<SweepRow[]>`
    update sweeps set status = 'confirmed', signature = ${signature}, error = null
    where id = ${sweep.id} and status in ('proposed', 'submitted') returning *`
  return row ?? (await sql<SweepRow[]>`select * from sweeps where id = ${sweep.id}`)[0]!
}

async function revertToProposed(sweep: SweepRow, error: string): Promise<SweepRow> {
  const [row] = await sql<SweepRow[]>`
    update sweeps set status = 'proposed', signature = null, submitted_at = null, error = ${error}
    where id = ${sweep.id} and status = 'submitted' returning *`
  return row ?? (await sql<SweepRow[]>`select * from sweeps where id = ${sweep.id}`)[0]!
}

export function serializeSweep(s: SweepRow) {
  const token = config.tokens[s.tokenSymbol]
  return {
    id: s.id,
    amount: s.amount.toString(),
    display: fromBaseUnits(s.amount, token.decimals),
    decimals: token.decimals,
    token: s.tokenSymbol,
    toWallet: s.toWallet,
    reason: s.reason,
    status: s.status,
    signature: s.signature,
    error: s.error,
    createdAt: s.createdAt.toISOString(),
  }
}
