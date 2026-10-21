import { randomBytes } from 'node:crypto'
import { fromBaseUnits } from '@tilltide/agent-pay-kit'
import { verifySiwsMessage } from '../auth'
import { config } from '../config'
import { LEDGER_DECIMALS, sql, type MerchantRow, type PaymentRow, type RefundRow } from '../db'
import { PayPalError } from '../paypal'
import { getPayPal } from './payments'

export class RefundError extends Error {}

/**
 * Records a refund proposal. Nothing is refunded until the owner approves it with their wallet.
 * Runs in a transaction holding the payment row, so parallel proposals can't each claim the remainder.
 */
export async function proposeRefund(merchant: MerchantRow, paymentId: string, amount: bigint | null, reason: string | null) {
  return sql.begin(async (tx) => {
    const [payment] = await tx<PaymentRow[]>`
      select * from payments where id = ${paymentId} and merchant_id = ${merchant.id} for update`
    if (!payment) throw new RefundError('Payment not found for this shop')
    if (payment.rail !== 'paypal') {
      throw new RefundError('Only PayPal payments can be refunded here. Solana payments are refunded by sending tokens back from the till wallet.')
    }
    if (payment.status !== 'paid' || !payment.paypalCaptureId) throw new RefundError(`Payment is ${payment.status}; only paid payments can be refunded`)

    // One open proposal per payment keeps approvals unambiguous.
    await tx`update refunds set status = 'cancelled', approval_nonce = null where payment_id = ${payment.id} and status = 'proposed'`
    const [sums] = await tx<{ committed: bigint }[]>`
      select coalesce(sum(amount), 0)::bigint as committed from refunds
      where payment_id = ${payment.id} and status in ('processing', 'pending', 'completed')`
    // Only the cash part can go back through PayPal; points spent on the sale aren't cash.
    const remaining = payment.amount - payment.discount - sums!.committed
    const refundAmount = amount ?? remaining
    if (refundAmount <= 0n) throw new RefundError('This payment has already been fully refunded')
    if (refundAmount > remaining) {
      throw new RefundError(`Only ${fromBaseUnits(remaining, LEDGER_DECIMALS)} ${payment.currency} of this payment can still be refunded`)
    }
    if (refundAmount % 10_000n !== 0n) throw new RefundError('PayPal refunds must be in whole cents')

    const [row] = await tx<RefundRow[]>`
      insert into refunds (merchant_id, payment_id, amount, currency, reason)
      values (${merchant.id}, ${payment.id}, ${refundAmount.toString()}, ${payment.currency}, ${reason}) returning *`
    return row!
  })
}

export async function getRefund(merchant: MerchantRow, id: string): Promise<RefundRow | null> {
  const [row] = await sql<RefundRow[]>`select * from refunds where id = ${id} and merchant_id = ${merchant.id}`
  return row ?? null
}

/** The exact sentence the owner signs to approve a refund. */
export function approvalStatement(refund: RefundRow, payment: Pick<PaymentRow, 'label'>): string {
  const amount = Number(fromBaseUnits(refund.amount, LEDGER_DECIMALS)).toFixed(2)
  const what = payment.label ? ` for "${payment.label.replace(/["\n\r]/g, '')}"` : ''
  return `Approve a PayPal refund of ${amount} ${refund.currency}${what}. Refund ${refund.id}.`
}

/** A fresh single-use challenge for the owner's wallet to sign (Sign In With Solana format). */
export async function refundChallenge(merchant: MerchantRow, refund: RefundRow) {
  if (refund.status !== 'proposed') throw new RefundError(`Refund is ${refund.status}`)
  const nonce = randomBytes(16).toString('hex')
  await sql`update refunds set approval_nonce = ${nonce} where id = ${refund.id} and status = 'proposed'`
  const [payment] = await sql<PaymentRow[]>`select label from payments where id = ${refund.paymentId}`
  return { nonce, domain: config.authDomain, statement: approvalStatement(refund, payment!) }
}

/**
 * Approves and executes a refund. The owner's wallet must have signed this refund's statement and
 * nonce, so a stolen session alone can't move money. PayPal is called with an idempotency key, so a
 * retry after a network error can never refund twice.
 */
