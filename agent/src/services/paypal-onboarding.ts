import { config } from '../config'
import { sql, type MerchantRow } from '../db'
import { PayPalError } from '../paypal'
import { getPayPal } from './payments'

export class OnboardingError extends Error {}

/** The link the shop owner opens to connect their PayPal to Tilltide. */
export async function startPayPalOnboarding(merchant: MerchantRow): Promise<string> {
  const paypal = getPayPal()
  if (!paypal || !config.paypalPlatform.partnerMerchantId) throw new OnboardingError('PayPal onboarding is not set up on the server')
  const link = await paypal.createPartnerReferral(merchant.id, `${config.publicUrl}/paypal/onboarded`)
  await sql`update merchants set paypal_status = 'pending' where id = ${merchant.id} and paypal_status <> 'connected'`
  return link
}

/**
 * Confirms onboarding with PayPal itself (the return URL's query string can be forged), and records
 * the shop's PayPal merchant id once it can receive payments.
 */
export async function refreshPayPalConnection(merchantId: string): Promise<MerchantRow | null> {
  const paypal = getPayPal()
  const partner = config.paypalPlatform.partnerMerchantId
  if (!paypal || !partner) return null
  try {
    const integration = await paypal.getMerchantIntegration(partner, merchantId)
    if (integration.merchant_id && integration.payments_receivable) {
      const [row] = await sql<MerchantRow[]>`
        update merchants set paypal_merchant_id = ${integration.merchant_id}, paypal_status = 'connected'
        where id = ${merchantId} returning *`
      return row ?? null
    }
  } catch (err) {
    if (!(err instanceof PayPalError && err.status === 404)) throw err
  }
  const [row] = await sql<MerchantRow[]>`select * from merchants where id = ${merchantId}`
  return row ?? null
}

/** Who a PayPal sale for this shop is paid to, and whether Tilltide can take its fee. */
export function paypalPayee(merchant: MerchantRow): { payee?: { merchantId?: string; email?: string }; feeAllowed: boolean } {
  if (merchant.paypalStatus === 'connected' && merchant.paypalMerchantId) return { payee: { merchantId: merchant.paypalMerchantId }, feeAllowed: true }
  // Email payees are a sandbox / non-partner convenience only (see PATCH /shop).
  if (merchant.paypalEmail && !config.paypalPlatform.requireConnected) return { payee: { email: merchant.paypalEmail }, feeAllowed: false }
  return { feeAllowed: false }
}
