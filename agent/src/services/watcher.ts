import { address } from '@solana/kit'
import { findPayment } from '@tilltide/agent-pay-kit'
import { config } from '../config'
import { sql, type MerchantRow, type PaymentRow, type RefundRow } from '../db'
import { rpc } from '../solana'
import { checkPayPalPayment, getPayPal, issuePointsForPayment, markPaymentPaid, notePaymentProblem } from './payments'
import { executeRefund } from './refunds'

/** Per payment: reference transactions already known not to be a valid payment (see findPayment). */
const rejectedByPayment = new Map<string, Set<string>>()

/** Checks one open payment against its rail. Returns true if it became paid (or failed, for PayPal). */
export async function checkPayment(payment: PaymentRow, merchant: MerchantRow): Promise<boolean> {
  if (payment.rail === 'paypal') return checkPayPalPayment(payment)
  if (payment.status === 'paid') return false
  if (!payment.reference || payment.tokenSymbol === 'USD') return false

  let rejected = rejectedByPayment.get(payment.id)
  if (!rejected) rejectedByPayment.set(payment.id, (rejected = new Set()))
  const found = await findPayment(
    rpc,
    address(payment.reference),
    { recipient: address(merchant.wallet), token: config.tokens[payment.tokenSymbol], amount: payment.amount },
    rejected,
  )
  if (found.status === 'mismatch') {
    if (found.reason !== payment.failureReason) await notePaymentProblem(payment, found.reason)
    return false
  }
  if (found.status !== 'paid') return false
  rejectedByPayment.delete(payment.id)
  if (!(await markPaymentPaid(payment, found.payment))) return false

  // Points mint in the background so "Paid ✓" isn't held up by a second transaction.
  void issuePointsForPayment(payment.id)
    .then((points) => {
      if (!points.issued) console.warn(`Points not issued for ${payment.id}: ${points.reason}`)
    })
    .catch((err) => console.error(`Points for ${payment.id} failed`, err))
  return true
}

async function checkAll(payments: PaymentRow[]) {
  if (payments.length === 0) return
  const merchantIds = [...new Set(payments.map((p) => p.merchantId))]
  const merchants = await sql<MerchantRow[]>`select * from merchants where id in ${sql(merchantIds)}`
  const byId = new Map(merchants.map((m) => [m.id, m]))
  for (const payment of payments) {
    const merchant = byId.get(payment.merchantId)
    if (!merchant) continue
    await checkPayment(payment, merchant).catch((err) => console.error(`Checking payment ${payment.id} failed`, err))
  }
}

let ticks = 0

async function tick() {
  ticks++
  const ttl = `${config.paymentTtlMs / 1000} seconds`

  await checkAll(await sql<PaymentRow[]>`select * from payments where status = 'pending' order by created_at`)

  // Expire only after the final check above, so a payment that just landed isn't marked expired.
  // Requests where something bad arrived become 'failed' (with the reason) instead.
  // A PayPal capture under review is never expired; it's still settling.
  await sql`
    update payments set status = case when failure_reason is null then 'expired' else 'failed' end
    where status = 'pending' and created_at < now() - ${ttl}::interval
      and not (rail = 'paypal' and paypal_capture_id is not null)`

  if (ticks % 20 === 0) {
    // About once a minute: catch money that arrived after a request closed. Solana: the customer paid
    // late. PayPal: a capture finished just as the request expired (it is never captured after expiry).
    await checkAll(await sql<PaymentRow[]>`
      select * from payments
      where created_at > now() - interval '24 hours'
        and ((rail = 'solana' and status in ('expired', 'failed')) or (rail = 'paypal' and status = 'expired'))`)
    // Forget dust caches for requests that can no longer be paid.
    for (const id of rejectedByPayment.keys()) {
      const [row] = await sql`select 1 from payments where id = ${id} and created_at > now() - interval '24 hours' and status <> 'paid'`
      if (!row) rejectedByPayment.delete(id)
    }

    // PayPal refunds: retry ones interrupted mid-call (idempotent), and follow PENDING ones to the end.
    if (getPayPal()) {
      const open = await sql<RefundRow[]>`
        select * from refunds where status in ('processing', 'pending') and approved_at > now() - interval '30 days' limit 20`
      for (const refund of open) {
        try {
          if (refund.status === 'processing') await executeRefund(refund)
          else if (refund.paypalRefundId) {
            const r = await getPayPal()!.getRefund(refund.paypalRefundId)
            if (r.status !== 'PENDING') {
              await sql`update refunds set status = ${r.status === 'COMPLETED' ? 'completed' : 'failed'},
                error = ${r.status === 'COMPLETED' ? null : `PayPal says ${r.status.toLowerCase()}`}
                where id = ${refund.id} and status = 'pending'`
            }
          }
        } catch (err) {
          console.error(`Refund ${refund.id} follow-up failed`, err)
        }
      }
    }

    // Retry points that failed or never confirmed. issuePointsForPayment checks the chain before resending.
    if (!config.pointsMint || !config.pointsAuthoritySecret) return
    const owed = await sql<{ id: string }[]>`
      select id from payments
      where rail = 'solana' and status = 'paid' and paid_at > now() - interval '7 days'
        and (points_status is null or (points_status = 'sending' and points_claimed_at < now() - interval '3 minutes'))
      order by paid_at limit 10`
    for (const { id } of owed) {
      const result = await issuePointsForPayment(id).catch((err) => ({ issued: false, reason: String(err) }))
      if (!result.issued) console.warn(`Points retry for ${id}: ${result.reason}`)
    }
  }
}

/** Polls the chain (and PayPal) for pending payments. Swap the Solana side for a webhook provider later. */
export function startWatcher() {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await tick()
    } catch (err) {
      console.error('Watcher tick failed', err)
    } finally {
      running = false
    }
  }, config.watchIntervalMs)
  return () => clearInterval(timer)
}
