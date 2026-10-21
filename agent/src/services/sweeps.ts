import { address, type Signature } from '@solana/kit'
import { findAssociatedTokenPda } from '@solana-program/token'
import { fromBaseUnits, sweepFee, sweepMemo, verifyPayment } from '@tilltide/agent-pay-kit'
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
  const [inFlight] = await sql`select 1 from sweeps where merchant_id = ${merchant.id} and status in ('signing', 'submitted')`
  if (inFlight) throw new SweepError('A sweep is still being signed or confirmed. Wait for it before proposing another.')
  const balance = await tillBalance(merchant)
  if (amount > balance) throw new SweepError(`The till only holds ${fromBaseUnits(balance, token.decimals)} ${token.symbol}`)

  const { treasury, bps } = config.sweepFee
  const fee = treasury ? sweepFee(amount, bps) : 0n

  // One open proposal at a time keeps the confirm step unambiguous.
  await sql`update sweeps set status = 'cancelled' where merchant_id = ${merchant.id} and status = 'proposed'`
  const [row] = await sql<SweepRow[]>`
    insert into sweeps (merchant_id, amount, token_symbol, to_wallet, reason, fee_amount, fee_wallet)
    values (${merchant.id}, ${amount.toString()}, ${token.symbol}, ${merchant.ownerWallet}, ${reason},
      ${fee.toString()}, ${fee > 0n ? treasury : null})
    returning *`
  return row!
}

export async function getSweep(merchant: MerchantRow, id: string): Promise<SweepRow | null> {
  const [row] = await sql<SweepRow[]>`select * from sweeps where id = ${id} and merchant_id = ${merchant.id}`
  return row ?? null
}

type SweepCheck =
  | { kind: 'ok' }
  /** RPC hasn't caught up; ask again later. Never treat this as "didn't happen". */
  | { kind: 'retry' }
  /** A real transaction, but not this sweep (no matching memo). Nothing moved for this sweep. */
  | { kind: 'not-this-sweep'; reason: string }
  /** Carries this sweep's memo but doesn't add up. Money may have moved: stop and let a human look. */
  | { kind: 'bad'; reason: string }

/** Identifies the sweep by its onchain memo, then checks it went from the till to the owner in full. */
async function checkSweepTransaction(merchant: MerchantRow, sweep: SweepRow, signature: Signature): Promise<SweepCheck> {
  const result = await verifyPayment(rpc, signature, {
    recipient: address(sweep.toWallet),
    token: config.tokens[sweep.tokenSymbol],
    amount: sweep.amount - sweep.feeAmount,
  })
  if (!result.ok && result.retryable) return { kind: 'retry' }
  if (!result.memos?.includes(sweepMemo(sweep.id))) {
    return { kind: 'not-this-sweep', reason: "That transaction isn't this sweep; nothing moved for it" }
  }
  if (!result.ok) return { kind: 'bad', reason: `The sweep transaction landed but doesn't add up: ${result.reason}` }
  if (result.payer !== merchant.wallet) return { kind: 'bad', reason: 'The sweep transaction was not sent from the till wallet' }
  if (sweep.feeAmount > 0n && sweep.feeWallet) {
    const fee = await verifyPayment(rpc, signature, {
      recipient: address(sweep.feeWallet),
      token: config.tokens[sweep.tokenSymbol],
      amount: sweep.feeAmount,
    })
    if (!fee.ok) return fee.retryable ? { kind: 'retry' } : { kind: 'bad', reason: `The sweep fee didn't add up: ${fee.reason}` }
  }
  return { kind: 'ok' }
}

/**
 * Called just before the app opens the wallet. Locks the sweep until the transaction's blockhash
 * expires, so it can't be signed twice even if the app loses track of what the wallet did.
 */
export async function beginSweep(merchant: MerchantRow, id: string, lastValidBlockHeight: bigint): Promise<SweepRow> {
  const existing = await getSweep(merchant, id)
  if (!existing) throw new SweepError('Sweep not found')
  const current = await settleSweep(merchant, existing)
  if (current.status === 'signing') throw new SweepError('This sweep is already open in the wallet. Try again in a minute.')
  if (current.status !== 'proposed' && current.status !== 'cancelled') throw new SweepError(`Sweep is already ${current.status}`)
  const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send()
  if (lastValidBlockHeight < height || lastValidBlockHeight > height + 400n) {
    throw new SweepError('Blockhash is stale or invalid; refresh and try again')
  }
  const [row] = await sql<SweepRow[]>`
    update sweeps set status = 'signing', signing_valid_until = ${lastValidBlockHeight.toString()}, error = null
    where id = ${id} and merchant_id = ${merchant.id} and status in ('proposed', 'cancelled') returning *`
  if (!row) throw new SweepError('Sweep changed meanwhile; try again')
  return row
}