export async function approveRefund(
  merchant: MerchantRow,
  refund: RefundRow,
  signed: { signedMessage: Uint8Array; signature: Uint8Array } | null,
): Promise<RefundRow> {
  if (refund.status === 'proposed') {
    if (!signed) throw new RefundError('Approve this refund with your wallet')
    const { wallet, message, nonce } = await verifySiwsMessage({ address: merchant.wallet, ...signed }).catch((e) => {
      throw new RefundError(e instanceof Error ? e.message : String(e))
    })
    if (wallet !== merchant.wallet) throw new RefundError('Only the till wallet can approve refunds')
    const [payment] = await sql<PaymentRow[]>`select label from payments where id = ${refund.paymentId}`
    if (!message.includes(`\n\n${approvalStatement(refund, payment!)}\n`)) throw new RefundError('That signature is for a different refund')
    const claimed = await sql.begin(async (tx) => {
      const [p] = await tx<PaymentRow[]>`select * from payments where id = ${refund.paymentId} for update`
      const [sums] = await tx<{ committed: bigint }[]>`
        select coalesce(sum(amount), 0)::bigint as committed from refunds
        where payment_id = ${refund.paymentId} and status in ('processing', 'pending', 'completed')`
      if (sums!.committed + refund.amount > p!.amount - p!.discount) throw new RefundError('That would refund more than the customer paid')
      const [row] = await tx<RefundRow[]>`
        update refunds set status = 'processing', approval_nonce = null, approved_at = now()
        where id = ${refund.id} and status = 'proposed' and approval_nonce = ${nonce} returning *`
      return row
    })
    if (!claimed) throw new RefundError('That approval has expired or was already used; try again')
    refund = claimed
  } else if (refund.status !== 'processing') {
    // Already decided; nothing to do.
    return refund
  }
  return executeRefund(refund)
}

/** After this many PayPal attempts, stop retrying automatically and leave it for a human. */
const MAX_ATTEMPTS = 10

/**
 * Sends (or re-sends, idempotently) a 'processing' refund to PayPal and records the outcome.
 *
 * Money safety:
 * - A lease means only one caller (a request or the watcher) talks to PayPal for a refund at a time.
 * - Every call uses the same PayPal-Request-Id, so PayPal returns the original refund on a retry.
 * - A 4xx is only taken as "nothing moved" on the very first call to the refund endpoint. On a
 *   retry the first call may have gone through with its response lost, so it stays 'processing'.
 */
export async function executeRefund(refund: RefundRow): Promise<RefundRow> {
  const paypal = getPayPal()
  if (!paypal) throw new RefundError('PayPal is not configured on the server')
  const [leased] = await sql<RefundRow[]>`
    update refunds set executing_until = now() + interval '60 seconds', paypal_attempts = paypal_attempts + 1
    where id = ${refund.id} and status = 'processing' and paypal_attempts < ${MAX_ATTEMPTS}
      and (executing_until is null or executing_until < now())
    returning *`
  if (!leased) return (await sql<RefundRow[]>`select * from refunds where id = ${refund.id}`)[0]!
  const [payment] = await sql<PaymentRow[]>`select * from payments where id = ${refund.paymentId}`

  const finish = async (fields: { status?: string; error: string | null; paypalRefundId?: string }) => {
    const [row] = await sql<RefundRow[]>`
      update refunds set
        status = ${fields.status ?? 'processing'},
        paypal_refund_id = coalesce(${fields.paypalRefundId ?? null}, paypal_refund_id),
        error = ${fields.error}, executing_until = null
      where id = ${refund.id} and status = 'processing' returning *`
    return row ?? (await sql<RefundRow[]>`select * from refunds where id = ${refund.id}`)[0]!
  }

  try {
    const result = await paypal.refundCapture(
      payment!.paypalCaptureId!,
      { value: Number(fromBaseUnits(refund.amount, LEDGER_DECIMALS)).toFixed(2), currency: refund.currency },
      `refund-${refund.id}`,
      refund.reason ?? undefined,
      // A connected shop's sale is refunded on its behalf, from its PayPal.
      (await sql<MerchantRow[]>`select * from merchants where id = ${refund.merchantId}`)[0]?.paypalMerchantId ?? undefined,
    )
    if (result.status === 'COMPLETED') return finish({ status: 'completed', error: null, paypalRefundId: result.id })
    if (result.status === 'PENDING') return finish({ status: 'pending', error: null, paypalRefundId: result.id })
    return finish({ status: 'failed', error: `PayPal says ${result.status.toLowerCase()}`, paypalRefundId: result.id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const definitiveRefusal =
      err instanceof PayPalError && err.stage === 'api' && err.status >= 400 && err.status < 500 && err.status !== 429 && leased.paypalAttempts === 1
    if (definitiveRefusal) return finish({ status: 'failed', error: `PayPal: ${message}` })
    // Outage, auth problem, or a 4xx on a retry: it may or may not have gone through. Stay 'processing';
    // the next attempt reuses the same request id, so PayPal can't refund twice.
    const giveUp = leased.paypalAttempts >= MAX_ATTEMPTS
    return finish({ error: giveUp ? `Needs checking in PayPal (stopped after ${MAX_ATTEMPTS} attempts): ${message}` : message })
  }
}

export function serializeRefund(r: RefundRow) {
  return {
    id: r.id,
    paymentId: r.paymentId,
    amount: r.amount.toString(),
    display: Number(fromBaseUnits(r.amount, LEDGER_DECIMALS)).toFixed(2),
    currency: r.currency,
    reason: r.reason,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  }
}
