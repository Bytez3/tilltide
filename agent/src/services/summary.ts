import { fromBaseUnits } from '@tilltide/agent-pay-kit'
import { address, type Signature } from '@solana/kit'
import { findAssociatedTokenPda } from '@solana-program/token'
import { config } from '../config'
import { sql, type MerchantRow, type PaymentRow } from '../db'
import { rpc } from '../solana'
import { merchantToken } from './merchants'
import { tillBalance } from './sweeps'

export async function getPaymentsForDay(merchant: MerchantRow, date: string): Promise<PaymentRow[]> {
  return sql<PaymentRow[]>`
    select * from payments
    where merchant_id = ${merchant.id}
      and created_at >= (${date}::date::timestamp at time zone ${merchant.timezone})
      and created_at < ((${date}::date + 1)::timestamp at time zone ${merchant.timezone})
    order by created_at`
}

export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
}

export async function getDailySummary(merchant: MerchantRow, date: string) {
  const token = merchantToken(merchant)
  const payments = await getPaymentsForDay(merchant, date)
  const paid = payments.filter((p) => p.status === 'paid')
  // Cash actually received: on points sales, the part covered by points never reached the till.
  const cash = (p: PaymentRow) => p.amount - p.discount
  const total = paid.reduce((sum, p) => sum + cash(p), 0n)

  const byCustomer = new Map<string, { total: bigint; visits: number }>()
  for (const p of paid) {
    if (!p.payer) continue
    const c = byCustomer.get(p.payer) ?? { total: 0n, visits: 0 }
    c.total += cash(p)
    c.visits += 1
    byCustomer.set(p.payer, c)
  }
  const topCustomers = [...byCustomer.entries()]
    .sort((a, b) => (b[1].total > a[1].total ? 1 : b[1].total < a[1].total ? -1 : 0))
    .slice(0, 5)
    .map(([wallet, c]) => ({ wallet, total: fromBaseUnits(c.total, token.decimals), visits: c.visits }))

  const [refunded] = await sql<{ total: bigint | null; count: number }[]>`
    select sum(amount)::bigint as total, count(*)::int as count from refunds
    where merchant_id = ${merchant.id} and status in ('pending', 'completed')
      and approved_at >= (${date}::date::timestamp at time zone ${merchant.timezone})
      and approved_at < ((${date}::date + 1)::timestamp at time zone ${merchant.timezone})`
  const refundsTotal = refunded?.total ?? 0n

  return {
    date,
    timezone: merchant.timezone,
    // Prices are in the shop's currency on every rail (wallet sales are converted at the time of sale).
    token: merchant.currency,
    takings: fromBaseUnits(total, token.decimals),
    refunds: { count: refunded?.count ?? 0, total: fromBaseUnits(refundsTotal, token.decimals) },
    netTakings: fromBaseUnits(total - refundsTotal, token.decimals),
    paidCount: paid.length,
    averageSale: paid.length ? fromBaseUnits(total / BigInt(paid.length), token.decimals) : '0',
    uniqueCustomers: byCustomer.size,
    topCustomers,
    pointsRedeemed: paid.reduce((sum, p) => sum + p.pointsRedeemed, 0n).toString(),
    pointsDiscount: fromBaseUnits(paid.reduce((sum, p) => sum + p.discount, 0n), token.decimals),
    pointsIssued: paid.filter((p) => p.pointsStatus === 'issued').reduce((sum, p) => sum + (p.points ?? 0n), 0n).toString(),
    byRail: {
      solana: fromBaseUnits(paid.filter((p) => p.rail === 'solana').reduce((s, p) => s + cash(p), 0n), token.decimals),
      paypal: fromBaseUnits(paid.filter((p) => p.rail === 'paypal').reduce((s, p) => s + p.amount, 0n), token.decimals),
    },
    paymentsMissingPoints: paid.filter((p) => p.rail === 'solana' && p.pointsStatus !== 'issued' && p.pointsStatus !== 'none').map((p) => p.id),
    failed: payments.filter((p) => p.status === 'failed').map((p) => ({ id: p.id, reason: p.failureReason })),
    expiredRequests: payments.filter((p) => p.status === 'expired').length,
    stillPending: payments.filter((p) => p.status === 'pending').length,
  }
}

