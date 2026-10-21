/**
 * Loyalty for PayPal customers. They have no wallet to hold onchain points, so their points live in
 * Tilltide's ledger, per shop, keyed by their PayPal payer id. Their receipt shows a loyalty code; at
 * the next visit the till takes the code and knocks points off the PayPal bill.
 */
import { randomInt } from 'node:crypto'
import { planRedemption } from '@tilltide/agent-pay-kit'
import { sql, type MerchantRow } from '../db'

// No 0/O/1/I/L: easy to read out at a till.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function newCode(): string {
  let code = ''
  for (let i = 0; i < 10; i++) code += ALPHABET[randomInt(ALPHABET.length)]
  return `${code.slice(0, 5)}-${code.slice(5)}`
}

export function normaliseCode(input: string): string | null {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (clean.length !== 10 || [...clean].some((ch) => !ALPHABET.includes(ch))) return null
  return `${clean.slice(0, 5)}-${clean.slice(5)}`
}

/** The customer's code at this shop, created the first time it's needed. */
export async function codeFor(merchantId: string, payerKey: string): Promise<string> {
  const [existing] = await sql<{ code: string }[]>`
    select code from loyalty_codes where merchant_id = ${merchantId} and payer_key = ${payerKey}`
  if (existing) return existing.code
  for (let attempt = 0; attempt < 5; attempt++) {
    const [row] = await sql<{ code: string }[]>`
      insert into loyalty_codes (code, merchant_id, payer_key) values (${newCode()}, ${merchantId}, ${payerKey})
      on conflict do nothing returning code`
    if (row) return row.code
    const [raced] = await sql<{ code: string }[]>`
      select code from loyalty_codes where merchant_id = ${merchantId} and payer_key = ${payerKey}`
    if (raced) return raced.code
  }
  throw new Error('Could not create a loyalty code')
}

export async function payerForCode(merchantId: string, code: string): Promise<string | null> {
  const normal = normaliseCode(code)
  if (!normal) return null
  const [row] = await sql<{ payerKey: string }[]>`
    select payer_key from loyalty_codes where merchant_id = ${merchantId} and code = ${normal}`
  return row?.payerKey ?? null
}

/**
 * Points balance in the ledger: earned on paid sales, minus points spent on paid sales and points held
 * by open (pending) sales, so the same points can't be spent twice at once.
 */
export async function ledgerBalance(merchantId: string, payerKey: string, tx = sql): Promise<bigint> {
  const [row] = await tx<{ balance: bigint }[]>`
    select
      coalesce((select sum(points) from payments
        where merchant_id = ${merchantId} and payer = ${payerKey} and status = 'paid' and points_status = 'issued'), 0)
      - coalesce((select sum(points_redeemed) from payments
        where merchant_id = ${merchantId} and loyalty_key = ${payerKey} and status in ('pending', 'paid')), 0)
      as balance`
  return BigInt(row?.balance ?? 0)
}

/**
 * How many of a PayPal customer's points to spend on a bill. PayPal charges whole cents, so the discount
 * is trimmed until it's a whole number of cents.
 */
export function planPayPalRedemption(price: bigint, balance: bigint, merchant: MerchantRow) {
  const plan = planRedemption(price, balance, { pointValue: merchant.pointValue, maxPercent: merchant.redeemMaxPercent })
  let points = plan.points
  while (points > 0n && (points * merchant.pointValue) % 10_000n !== 0n) points--
  const discount = points * merchant.pointValue
  return { points, discount, toPay: price - discount }
}
