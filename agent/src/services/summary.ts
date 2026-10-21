import { fromBaseUnits } from '@tilltide/agent-pay-kit'
import { address } from '@solana/kit'
import { findAssociatedTokenPda } from '@solana-program/token'
import { config } from '../config'
import { sql, type MerchantRow, type PaymentRow } from '../db'
import { rpc } from '../solana'
import { merchantToken } from './merchants'

/** Start and end of a calendar day (YYYY-MM-DD) in the merchant's timezone, as a Postgres range. */
function dayBounds(date: string, timezone: string) {
  return sql`(${date}::date::timestamp at time zone ${timezone})`
}

export async function getPaymentsForDay(merchant: MerchantRow, date: string): Promise<PaymentRow[]> {
  const start = dayBounds(date, merchant.timezone)
  return sql<PaymentRow[]>`
    select * from payments
    where merchant_id = ${merchant.id}
      and created_at >= ${start} and created_at < ${start} + interval '1 day'
    order by created_at`
}

export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
}

export async function getDailySummary(merchant: MerchantRow, date: string) {
  const token = merchantToken(merchant)
  const payments = await getPaymentsForDay(merchant, date)
  const paid = payments.filter((p) => p.status === 'paid')
  const total = paid.reduce((sum, p) => sum + p.amount, 0n)

  const byCustomer = new Map<string, { total: bigint; visits: number }>()
  for (const p of paid) {
    if (!p.payer) continue
    const c = byCustomer.get(p.payer) ?? { total: 0n, visits: 0 }
    c.total += p.amount
    c.visits += 1
    byCustomer.set(p.payer, c)
  }
  const topCustomers = [...byCustomer.entries()]
    .sort((a, b) => (b[1].total > a[1].total ? 1 : b[1].total < a[1].total ? -1 : 0))
    .slice(0, 5)
    .map(([wallet, c]) => ({ wallet, total: fromBaseUnits(c.total, token.decimals), visits: c.visits }))

  return {
    date,
    timezone: merchant.timezone,
    token: token.symbol,
    takings: fromBaseUnits(total, token.decimals),
    paidCount: paid.length,
    averageSale: paid.length ? fromBaseUnits(total / BigInt(paid.length), token.decimals) : '0',
    uniqueCustomers: byCustomer.size,
    topCustomers,
    pointsIssued: paid.reduce((sum, p) => sum + (p.points ?? 0n), 0n).toString(),
    paymentsMissingPoints: paid.filter((p) => !p.pointsSignature).map((p) => p.id),
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
  const known = new Set(payments.map((p) => p.signature).filter(Boolean))

  const [tillAccount] = await findAssociatedTokenPda({
    owner: address(merchant.wallet),
    mint: token.mint,
    tokenProgram: token.tokenProgram,
  })

  const balance = await rpc
    .getTokenAccountBalance(tillAccount, { commitment: 'confirmed' })
    .send()
    .then((r) => r.value.amount)
    .catch(() => '0')

  const [startRow] = await sql<{ start: Date }[]>`select ${dayBounds(date, merchant.timezone)} as start`
  const startSec = BigInt(Math.floor(startRow!.start.getTime() / 1000))
  const endSec = startSec + 86_400n

  const sweeps = await sql<{ amount: bigint; signature: string | null }[]>`
    select amount, signature from sweeps where merchant_id = ${merchant.id} and status = 'confirmed'
      and created_at >= ${dayBounds(date, merchant.timezone)}
      and created_at < ${dayBounds(date, merchant.timezone)} + interval '1 day'`

  for (const sweep of sweeps) if (sweep.signature) known.add(sweep.signature)

  const sigs = await rpc.getSignaturesForAddress(tillAccount, { limit: 200, commitment: 'confirmed' }).send()
  const unmatched = sigs
    .filter((s) => s.err === null && s.blockTime !== null && s.blockTime >= startSec && s.blockTime < endSec)
    .filter((s) => !known.has(s.signature))
    .map((s) => ({ signature: s.signature, time: new Date(Number(s.blockTime) * 1000).toISOString() }))

  return {
    date,
    tillWallet: merchant.wallet,
    tillBalance: fromBaseUnits(BigInt(balance), token.decimals),
    token: token.symbol,
    ledgerPaidCount: payments.filter((p) => p.status === 'paid').length,
    sweptToOwnerToday: fromBaseUnits(
      sweeps.reduce((s, r) => s + r.amount, 0n),
      token.decimals,
    ),
    // Transfers in or out of the till that Tilltide didn't create. The agent explains these.
    onchainActivityNotInLedger: unmatched,
    explorerCluster: config.cluster,
  }
}
