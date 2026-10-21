import { address } from '@solana/kit'
import { findSignatureByReference, verifyPayment } from '@tilltide/agent-pay-kit'
import { config } from '../config'
import { sql, type MerchantRow, type PaymentRow } from '../db'
import { rpc } from '../solana'
import { issuePointsForPayment, markPaymentResult } from './payments'

/** Checks one pending payment against the chain. Returns true if its status changed. */
export async function checkPayment(payment: PaymentRow, merchant: MerchantRow): Promise<boolean> {
  if (payment.status !== 'pending') return false
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

async function tick() {
  await sql`
    update payments set status = 'expired'
    where status = 'pending' and created_at < now() - ${`${config.paymentTtlMs / 1000} seconds`}::interval`

  const pending = await sql<PaymentRow[]>`select * from payments where status = 'pending'`
  if (pending.length === 0) return
  const merchantIds = [...new Set(pending.map((p) => p.merchantId))]
  const merchants = await sql<MerchantRow[]>`select * from merchants where id in ${sql(merchantIds)}`
  const byId = new Map(merchants.map((m) => [m.id, m]))
  for (const payment of pending) {
    await checkPayment(payment, byId.get(payment.merchantId)!).catch((err) =>
      console.error(`Checking payment ${payment.id} failed`, err),
    )
  }
}

/** Polls the chain for pending payments. Swap for a webhook provider later. */
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