/**
 * The app reports the signature straight after the wallet signs and sends. From here the sweep is
 * 'submitted' and can't be signed again until the chain shows this transaction can't land.
 * A cancelled sweep is accepted too: the owner may have signed it just as a new proposal replaced it.
 */
export async function submitSweep(merchant: MerchantRow, id: string, signature: Signature): Promise<SweepRow> {
  const [usedElsewhere] = await sql`select 1 from sweeps where signature = ${signature} and id <> ${id}`
  if (usedElsewhere) throw new SweepError('That transaction already belongs to another sweep')
  const [row] = await sql<SweepRow[]>`
    update sweeps set status = 'submitted', signature = ${signature}, submitted_at = now(), error = null
    where id = ${id} and merchant_id = ${merchant.id} and status in ('proposed', 'signing', 'cancelled') returning *`
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
 * - submitted → confirmed when its transaction verifies; back to proposed only if the chain shows it
 *   failed, never landed, or isn't this sweep; 'failed' (not signable) if it landed but doesn't add up.
 * - proposed/cancelled → confirmed if the till already sent this sweep (its memo is onchain), e.g. the
 *   wallet sent it but the app lost the signature.
 */
export async function settleSweep(merchant: MerchantRow, sweep: SweepRow): Promise<SweepRow> {
  if (sweep.status === 'submitted' && sweep.signature) {
    const signature = sweep.signature as Signature
    const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const status = value[0]
    if (status?.err) return revertToProposed(sweep, 'The sweep transaction failed onchain; nothing moved')
    const landed = status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    if (landed) {
      const check = await checkSweepTransaction(merchant, sweep, signature)
      if (check.kind === 'ok') return markConfirmed(sweep, signature)
      if (check.kind === 'retry') return sweep
      if (check.kind === 'not-this-sweep') return revertToProposed(sweep, check.reason)
      return markFailed(sweep, check.reason)
    }
    const age = Date.now() - (sweep.submittedAt?.getTime() ?? 0)
    if (!status && age > SUBMIT_EXPIRY_MS) return revertToProposed(sweep, 'The sweep never reached the chain; nothing moved')
    return sweep
  }

  if (sweep.status === 'proposed' || sweep.status === 'cancelled' || sweep.status === 'signing') {
    const token = config.tokens[sweep.tokenSymbol]
    const [till] = await findAssociatedTokenPda({ owner: address(merchant.wallet), mint: token.mint, tokenProgram: token.tokenProgram })
    const since = BigInt(Math.floor(sweep.createdAt.getTime() / 1000) - 60)
    const recent = await rpc.getSignaturesForAddress(till, { limit: 100, commitment: 'confirmed' }).send()
    for (const s of recent) {
      if (s.err || s.blockTime === null || s.blockTime < since) continue
      // Only a transaction carrying this sweep's memo counts, never a look-alike transfer.
      if (!s.memo?.includes(sweepMemo(sweep.id))) continue
      if ((await checkSweepTransaction(merchant, sweep, s.signature)).kind === 'ok') return markConfirmed(sweep, s.signature)
    }
    if (sweep.status === 'signing') {
      // Once the blockhash has expired (plus a margin for confirmation), a transaction that isn't
      // onchain by now never will be: safe to sign again.
      const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send()
      if (sweep.signingValidUntil !== null && height > sweep.signingValidUntil + 32n) {
        const [row] = await sql<SweepRow[]>`
          update sweeps set status = 'proposed', signing_valid_until = null,
            error = 'The wallet did not send it; nothing moved'
          where id = ${sweep.id} and status = 'signing' returning *`
        return row ?? sweep
      }
    }
  }
  return sweep
}

async function markConfirmed(sweep: SweepRow, signature: Signature): Promise<SweepRow> {
  const [row] = await sql<SweepRow[]>`
    update sweeps set status = 'confirmed', signature = ${signature}, error = null, signing_valid_until = null
    where id = ${sweep.id} and status in ('proposed', 'signing', 'submitted', 'cancelled') returning *`
  return row ?? (await sql<SweepRow[]>`select * from sweeps where id = ${sweep.id}`)[0]!
}

async function markFailed(sweep: SweepRow, error: string): Promise<SweepRow> {
  console.error(`Sweep ${sweep.id} needs attention: ${error}`)
  const [row] = await sql<SweepRow[]>`
    update sweeps set status = 'failed', error = ${error} where id = ${sweep.id} and status = 'submitted' returning *`
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
    /** What the owner receives, and Tilltide's fee, both shown on the confirm card. */
    toOwner: fromBaseUnits(s.amount - s.feeAmount, token.decimals),
    feeAmount: s.feeAmount.toString(),
    feeDisplay: fromBaseUnits(s.feeAmount, token.decimals),
    feeWallet: s.feeWallet,
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
