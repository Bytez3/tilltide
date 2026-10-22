import { createHash, randomBytes } from 'node:crypto'
import { fromBaseUnits } from '@tilltide/agent-pay-kit'
import { LEDGER_DECIMALS, sql, type MerchantRow, type PaymentRow, type RefundRow, type SweepRow } from '../db'

const hash = (t: string) => createHash('sha256').update(t).digest('hex')

/** A single-use download link token, valid for 5 minutes. */
const PAID_WITH: Partial<Record<PaymentRow['rail'], string>> = { paypal: 'PayPal', cash: 'Cash', card: 'Card reader' }

export async function createExportToken(merchant: MerchantRow, from: string, to: string) {
  const token = randomBytes(24).toString('base64url')
  await sql`
    insert into export_tokens (token_hash, merchant_id, from_day, to_day, expires_at)
    values (${hash(token)}, ${merchant.id}, ${from}, ${to}, now() + interval '5 minutes')`
  return token
}

export async function redeemExportToken(token: string) {
  const [row] = await sql<{ merchantId: string; fromDay: Date; toDay: Date }[]>`
    update export_tokens set used_at = now()
    where token_hash = ${hash(token)} and used_at is null and expires_at > now()
    returning merchant_id, from_day, to_day`
  return row ?? null
}

/**
 * One CSV cell. Quotes when needed, and defuses spreadsheet formulas: shop-typed text starting with
 * = + - @ (or a tab/CR) is prefixed with ' so Excel/Sheets show it as text instead of running it.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value)
  // Defuse spreadsheet formulas, but leave plain numbers (like -3.50 on a refund) as numbers.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const money = (units: bigint | null | undefined) => (units === null || units === undefined ? '' : Number(fromBaseUnits(units, LEDGER_DECIMALS)).toFixed(2))

/** Every sale, refund and sweep in the date range (shop's local days), oldest first. */
export async function exportCsv(merchant: MerchantRow, from: string, to: string): Promise<string> {
  const start = sql`(${from}::date::timestamp at time zone ${merchant.timezone})`
  const end = sql`((${to}::date + 1)::timestamp at time zone ${merchant.timezone})`
  const payments = await sql<PaymentRow[]>`
    select * from payments where merchant_id = ${merchant.id}
      and coalesce(paid_at, created_at) >= ${start} and coalesce(paid_at, created_at) < ${end} order by coalesce(paid_at, created_at)`
  const refunds = await sql<(RefundRow & { paymentLabel: string | null })[]>`
    select r.*, p.label as payment_label from refunds r join payments p on p.id = r.payment_id
    where r.merchant_id = ${merchant.id} and r.status in ('pending', 'completed')
      and r.approved_at >= ${start} and r.approved_at < ${end} order by r.approved_at`
  const sweeps = await sql<SweepRow[]>`
    select * from sweeps where merchant_id = ${merchant.id} and status = 'confirmed'
      and created_at >= ${start} and created_at < ${end} order by created_at`

  const when = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: merchant.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    return [`${get('year')}-${get('month')}-${get('day')}`, `${get('hour')}:${get('minute')}`]
  }

  const header = [
    'date', 'time', 'type', 'status', 'description', 'currency', 'price', 'points_discount', 'received',
    'paid_with', 'token_amount', 'fx_rate', 'customer', 'points_earned', 'points_spent', 'tilltide_fee', 'reference', 'id',
  ]
  const rows: unknown[][] = []
  for (const p of payments) {
    const [d, t] = when(p.paidAt ?? p.createdAt)
    const received = p.status === 'paid' ? p.amount - p.discount : null
    rows.push([
      d, t, 'sale', p.status, p.label, p.currency, money(p.amount), money(p.discount), money(received),
      PAID_WITH[p.rail] ?? p.tokenSymbol, money(p.tokenAmount), (Number(p.fxRate) / 1e6).toString(), p.payer,
      p.pointsStatus === 'issued' ? p.points?.toString() : '', p.pointsRedeemed.toString(), money(p.paypalFee),
      p.signature ?? p.paypalCaptureId ?? '', p.id,
    ])
  }
  for (const r of refunds) {
    const [d, t] = when(r.approvedAt ?? r.createdAt)
    rows.push([
      d, t, 'refund', r.status, r.reason ?? r.paymentLabel, r.currency, '', '', `-${money(r.amount)}`,
      'PayPal', '', '', '', '', '', '', r.paypalRefundId ?? '', r.id,
    ])
  }
  for (const s of sweeps) {
    const [d, t] = when(s.createdAt)
    rows.push([
      d, t, 'sweep to owner', s.status, s.reason, s.tokenSymbol, '', '', `-${money(s.amount)}`,
      s.tokenSymbol, money(s.amount - s.feeAmount), '', s.toWallet, '', '', money(s.feeAmount), s.signature ?? '', s.id,
    ])
  }
  rows.sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`))
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
