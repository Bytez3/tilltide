import { address, generateKeyPairSigner, type Address, type Signature } from '@solana/kit'
import {
  calculatePoints,
  encodeTransactionRequest,
  encodeTransferRequest,
  fromBaseUnits,
  getIssuePointsInstructions,
  sweepFee,
  type VerifiedPayment,
} from '@tilltide/agent-pay-kit'
// SKR bonus (Seeker holders) arrives after Breakpoint; until then every customer earns the base rate.
import { config } from '../config'
import { LEDGER_DECIMALS, sql, type MerchantRow, type PaymentRow } from '../db'
import { approvalUrl, completedCapture, createPayPalClient, PayPalError, type PayPalClient } from '../paypal'
import { getPointsAuthority, rpc, sendAndConfirmWire, signTransaction } from '../solana'
import { ledgerBalance, payerForCode, planPayPalRedemption } from './paypal-loyalty'
import { paypalPayee } from './paypal-onboarding'
import { merchantToken } from './merchants'

export async function createPayment(merchant: MerchantRow, amount: bigint, label?: string, allowPoints = false) {
  // A fresh keypair's address is a guaranteed-unique reference; the private half is thrown away.
  const reference = (await generateKeyPairSigner()).address
  const token = merchantToken(merchant)
  const [payment] = await sql<PaymentRow[]>`
    insert into payments (merchant_id, reference, amount, token_symbol, label, allow_points)
    values (${merchant.id}, ${reference}, ${amount.toString()}, ${token.symbol}, ${label ?? null}, ${allowPoints})
    returning *`
  // With points on, the wallet fetches a transaction from us (Solana Pay transaction request) that also burns points.
  if (allowPoints) return { payment: payment!, url: encodeTransactionRequest(`${config.publicUrl}/pay/${payment!.id}`) }
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

let paypalClient: PayPalClient | null = null
export function getPayPal(): PayPalClient | null {
  if (!config.paypal) return null
  paypalClient ??= createPayPalClient(config.paypal)
  return paypalClient
}

/** PayPal checkout for customers without a crypto wallet. The QR opens PayPal's approval page. */
export class PayPalSaleError extends Error {}

/**
 * PayPal checkout. The sale goes to the shop's own PayPal (connected via onboarding, or a named PayPal
 * email), with Tilltide's platform fee when the shop is connected. With a loyalty code, the customer's
 * ledger points come off the bill and are held for this sale until it's paid or expires.
 */
export async function createPayPalPayment(merchant: MerchantRow, amount: bigint, label?: string, loyaltyCode?: string) {
  const paypal = getPayPal()
  if (!paypal) throw new PayPalSaleError('PayPal is not configured on the server')
  const { payee, feeAllowed } = paypalPayee(merchant)
  if (!payee && config.paypalPlatform.requireConnected) {
    throw new PayPalSaleError('Connect your PayPal in Settings before taking PayPal payments')
  }

  const payment = await sql.begin(async (tx) => {
    let redemption = { points: 0n, discount: 0n, toPay: amount }
    let loyaltyKey: string | null = null
    if (loyaltyCode) {
      loyaltyKey = await payerForCode(merchant.id, loyaltyCode)
      if (!loyaltyKey) throw new PayPalSaleError('That loyalty code is not recognised at this shop')
      // One sale at a time per customer, so the same points can't be held by two open sales.
      await tx`select pg_advisory_xact_lock(hashtext(${`${merchant.id}:${loyaltyKey}`}))`
      redemption = planPayPalRedemption(amount, await ledgerBalance(merchant.id, loyaltyKey, tx as never), merchant)
    }
    const fee =
      feeAllowed && config.paypalPlatform.partnerMerchantId && config.paypalPlatform.feeBps > 0
        ? (sweepFee(redemption.toPay, config.paypalPlatform.feeBps) / 10_000n) * 10_000n // whole cents
        : 0n
    const [row] = await tx<PaymentRow[]>`
      insert into payments (merchant_id, rail, amount, token_symbol, label, points_redeemed, discount, loyalty_key, paypal_fee)
      values (${merchant.id}, 'paypal', ${amount.toString()}, 'USD', ${label ?? null}, ${redemption.points.toString()},
        ${redemption.discount.toString()}, ${redemption.points > 0n ? loyaltyKey : null}, ${fee.toString()})
      returning *`
    return row!
  })

  const cents = (units: bigint) => Number(fromBaseUnits(units, LEDGER_DECIMALS)).toFixed(2)
  try {
    const order = await paypal.createOrder({
      referenceId: payment.id,
      value: cents(payment.amount - payment.discount),
      currency: config.paypalCurrency,
      description: payment.discount > 0n ? `${label ?? 'Sale'} (${payment.pointsRedeemed} points used)` : label,
      brandName: merchant.name,
      returnUrl: `${config.publicUrl}/paypal/return`,
      cancelUrl: `${config.publicUrl}/paypal/cancel`,
      payee,
      platformFee: payment.paypalFee > 0n ? { value: cents(payment.paypalFee), currency: config.paypalCurrency } : undefined,
    })
    const url = approvalUrl(order)
    if (!url) throw new Error('PayPal did not return an approval link')
    const [updated] = await sql<PaymentRow[]>`
      update payments set paypal_order_id = ${order.id} where id = ${payment.id} returning *`
    return { payment: updated!, url }
  } catch (err) {
    // Releases any held points too (failed sales don't count against the balance).
    await sql`update payments set status = 'failed', failure_reason = ${(err as Error).message} where id = ${payment.id}`
    throw err
  }
}

/** Captures an approved PayPal order and marks the payment paid. Returns true if the status changed. */
export async function checkPayPalPayment(payment: PaymentRow): Promise<boolean> {
  const paypal = getPayPal()
  if (!paypal || !payment.paypalOrderId) return false
  if (payment.status !== 'pending' && payment.status !== 'expired') return false
  let order = await paypal.getOrder(payment.paypalOrderId)
  // An expired request is never captured; but a capture that completed just before expiry still counts.
  if (order.status === 'APPROVED' && payment.status === 'pending') {
    try {
      order = await paypal.captureOrder(order.id)
    } catch (err) {
      // Another request (return page vs watcher) captured it first; read the result instead.
      if (!(err instanceof PayPalError && err.issue === 'ORDER_ALREADY_CAPTURED')) throw err
      order = await paypal.getOrder(order.id)
    }
  }
  const pendingCapture = order.purchase_units?.[0]?.payments?.captures?.[0]
  if (order.status === 'COMPLETED' && pendingCapture && pendingCapture.status === 'PENDING') {
    // Captured but PayPal is still reviewing it. Keep watching; don't let it expire.
    await sql`
      update payments set status = 'pending', paypal_capture_id = ${pendingCapture.id}, failure_reason = 'PayPal is reviewing this payment'
      where id = ${payment.id} and status in ('pending', 'expired')`
    return false
  }
  if (order.status === 'COMPLETED' && pendingCapture && pendingCapture.status !== 'COMPLETED') {
    await sql`
      update payments set status = 'failed', paypal_capture_id = ${pendingCapture.id},
        failure_reason = ${`PayPal capture ${pendingCapture.status.toLowerCase()}`}
      where id = ${payment.id} and status = 'pending'`
    return true
  }
  const capture = completedCapture(order)
  if (capture) {
    await sql`
      update payments set status = 'paid', paypal_capture_id = ${capture.id}, paid_at = now(), failure_reason = null,
        payer = ${order.payer?.payer_id ? `paypal:${order.payer.payer_id}` : null}
      where id = ${payment.id} and status in ('pending', 'expired')`
    await issuePointsForPayment(payment.id).catch((err) => console.error(`Ledger points for ${payment.id} failed`, err))
    return true
  }
  if (order.status === 'VOIDED') {
    await sql`update payments set status = 'failed', failure_reason = 'PayPal order was voided' where id = ${payment.id}`
    return true
  }
  return false
}

export async function getPayment(id: string): Promise<PaymentRow | null> {
  const [row] = await sql<PaymentRow[]>`select * from payments where id = ${id}`
  return row ?? null
}

/** Records a verified payment. Also accepts late payments that land after a request expired or failed. */
export async function markPaymentPaid(
  payment: PaymentRow,
  result: Extract<VerifiedPayment, { ok: true }>,
  redemption: { pointsRedeemed: bigint; discount: bigint } = { pointsRedeemed: 0n, discount: 0n },
) {
  const rows = await sql`
    update payments set status = 'paid', signature = ${result.signature}, payer = ${result.payer}, paid_at = now(),
      failure_reason = null, points_redeemed = ${redemption.pointsRedeemed.toString()}, discount = ${redemption.discount.toString()}
    where id = ${payment.id} and status in ('pending', 'expired', 'failed') returning id`
  return rows.length > 0
}

/** Something arrived with the reference but isn't a valid payment. Stays pending (the customer can still pay) until expiry. */
export async function notePaymentProblem(payment: PaymentRow, reason: string) {
  await sql`update payments set failure_reason = ${reason} where id = ${payment.id} and status = 'pending'`
}

export type IssuePointsResult =
  | { issued: true; points: bigint; signature: string | null }
  | { issued: false; reason: string }

/** A blockhash is valid for ~150 blocks (about a minute). After this long an unconfirmed mint can't land. */
const MINT_EXPIRY_MS = 3 * 60 * 1000

/**
 * Settles a mint that was sent but not confirmed, using the chain as the source of truth.
 * Returns 'issued', 'retry' (the mint never landed, safe to send again) or 'wait'.
 */
async function settleInFlightMint(payment: PaymentRow): Promise<'issued' | 'retry' | 'wait'> {
  const age = Date.now() - (payment.pointsClaimedAt?.getTime() ?? 0)
  if (payment.pointsSignature) {
    const { value } = await rpc
      .getSignatureStatuses([payment.pointsSignature as Signature], { searchTransactionHistory: true })
      .send()
    const status = value[0]
    if (status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      await sql`update payments set points_status = 'issued' where id = ${payment.id} and points_status = 'sending'`
      return 'issued'
    }
    if (status && !status.err) return 'wait'
    if (!status && age < MINT_EXPIRY_MS) return 'wait'
  } else if (age < MINT_EXPIRY_MS) {
    return 'wait'
  }
  // Failed onchain, or never landed and its blockhash has expired: nothing was minted.
  const reset = await sql`
    update payments set points_status = null, points_signature = null, points_claimed_at = null
    where id = ${payment.id} and points_status = 'sending' returning id`
  return reset.length ? 'retry' : 'wait'
}

/**
 * Mints loyalty points to the payer of a paid payment. Never mints twice: the row is claimed first,
 * the signature is stored before sending, and an unconfirmed mint is only retried once the chain
 * shows it can no longer land.
 */
export async function issuePointsForPayment(paymentId: string): Promise<IssuePointsResult> {
  let payment = await getPayment(paymentId)
  if (!payment) return { issued: false, reason: 'Payment not found' }
  if (payment.status !== 'paid') return { issued: false, reason: `Payment is ${payment.status}, not paid` }
  if (!payment.payer) return { issued: false, reason: 'Payer is unknown' }
  if (payment.rail === 'paypal') {
    // PayPal customers' points live in the ledger (see paypal-loyalty.ts); nothing to mint onchain.
    const [m] = await sql<MerchantRow[]>`select * from merchants where id = ${payment.merchantId}`
    const earned = calculatePoints(payment.amount - payment.discount, LEDGER_DECIMALS, {
      pointsPerUnit: Number(m!.pointsPerUnit),
      bonusMultiplier: Number(m!.bonusMultiplier),
    })
    const [row] = await sql`
      update payments set points = ${earned.toString()}, points_status = ${earned > 0n ? 'issued' : 'none'}
      where id = ${payment.id} and points_status is null returning id`
    if (!row) return { issued: false, reason: 'Points were already issued for this payment' }
    return { issued: true, points: earned, signature: null }
  }
  if (payment.pointsStatus === 'issued' || payment.pointsStatus === 'none') {
    return { issued: false, reason: 'Points were already issued for this payment' }
  }
  if (payment.pointsStatus === 'sending') {
    const outcome = await settleInFlightMint(payment)
    if (outcome === 'issued') return { issued: true, points: payment.points ?? 0n, signature: payment.pointsSignature }
    if (outcome === 'wait') return { issued: false, reason: 'Points are being issued; the transaction is still confirming' }
    payment = (await getPayment(paymentId))!
  }

  const [merchant] = await sql<MerchantRow[]>`select * from merchants where id = ${payment.merchantId}`
  // Points are earned on what the customer actually paid, not on the part they covered with points.
  const points = calculatePoints(payment.amount - payment.discount, LEDGER_DECIMALS, {
    pointsPerUnit: Number(merchant!.pointsPerUnit),
    bonusMultiplier: Number(merchant!.bonusMultiplier),
  })
  if (points === 0n) {
    await sql`update payments set points = 0, points_status = 'none' where id = ${payment.id} and points_status is null`
    return { issued: true, points: 0n, signature: null }
  }

  const authorityPromise = getPointsAuthority()
  if (!authorityPromise || !config.pointsMint) return { issued: false, reason: 'Points mint is not configured' }
  const authority = await authorityPromise

  // Claim the row so two workers can't mint for the same payment.
  const claimed = await sql`
    update payments set points = ${points.toString()}, points_status = 'sending', points_claimed_at = now()
    where id = ${payment.id} and points_status is null returning id`
  if (claimed.length === 0) return { issued: false, reason: 'Points are already being issued' }

  const instructions = await getIssuePointsInstructions({
    payer: authority,
    mintAuthority: authority,
    pointsMint: config.pointsMint,
    customer: payment.payer as Address,
    points,
  })
  const { wire, signature } = await signTransaction(authority, instructions)
  // Stored before sending, so a crash or timeout can always be resolved against the chain.
  await sql`update payments set points_signature = ${signature} where id = ${payment.id}`
  try {
    await sendAndConfirmWire(wire, signature)
    await sql`update payments set points_status = 'issued' where id = ${payment.id}`
    return { issued: true, points, signature }
  } catch (err) {
    // Left as 'sending'. settleInFlightMint decides later whether it landed.
    return { issued: false, reason: `Points transaction not confirmed yet: ${err instanceof Error ? err.message : err}` }
  }
}

export function serializePayment(p: PaymentRow) {
  return {
    id: p.id,
    rail: p.rail,
    reference: p.reference,
    amount: p.amount.toString(),
    decimals: LEDGER_DECIMALS,
    token: p.tokenSymbol,
    label: p.label,
    status: p.status,
    signature: p.signature,
    payer: p.payer,
    failureReason: p.failureReason,
    points: p.points?.toString() ?? null,
    allowPoints: p.allowPoints,
    pointsRedeemed: p.pointsRedeemed.toString(),
    discount: p.discount.toString(),
    paypalFee: p.paypalFee.toString(),
    pointsIssued: p.pointsStatus === 'issued',
    createdAt: p.createdAt.toISOString(),
    paidAt: p.paidAt?.toISOString() ?? null,
  }
}
