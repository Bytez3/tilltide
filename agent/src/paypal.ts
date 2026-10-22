/**
 * Minimal PayPal Orders v2 client: create an order, read it, capture it.
 * https://developer.paypal.com/docs/api/orders/v2/
 */

export interface PayPalConfig {
  clientId: string
  clientSecret: string
  env: 'sandbox' | 'live'
  /** Override the API host, e.g. to point at a local mock in tests. */
  apiBase?: string
  /** PayPal partner attribution (BN) code, sent on every call when Tilltide acts as a platform. */
  bnCode?: string
}

export type OrderStatus = 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED'

export interface PayPalOrder {
  id: string
  status: OrderStatus
  payer?: { payer_id?: string }
  links?: { href: string; rel: string; method?: string }[]
  purchase_units?: {
    reference_id?: string
    payments?: { captures?: { id: string; status: string; amount: { currency_code: string; value: string } }[] }
  }[]
}

export interface PayPalRefund {
  id: string
  status: 'CANCELLED' | 'FAILED' | 'PENDING' | 'COMPLETED'
  amount?: { currency_code: string; value: string }
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issue?: string,
    /** 'auth' = getting the access token failed, so the actual API call never happened. */
    readonly stage: 'auth' | 'api' = 'api',
  ) {
    super(message)
  }
}

export interface CreateOrderInput {
  /** Our payment id; echoed back as reference_id and used as the idempotency key. */
  referenceId: string
  /** Decimal string in `currency`, e.g. "4.50". */
  value: string
  currency: string
  description?: string
  brandName: string
  returnUrl: string
  cancelUrl: string
  /** The shop's own PayPal account. Without it the payment goes to the account that owns these API keys. */
  payee?: { merchantId?: string; email?: string }
  /** Tilltide's platform fee, taken from the payment by PayPal (needs partner status with PayPal). */
  platformFee?: { value: string; currency: string }
}

const PAYPAL_TIMEOUT_MS = 20_000

export function createPayPalClient(config: PayPalConfig, fetchImpl: typeof fetch = fetch) {
  const base = config.apiBase ?? (config.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com')
  let token: { value: string; expiresAt: number } | null = null

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(PAYPAL_TIMEOUT_MS),
    })
    if (!res.ok) throw new PayPalError('PayPal authentication failed', res.status, undefined, 'auth')
    const body = (await res.json()) as { access_token: string; expires_in: number }
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
    return token.value
  }

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
        ...(requestId ? { 'paypal-request-id': requestId } : {}),
        ...(config.bnCode ? { 'paypal-partner-attribution-id': config.bnCode } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A hung call is treated like a lost response: idempotency keys make the retry safe.
      signal: AbortSignal.timeout(PAYPAL_TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => ({}))) as { message?: string; details?: { issue?: string }[] }
    if (!res.ok) throw new PayPalError(json.message ?? `PayPal request failed (${res.status})`, res.status, json.details?.[0]?.issue)
    return json as T
  }

  return {
    createOrder: (input: CreateOrderInput) =>
      call<PayPalOrder>(
        'POST',
        '/v2/checkout/orders',
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: input.referenceId,
              description: input.description,
              amount: { currency_code: input.currency, value: input.value },
              ...(input.payee?.merchantId
                ? { payee: { merchant_id: input.payee.merchantId } }
                : input.payee?.email
                  ? { payee: { email_address: input.payee.email } }
                  : {}),
              ...(input.platformFee
                ? { payment_instruction: { platform_fees: [{ amount: { currency_code: input.platformFee.currency, value: input.platformFee.value } }] } }
                : {}),
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: input.brandName,
                user_action: 'PAY_NOW',
                shipping_preference: 'NO_SHIPPING',
                return_url: input.returnUrl,
                cancel_url: input.cancelUrl,
              },
            },
          },
        },
        `create-${input.referenceId}`,
      ),
    getOrder: (id: string) => call<PayPalOrder>('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`),
    /**
     * Refunds all or part of a capture. `requestId` makes it idempotent: retrying with the same id
     * returns the original refund instead of refunding twice.
     */
    refundCapture: (
      captureId: string,
      amount: { value: string; currency: string },
      requestId: string,
      noteToPayer?: string,
      /** The connected shop's PayPal merchant id: the refund is made on its behalf. */
      onBehalfOf?: string,
    ) =>
      call<PayPalRefund>(
        'POST',
        `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
        { amount: { value: amount.value, currency_code: amount.currency }, ...(noteToPayer ? { note_to_payer: noteToPayer.slice(0, 255) } : {}) },
        requestId,
        onBehalfOf ? { 'paypal-auth-assertion': authAssertion(config.clientId, onBehalfOf) } : {},
      ),
    /** Starts PayPal onboarding for a shop. Returns the link the owner opens to connect their PayPal. */
    createPartnerReferral: async (trackingId: string, returnUrl: string) => {
      const res = await call<{ links?: { rel: string; href: string }[] }>('POST', '/v2/customer/partner-referrals', {
        tracking_id: trackingId,
        partner_config_override: { return_url: returnUrl },
        operations: [
          {
            operation: 'API_INTEGRATION',
            api_integration_preference: {
              rest_api_integration: {
                integration_method: 'PAYPAL',
                integration_type: 'THIRD_PARTY',
                third_party_details: { features: ['PAYMENT', 'REFUND', 'PARTNER_FEE'] },
              },
            },
          },
        ],
        products: ['EXPRESS_CHECKOUT'],
        legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
      })
      const link = res.links?.find((l) => l.rel === 'action_url')?.href
      if (!link) throw new PayPalError('PayPal did not return an onboarding link', 502)
      return link
    },
    /** Whether a shop finished onboarding and can take payments, looked up by our tracking id. */
    getMerchantIntegration: (partnerMerchantId: string, trackingId: string) =>
      call<{ merchant_id?: string; tracking_id?: string; payments_receivable?: boolean; primary_email_confirmed?: boolean }>(
        'GET',
        `/v1/customer/partners/${encodeURIComponent(partnerMerchantId)}/merchant-integrations?tracking_id=${encodeURIComponent(trackingId)}`,
      ),
    getRefund: (id: string) => call<PayPalRefund>('GET', `/v2/payments/refunds/${encodeURIComponent(id)}`),
    captureOrder: (id: string) =>
      call<PayPalOrder>('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, `capture-${id}`),
  }
}

export type PayPalClient = ReturnType<typeof createPayPalClient>

/** The URL the customer opens to approve the order. */
export function approvalUrl(order: PayPalOrder): string | null {
  return order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null
}

export function completedCapture(order: PayPalOrder) {
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0]
  return order.status === 'COMPLETED' && capture?.status === 'COMPLETED' ? capture : null
}

/** PayPal-Auth-Assertion: lets a platform act on behalf of a connected merchant (unsigned JWT, per PayPal docs). */
export function authAssertion(clientId: string, merchantId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64({ iss: clientId, payer_id: merchantId })}.`
}
