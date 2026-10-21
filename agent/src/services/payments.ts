import { address, generateKeyPairSigner, type Address } from '@solana/kit'
import { calculatePoints, encodeTransferRequest, getIssuePointsInstructions, type VerifiedPayment } from '@tilltide/agent-pay-kit'
import { config } from '../config'
import { sql, type MerchantRow, type PaymentRow } from '../db'
import { getPointsAuthority, sendAndConfirm } from '../solana'
import { merchantToken } from './merchants'

export async function createPayment(merchant: MerchantRow, amount: bigint, label?: string) {
  // A fresh keypair's address is a guaranteed-unique reference; the private half is thrown away.
  const reference = (await generateKeyPairSigner()).address
  const token = merchantToken(merchant)
  const [payment] = await sql<PaymentRow[]>`
    insert into payments (merchant_id, reference, amount, token_symbol, label)
    values (${merchant.id}, ${reference}, ${amount.toString()}, ${token.symbol}, ${label ?? null})
    returning *`
  const url = encodeTransferRequest({
    recipient: address(merchant.wallet),
    amount,
    token,
    reference,
    label: merchant.name,
    message: label,
  })
  return { payment: payment!, url }
}

export async function getPayment(id: string): Promise<PaymentRow | null> {
  const [row] = await sql<PaymentRow[]>`select * from payments where id = ${id}`
  return row ?? null
}

export async function markPaymentResult(payment: PaymentRow, result: VerifiedPayment) {
  if (!result.ok) {
    await sql`
      update payments set status = 'failed', signature = ${result.signature}, failure_reason = ${result.reason}
      where id = ${payment.id} and status = 'pending'`
    return
  }
  await sql`
    update payments set status = 'paid', signature = ${result.signature}, payer = ${result.payer}, paid_at = now()
    where id = ${payment.id} and status = 'pending'`
}

export type IssuePointsResult =
  | { issued: true; points: bigint; signature: string | null }
  | { issued: false; reason: string }

/** Mints loyalty points to the payer of a paid payment. Safe to call twice: it won't issue again. */
export async function issuePointsForPayment(paymentId: string): Promise<IssuePointsResult> {
  const payment = await getPayment(paymentId)
  if (!payment) return { issued: false, reason: 'Payment not found' }
  if (payment.status !== 'paid') return { issued: false, reason: `Payment is ${payment.status}, not paid` }
  if (payment.pointsSignature) return { issued: false, reason: 'Points were already issued for this payment' }
  if (!payment.payer) return { issued: false, reason: 'Payer wallet is unknown' }

  const [merchant] = await sql<MerchantRow[]>`select * from merchants where id = ${payment.merchantId}`
  const token = config.tokens[payment.tokenSymbol]
  const points = calculatePoints(payment.amount, token.decimals, {
    pointsPerUnit: Number(merchant!.pointsPerUnit),
    bonusMultiplier: Number(merchant!.bonusMultiplier),
  })
  if (points === 0n) {
    await sql`update payments set points = 0, points_signature = 'none' where id = ${payment.id}`
    return { issued: true, points: 0n, signature: null }
  }

  const authorityPromise = getPointsAuthority()
  if (!authorityPromise || !config.pointsMint) return { issued: false, reason: 'Points mint is not configured' }
  const authority = await authorityPromise

  // Claim the row first so two workers can't mint for the same payment.
  const claimed = await sql`
    update payments set points = ${points.toString()}, points_signature = 'pending'
    where id = ${payment.id} and points_signature is null returning id`
  if (claimed.length === 0) return { issued: false, reason: 'Points are already being issued' }

  try {
    const instructions = await getIssuePointsInstructions({
      payer: authority,
      mintAuthority: authority,
      pointsMint: config.pointsMint,
      customer: payment.payer as Address,
      points,
    })
    const signature = await sendAndConfirm(authority, instructions)
    await sql`update payments set points_signature = ${signature} where id = ${payment.id}`
    return { issued: true, points, signature }
  } catch (err) {
    await sql`update payments set points = null, points_signature = null where id = ${payment.id}`
    return { issued: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export function serializePayment(p: PaymentRow) {
  const token = config.tokens[p.tokenSymbol]
  return {
    id: p.id,
    rail: p.rail,
    reference: p.reference,
    amount: p.amount.toString(),
    decimals: token.decimals,
    token: p.tokenSymbol,
    label: p.label,
    status: p.status,
    signature: p.signature,
    payer: p.payer,
    failureReason: p.failureReason,
    points: p.points?.toString() ?? null,
    pointsIssued: Boolean(p.pointsSignature && p.pointsSignature !== 'pending'),
    createdAt: p.createdAt.toISOString(),
    paidAt: p.paidAt?.toISOString() ?? null,
  }
}
