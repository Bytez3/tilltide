import { address } from '@solana/kit'
import { findSignatureByReference, verifyPayment } from '@tilltide/agent-pay-kit'
import { config } from '../config'
import { sql, type MerchantRow, type PaymentRow } from '../db'
import { rpc } from '../solana'
import { checkPayPalPayment, issuePointsForPayment, markPaymentResult } from './payments'

/** Checks one pending (or recently expired) payment against its rail. Returns true if its status changed. */
export async function checkPayment(payment: PaymentRow, merchant: MerchantRow): Promise<boolean> {
  if (payment.rail === 'paypal') return checkPayPalPayment(payment)
  if (payment.status !== 'pending' && payment.status !== 'expired') return false
  if (!payment.reference || payment.tokenSymbol === 'USD') return false

  const signature = await findSignatureByReference(rpc, address(payment.reference))
  if (!signature) return false

  const result = await verifyPayment(rpc, signature, {
    recipient: address(merchant.wallet),
    token: config.tokens[payment.tokenSymbol],
    amount: payment.amount,
  })
  await markPaymentResult(payment, result)
  if (result.ok) {
    const points = await issuePointsForPayment(payment.id)
    if (!points.issued) console.warn(`Points not issued for ${payment.id}: ${points.reason}`)
  }
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
  await sql`
    update payments set status = 'expired'
    where status = 'pending' and created_at < now() - ${ttl}::interval`

  if (ticks % 20 === 0) {
    // About once a minute: catch customers who paid an expired Solana request (the money still arrived).
    await checkAll(await sql<PaymentRow[]>`
      select * from payments where rail = 'solana' and status = 'expired' and created_at > now() - interval '24 hours'`)

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
