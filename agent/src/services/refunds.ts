import { randomBytes } from 'node:crypto'
import { fromBaseUnits } from '@tilltide/agent-pay-kit'
import { verifySiwsMessage } from '../auth'
import { config } from '../config'
import { LEDGER_DECIMALS, sql, type MerchantRow, type PaymentRow, type RefundRow } from '../db'
import { PayPalError } from '../paypal'
import { getPayPal } from './payments'

export class RefundError extends Error {}

/** Refunds that count against a payment: anything not cancelled or failed. */
async function refundedSoFar(paymentId: string): Promise<bigint> {
  const [row] = await sql<{ total: bigint | null }[]>`
    select sum(amount)::bigint as total from refunds
    where payment_id = ${paymentId} and status in ('proposed', 'processing', 'pending', 'completed')`
  return row?.total ?? 0n
}

/** Records a refund proposal. Nothing is refunded until the owner approves it with their wallet. */
export async function proposeRefund(merchant: MerchantRow, paymentId: string, amount: bigint | null, reason: string | null) {
  const [payment] = await sql<PaymentRow[]>`select * from payments where id = ${paymentId} and merchant_id = ${merchant.id}`
  if (!payment) throw new RefundError('Payment not found for this shop')
  if (payment.rail !== 'paypal') {
    throw new RefundError('Only PayPal payments can be refunded here. Solana payments are refunded by sending tokens back from the till wallet.')
  }
  if (payment.status !== 'paid' || !payment.paypalCaptureId) throw new RefundError(`Payment is ${payment.status}; only paid payments can be refunded`)
  const remaining = payment.amount - (await refundedSoFar(payment.id))
  const refundAmount = amount ?? remaining
  if (refundAmount <= 0n) throw new RefundError('This payment has already been fully refunded (or a refund is waiting for approval)')
  if (refundAmount > remaining) {
    throw new RefundError(`Only ${fromBaseUnits(remaining, LEDGER_DECIMALS)} USD of this payment can still be refunded`)
  }
  if (refundAmount % 10_000n !== 0n) throw new RefundError('PayPal refunds must be in whole cents')

  // One open proposal per payment keeps approvals unambiguous.
  await sql`update refunds set status = 'cancelled' where payment_id = ${payment.id} and status = 'proposed'`
  const [row] = await sql<RefundRow[]>`
    insert into refunds (merchant_id, payment_id, amount, reason)
    values (${merchant.id}, ${payment.id}, ${refundAmount.toString()}, ${reason}) returning *`
  return row!
}

export async function getRefund(merchant: MerchantRow, id: string): Promise<RefundRow | null> {
  const [row] = await sql<RefundRow[]>`select * from refunds where id = ${id} and merchant_id = ${merchant.id}`
  return row ?? null
}

/** The exact sentence the owner signs to approve a refund. */
export function approvalStatement(refund: RefundRow, payment: Pick<PaymentRow, 'label'>): string {
  const amount = Number(fromBaseUnits(refund.amount, LEDGER_DECIMALS)).toFixed(2)
  const what = payment.label ? ` for "${payment.label.replace(/["\n\r]/g, '')}"` : ''
  return `Approve a PayPal refund of ${amount} ${config.paypalCurrency}${what}. Refund ${refund.id}.`
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
    const [claimed] = await sql<RefundRow[]>`
      update refunds set status = 'processing', approval_nonce = null, approved_at = now()
      where id = ${refund.id} and status = 'proposed' and approval_nonce = ${nonce} returning *`
    if (!claimed) throw new RefundError('That approval has expired or was already used; try again')
    refund = claimed
  } else if (refund.status !== 'processing') {
    // Already decided; nothing to do.
    return refund
  }
  return executeRefund(refund)
}

/** Sends (or re-sends, idempotently) a 'processing' refund to PayPal and records the outcome. */
export async function executeRefund(refund: RefundRow): Promise<RefundRow> {
  const paypal = getPayPal()
  if (!paypal) throw new RefundError('PayPal is not configured on the server')
  const [payment] = await sql<PaymentRow[]>`select * from payments where id = ${refund.paymentId}`
  try {
    const result = await paypal.refundCapture(
      payment!.paypalCaptureId!,
      { value: Number(fromBaseUnits(refund.amount, LEDGER_DECIMALS)).toFixed(2), currency: config.paypalCurrency },
      `refund-${refund.id}`,
      refund.reason ?? undefined,
    )
    const status = result.status === 'COMPLETED' ? 'completed' : result.status === 'PENDING' ? 'pending' : 'failed'
    const [row] = await sql<RefundRow[]>`
      update refunds set status = ${status}, paypal_refund_id = ${result.id},
        error = ${status === 'failed' ? `PayPal says ${result.status.toLowerCase()}` : null}
      where id = ${refund.id} and status in ('processing', 'pending') returning *`
    return row ?? refund
  } catch (err) {
    if (err instanceof PayPalError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      // PayPal refused it outright (e.g. capture already fully refunded): nothing moved.
      const [row] = await sql<RefundRow[]>`
        update refunds set status = 'failed', error = ${`PayPal: ${err.message}`}
        where id = ${refund.id} and status = 'processing' returning *`
      return row ?? refund
    }
    // Network or PayPal outage: stays 'processing'; approving again retries with the same idempotency key.
    const [row] = await sql<RefundRow[]>`update refunds set error = ${String(err instanceof Error ? err.message : err)} where id = ${refund.id} returning *`
    return row ?? refund
  }
}

export function serializeRefund(r: RefundRow) {
  return {
    id: r.id,
    paymentId: r.paymentId,
    amount: r.amount.toString(),
    display: Number(fromBaseUnits(r.amount, LEDGER_DECIMALS)).toFixed(2),
    currency: config.paypalCurrency,
    reason: r.reason,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  }
}
