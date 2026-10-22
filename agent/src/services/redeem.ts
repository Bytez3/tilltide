import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { findSignaturesByReference, fromBaseUnits, getRedeemPaymentInstructions, planRedemption, verifyPayment } from '@tilltide/agent-pay-kit'
import { config } from '../config'
import { LEDGER_DECIMALS, sql, type MerchantRow, type PaymentRow } from '../db'
import { rpc } from '../solana'
import { fromTokenUnits, toTokenUnits } from '../fx'

export class RedeemError extends Error {}

async function pointsBalance(owner: Address): Promise<bigint> {
  if (!config.pointsMint) return 0n
  const [ata] = await findAssociatedTokenPda({ owner, mint: config.pointsMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  return rpc
    .getTokenAccountBalance(ata, { commitment: 'confirmed' })
    .send()
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n)
}

/**
 * Wallet points this customer earned at this shop, minus what they've spent here. Every shop shares
 * one points token, so a shop honours only the points it issued itself: another shop (with its own,
 * possibly generous, earn rate) can never hand out discounts here.
 */
export async function shopPointsBalance(merchantId: string, wallet: string, excludePaymentId?: string): Promise<bigint> {
  const [row] = await sql<{ earned: bigint; spent: bigint }[]>`
    select coalesce(sum(case when points_status = 'issued' then points else 0 end), 0)::bigint as earned,
           coalesce(sum(points_redeemed), 0)::bigint as spent
    from payments
    where merchant_id = ${merchantId} and rail = 'solana' and payer = ${wallet} and status = 'paid'
      ${excludePaymentId ? sql`and id <> ${excludePaymentId}` : sql``}`
  const balance = (row?.earned ?? 0n) - (row?.spent ?? 0n)
  return balance > 0n ? balance : 0n
}

/** What a customer can spend at this shop: their points here, and no more than their wallet holds. */
export async function spendablePoints(merchantId: string, wallet: Address, excludePaymentId?: string): Promise<bigint> {
  const [onchain, here] = await Promise.all([pointsBalance(wallet), shopPointsBalance(merchantId, wallet, excludePaymentId)])
  return onchain < here ? onchain : here
}

export function redemptionMemo(paymentId: string) {
  return `tilltide:pay:${paymentId}`
}

/**
 * Solana Pay transaction request (POST): builds the transaction the customer's wallet will sign —
 * pay the discounted price and burn the points that cover the rest. The wallet shows `message`.
 */
export async function buildRedeemTransaction(paymentId: string, account: string) {
  const [payment] = await sql<(PaymentRow & { merchant: MerchantRow })[]>`select * from payments where id = ${paymentId}`
  if (!payment || payment.status !== 'pending' || !payment.allowPoints || !payment.reference) {
    throw new RedeemError('This payment request is closed')
  }
  if (!config.pointsMint) throw new RedeemError('Points are not set up')
  const [merchant] = await sql<MerchantRow[]>`select * from merchants where id = ${payment.merchantId}`
  const customer = address(account)
  const token = config.tokens[payment.tokenSymbol as 'USDC' | 'PYUSD']
  // The discount is worked out in the shop's currency; only the rest is converted to tokens.
  const plan = planRedemption(payment.amount, await spendablePoints(merchant!.id, customer, payment.id), {
    pointValue: merchant!.pointValue,
    maxPercent: merchant!.redeemMaxPercent,
  })
  const toPayTokens = toTokenUnits(plan.toPay, payment.fxRate)

  const instructions = await getRedeemPaymentInstructions({
    customer,
    recipient: address(merchant!.wallet),
    token,
    toPay: toPayTokens,
    pointsMint: config.pointsMint,
    points: plan.points,
    reference: address(payment.reference),
    memo: redemptionMemo(payment.id),
  })
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(customer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const price = Number(fromBaseUnits(toPayTokens, token.decimals)).toFixed(2)
  return {
    transaction: getBase64EncodedWireTransaction(compileTransaction(message)),
    message:
      plan.points > 0n
        ? `${merchant!.name}: using ${plan.points} points (${Number(fromBaseUnits(plan.discount, LEDGER_DECIMALS)).toFixed(2)} ${payment.currency} off). You pay ${price} ${token.symbol}.`
        : `${merchant!.name}: ${price} ${token.symbol}`,
  }
}

/**
 * Checks transactions carrying a points-enabled payment's reference. Judged on what the transaction
 * actually did, not on what we offered: cash received + points burned × point value must cover the
 * price, and the points part can't exceed the shop's cap.
 */
export async function findRedeemPayment(payment: PaymentRow, merchant: MerchantRow, rejected: Set<string>) {
  const token = config.tokens[payment.tokenSymbol as 'USDC' | 'PYUSD']
  const cap = (payment.amount * BigInt(merchant.redeemMaxPercent)) / 100n
  let mismatch: string | null = null
  for (const signature of await findSignaturesByReference(rpc, address(payment.reference!))) {
    if (rejected.has(signature)) continue
    const result = await verifyPayment(rpc, signature, { recipient: address(merchant.wallet), token, amount: 0n })
    if (!result.ok) {
      if (!result.retryable) rejected.add(signature)
      continue
    }
    // Points count only if they left circulation: the payer's balance went down AND the token's total
    // across the transaction went down by as much. Moving points to another wallet nets to zero.
    const payerDrop = config.pointsMint ? -(result.payerDeltas[config.pointsMint] ?? 0n) : 0n
    const netBurn = config.pointsMint ? -(result.mintDeltas[config.pointsMint] ?? 0n) : 0n
    let burned = payerDrop < netBurn ? payerDrop : netBurn
    if (burned < 0n) burned = 0n
    // And only points earned at this shop can buy a discount here.
    if (burned > 0n && result.payer) {
      const allowed = await shopPointsBalance(merchant.id, result.payer, payment.id)
      if (burned > allowed) burned = allowed
    }
    const discount = burned * merchant.pointValue
    // Tokens received, converted back at the rate the sale was priced at.
    const receivedInCurrency = fromTokenUnits(result.received, payment.fxRate)
    const reason =
      discount > cap
        ? `Points covered ${fromBaseUnits(discount, LEDGER_DECIMALS)} ${payment.currency}, more than the ${merchant.redeemMaxPercent}% allowed`
        : receivedInCurrency + discount < payment.amount
          ? `Received ${fromBaseUnits(result.received, token.decimals)} ${token.symbol} + ${burned} points, short of ${fromBaseUnits(payment.amount, LEDGER_DECIMALS)} ${payment.currency}`
          : null
    if (!reason) return { status: 'paid' as const, payment: result, pointsRedeemed: burned, discount }
    rejected.add(signature)
    mismatch = reason
  }
  return mismatch ? { status: 'mismatch' as const, reason: mismatch } : { status: 'none' as const }
}