/**
 * Reconciliation: compares what the ledger says against what the chain says.
 * Finds transfers into the till that no payment request accounts for, and the current till balance.
 */
export async function reconcileDay(merchant: MerchantRow, date: string) {
  const token = merchantToken(merchant)
  const payments = await getPaymentsForDay(merchant, date)
  const paypalPaid = payments.filter((p) => p.rail === 'paypal' && p.status === 'paid')

  const [tillAccount] = await findAssociatedTokenPda({
    owner: address(merchant.wallet),
    mint: token.mint,
    tokenProgram: token.tokenProgram,
  })

  const balance = await tillBalance(merchant)

  // Day bounds from Postgres, so days when the clocks change (23 or 25 hours) are right.
  const [bounds] = await sql<{ start: Date; end: Date }[]>`
    select (${date}::date::timestamp at time zone ${merchant.timezone}) as start,
           ((${date}::date + 1)::timestamp at time zone ${merchant.timezone}) as end`
  const startSec = BigInt(Math.floor(bounds!.start.getTime() / 1000))
  const endSec = BigInt(Math.floor(bounds!.end.getTime() / 1000))

  // Page back through the till's history until we pass the start of the day.
  type SigInfo = { signature: Signature; err: unknown; blockTime: bigint | null }
  const dayActivity: SigInfo[] = []
  let before: Signature | undefined
  for (let page = 0; page < 10; page++) {
    const batch = await rpc
      .getSignaturesForAddress(tillAccount, { limit: 1000, before, commitment: 'confirmed' })
      .send()
    for (const s of batch) {
      if (s.blockTime !== null && s.blockTime >= startSec && s.blockTime < endSec) dayActivity.push(s)
    }
    const last = batch.at(-1)
    if (!last || batch.length < 1000 || (last.blockTime !== null && last.blockTime < startSec)) break
    before = last.signature
  }
  // Money the ledger accounts for, whichever day the request was created (a sale at 23:58 paid at 00:01,
  // a late payment, a sweep signed the day after it was proposed). Underpaid transfers aren't 'paid', so
  // they still show as unmatched.
  const daySigs = dayActivity.map((s) => s.signature as string)
  const known = new Set<string>()
  let sweptToday = 0n
  if (daySigs.length) {
    const rows = await sql<{ signature: string; sweptAmount: bigint | null }[]>`
      select signature, null::bigint as swept_amount from payments
        where merchant_id = ${merchant.id} and status = 'paid' and signature = any(${daySigs})
      union all
      select signature, amount as swept_amount from sweeps
        where merchant_id = ${merchant.id} and status = 'confirmed' and signature = any(${daySigs})`
    for (const r of rows) {
      known.add(r.signature)
      if (r.sweptAmount !== null) sweptToday += r.sweptAmount
    }
  }
  const unmatched = dayActivity
    .filter((s) => s.err === null && !known.has(s.signature))
    .map((s) => ({ signature: s.signature, time: new Date(Number(s.blockTime) * 1000).toISOString() }))

  return {
    date,
    tillWallet: merchant.wallet,
    tillBalance: fromBaseUnits(BigInt(balance), token.decimals),
    token: token.symbol,
    ledgerPaidCount: payments.filter((p) => p.status === 'paid').length,
    // PayPal takings settle to the merchant's PayPal balance, not the till wallet.
    paypalTakings: fromBaseUnits(paypalPaid.reduce((s, p) => s + p.amount, 0n), token.decimals),
    paypalCaptures: paypalPaid.map((p) => p.paypalCaptureId),
    // Gross amount swept out of the till today (what the owner received plus Tilltide's fee).
    sweptOutToday: fromBaseUnits(sweptToday, token.decimals),
    // Transfers in or out of the till that Tilltide didn't create. The agent explains these.
    onchainActivityNotInLedger: unmatched,
    explorerCluster: config.cluster,
  }
}
