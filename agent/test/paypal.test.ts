import { describe, expect, it } from 'vitest'
import { approvalUrl, completedCapture, createPayPalClient, PayPalError, type PayPalOrder } from '../src/paypal'

type Call = { url: string; init: RequestInit }

function fakeFetch(responses: Record<string, unknown>) {
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`
    const body = key.endsWith('/v1/oauth2/token') ? { access_token: 'tok', expires_in: 3600 } : responses[key]
    if (body === undefined) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { impl, calls }
}

const config = { clientId: 'id', clientSecret: 'secret', env: 'sandbox' as const }

describe('PayPal client', () => {
  it('creates a PAY_NOW order with an idempotency key and returns the approval link', async () => {
    const order: PayPalOrder = {
      id: 'ORDER1',
      status: 'PAYER_ACTION_REQUIRED',
      links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }],
    }
    const { impl, calls } = fakeFetch({ 'POST /v2/checkout/orders': order })
    const paypal = createPayPalClient(config, impl)
    const created = await paypal.createOrder({
      referenceId: 'pay-1',
      value: '4.50',
      currency: 'USD',
      brandName: 'Pasty Shop',
      returnUrl: 'https://api.example/paypal/return',
      cancelUrl: 'https://api.example/paypal/cancel',
    })

    expect(approvalUrl(created)).toBe('https://www.sandbox.paypal.com/checkoutnow?token=ORDER1')
    const [auth, create] = calls
    expect(auth!.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token')
    expect((auth!.init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa('id:secret')}`)
    const headers = create!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok')
    expect(headers['paypal-request-id']).toBe('create-pay-1')
    const body = JSON.parse(create!.init.body as string)
    expect(body.intent).toBe('CAPTURE')
    expect(body.purchase_units[0]).toMatchObject({ reference_id: 'pay-1', amount: { currency_code: 'USD', value: '4.50' } })
    expect(body.payment_source.paypal.experience_context).toMatchObject({ user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' })
  })

  it('reuses the access token across calls', async () => {
    const { impl, calls } = fakeFetch({ 'GET /v2/checkout/orders/A': { id: 'A', status: 'CREATED' } })
    const paypal = createPayPalClient(config, impl)
    await paypal.getOrder('A')
    await paypal.getOrder('A')
    expect(calls.filter((c) => c.url.endsWith('/v1/oauth2/token'))).toHaveLength(1)
  })

  it('surfaces PayPal errors with status and issue', async () => {
    const impl = (async (url: string) =>
      url.endsWith('/v1/oauth2/token')
        ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }))
        : new Response(JSON.stringify({ message: 'Order not approved', details: [{ issue: 'ORDER_NOT_APPROVED' }] }), {
            status: 422,
          })) as typeof fetch
    const paypal = createPayPalClient(config, impl)
    const err = await paypal.captureOrder('X').catch((e) => e)
    expect(err).toBeInstanceOf(PayPalError)
    expect(err).toMatchObject({ status: 422, issue: 'ORDER_NOT_APPROVED' })
  })

  it('only treats a completed order with a completed capture as paid', () => {
    const capture = { id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '4.50' } }
    expect(completedCapture({ id: 'A', status: 'COMPLETED', purchase_units: [{ payments: { captures: [capture] } }] })).toEqual(capture)
    expect(
      completedCapture({ id: 'A', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ ...capture, status: 'PENDING' }] } }] }),
    ).toBeNull()
    expect(completedCapture({ id: 'A', status: 'APPROVED' })).toBeNull()
  })
})
