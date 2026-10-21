import Anthropic from '@anthropic-ai/sdk'
import { address, isAddress, type Signature } from '@solana/kit'
import { toBaseUnits } from '@tilltide/agent-pay-kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { runAgent } from './agent'
import { config } from './config'
import { LEDGER_DECIMALS, sql, type MerchantRow, type PaymentRow, type SweepRow } from './db'
import { getMerchant, merchantToken } from './services/merchants'
import { checkPayPalPayment, createPayment, createPayPalPayment, getPayment, serializePayment } from './services/payments'
import { getDailySummary, reconcileDay, todayIn } from './services/summary'
import { confirmSweep, serializeSweep } from './services/sweeps'
import { checkPayment } from './services/watcher'
import { rpc } from './solana'

const wallet = z.string().refine(isAddress, 'Not a Solana address')
const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}, 'Unknown timezone')
const isUuid = (id: string) => z.uuid().safeParse(id).success
const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))

async function body<T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) })
  return parsed.data
}

async function merchantOr404(id: string): Promise<MerchantRow> {
  const merchant = isUuid(id) ? await getMerchant(id) : null
  if (!merchant) throw new HTTPException(404, { message: 'Merchant not found' })
  return merchant
}

function serializeMerchant(m: MerchantRow) {
  return {
    id: m.id,
    name: m.name,
    wallet: m.wallet,
    ownerWallet: m.ownerWallet,
    token: m.tokenSymbol,
    pointsPerUnit: Number(m.pointsPerUnit),
    bonusMultiplier: Number(m.bonusMultiplier),
    timezone: m.timezone,
    cluster: config.cluster,
    pointsMint: config.pointsMint,
    paypalEnabled: Boolean(config.paypal),
  }
}

export const app = new Hono()

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
  console.error(err)
  return c.json({ error: 'Internal error' }, 500)
})

app.get('/health', (c) => c.json({ ok: true, cluster: config.cluster }))

// Customer-facing reads (points balance) are public; merchant routes need the app key.
app.get('/points/:wallet', async (c) => {
  const owner = c.req.param('wallet')
  if (!isAddress(owner)) throw new HTTPException(400, { message: 'Not a Solana address' })
  if (!config.pointsMint) return c.json({ wallet: owner, points: '0', configured: false })
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: config.pointsMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const points = await rpc
    .getTokenAccountBalance(ata, { commitment: 'confirmed' })
    .send()
    .then((r) => r.value.amount)
    .catch(() => '0')
  return c.json({ wallet: owner, points, configured: true })
})

const page = (title: string, text: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui;background:#F6F3EE;color:#14211F;display:grid;place-items:center;min-height:90vh;text-align:center;padding:16px">
<div><h1 style="margin:0 0 8px">${title}</h1><p style="color:#5E6B68">${text}</p></div></body>`

/** PayPal sends the customer here after they approve. Capture straight away so the till flips to Paid. */
app.get('/paypal/return', async (c) => {
  const orderId = c.req.query('token')
  const [payment] = orderId ? await sql<PaymentRow[]>`select * from payments where paypal_order_id = ${orderId}` : []
  if (!payment) return c.html(page('Payment not found', 'Show this screen to the shop.'), 404)
  if (payment.status === 'expired') {
    return c.html(page('Request expired', 'No money was taken. Please ask the shop for a new QR code.'))
  }
  await checkPayPalPayment(payment).catch((err) => console.error('PayPal capture on return failed', err))
  const latest = (await getPayment(payment.id))!
  return latest.status === 'paid'
    ? c.html(page('Paid ✓', 'Thanks! You can close this page.'))
    : c.html(page('Almost there', 'Your payment is processing. The shop will see it in a moment.'))
})

app.get('/paypal/cancel', (c) => c.html(page('Payment cancelled', 'No money was taken.')))

const requireAppKey = createMiddleware(async (c, next) => {
  if (config.appApiKey && c.req.header('x-api-key') !== config.appApiKey) {
    throw new HTTPException(401, { message: 'Bad API key' })
  }
  await next()
})
app.use('/merchants', requireAppKey)
app.use('/merchants/*', requireAppKey)
app.use('/payments/*', requireAppKey)
app.use('/sweeps/*', requireAppKey)

/** Register or fetch the shop for a connected till wallet. */
app.post('/merchants', async (c) => {
  const input = await body(c, z.object({ name: z.string().min(1).max(80), wallet }))
  const [row] = await sql<MerchantRow[]>`
    insert into merchants (name, wallet) values (${input.name}, ${input.wallet})
    on conflict (wallet) do update set wallet = excluded.wallet
    returning *`
  return c.json(serializeMerchant(row!))
})

app.get('/merchants/:id', async (c) => c.json(serializeMerchant(await merchantOr404(c.req.param('id')))))

app.patch('/merchants/:id', async (c) => {
  const merchant = await merchantOr404(c.req.param('id'))
  const input = await body(
    c,
    z.object({
      name: z.string().min(1).max(80).optional(),
      ownerWallet: wallet.nullable().optional(),
      token: z.enum(['USDC', 'PYUSD']).optional(),
      pointsPerUnit: z.number().min(0).max(1000).optional(),
      bonusMultiplier: z.number().min(1).max(10).optional(),
      timezone: timezone.optional(),
    }),
  )
  const [row] = await sql<MerchantRow[]>`
    update merchants set
      name = ${input.name ?? merchant.name},
      owner_wallet = ${input.ownerWallet === undefined ? merchant.ownerWallet : input.ownerWallet},
      token_symbol = ${input.token ?? merchant.tokenSymbol},
      points_per_unit = ${input.pointsPerUnit ?? merchant.pointsPerUnit},
      bonus_multiplier = ${input.bonusMultiplier ?? merchant.bonusMultiplier},
      timezone = ${input.timezone ?? merchant.timezone}
    where id = ${merchant.id} returning *`
  return c.json(serializeMerchant(row!))
})

/**
 * Merchant enters an amount; returns the URL to show as a QR.
 * `solana`: a Solana Pay transfer request. `paypal`: PayPal's checkout page, for customers without a wallet.
 */
app.post('/merchants/:id/payments', async (c) => {
  const merchant = await merchantOr404(c.req.param('id'))
  const input = await body(
    c,
    z.object({
      amount: z.string(),
      label: z.string().max(80).optional(),
      rail: z.enum(['solana', 'paypal']).default('solana'),
    }),
  )
  let amount: bigint
  try {
    // Every rail uses 6-decimal ledger units; PayPal additionally needs whole cents.
    amount = toBaseUnits(input.amount, input.rail === 'paypal' ? 2 : merchantToken(merchant).decimals)
    if (input.rail === 'paypal') amount *= 10n ** BigInt(LEDGER_DECIMALS - 2)
  } catch (err) {
    throw new HTTPException(400, { message: (err as Error).message })
  }
  if (amount <= 0n) throw new HTTPException(400, { message: 'Amount must be more than zero' })
  if (input.rail === 'paypal') {
    if (!config.paypal) throw new HTTPException(400, { message: 'PayPal is not set up on the server' })
    try {
      const { payment, url } = await createPayPalPayment(merchant, amount, input.label)
      return c.json({ ...serializePayment(payment), url }, 201)
    } catch (err) {
      throw new HTTPException(502, { message: `PayPal: ${(err as Error).message}` })
    }
  }
  const { payment, url } = await createPayment(merchant, amount, input.label)
  return c.json({ ...serializePayment(payment), url }, 201)
})

app.get('/merchants/:id/payments', async (c) => {
  const merchant = await merchantOr404(c.req.param('id'))
  const rows = await sql<PaymentRow[]>`
    select * from payments where merchant_id = ${merchant.id} order by created_at desc limit 50`
  return c.json(rows.map(serializePayment))
})

/** The app polls this while the QR is on screen. Also checks the chain directly so "Paid ✓" shows fast. */
app.get('/payments/:id', async (c) => {
  const id = c.req.param('id')
  let payment = isUuid(id) ? await getPayment(id) : null
  if (!payment) throw new HTTPException(404, { message: 'Payment not found' })
  // Expired Solana requests are re-checked too: a customer may have paid late, and the money did arrive.
  if (payment.status === 'pending' || (payment.status === 'expired' && payment.rail === 'solana')) {
    const merchant = (await getMerchant(payment.merchantId))!
    if (await checkPayment(payment, merchant).catch(() => false)) payment = (await getPayment(id))!
  }
  return c.json(serializePayment(payment))
})

app.get('/merchants/:id/summary', async (c) => {
  const merchant = await merchantOr404(c.req.param('id'))
  const date = c.req.query('date') ?? todayIn(merchant.timezone)
  if (!isDate(date)) throw new HTTPException(400, { message: 'date must be YYYY-MM-DD' })
  const reconcile = c.req.query('reconcile') === 'true'
  return c.json({
    summary: await getDailySummary(merchant, date),
    reconciliation: reconcile ? await reconcileDay(merchant, date) : null,
  })
})

app.post('/merchants/:id/chat', async (c) => {
  const merchant = await merchantOr404(c.req.param('id'))
  const input = await body(
    c,
    z.object({
      messages: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) }))
        .min(1)
        .max(40)
        .refine((m) => m.at(-1)?.role === 'user', 'Last message must be from the user'),
    }),
  )
  try {
    return c.json(await runAgent(merchant, input.messages))
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new HTTPException(429, { message: 'The agent is busy, try again in a moment' })
    if (err instanceof Anthropic.APIConnectionError) throw new HTTPException(503, { message: 'Could not reach the agent' })
    if (err instanceof Anthropic.APIError) throw new HTTPException(502, { message: `Agent error: ${err.message}` })
    if (err instanceof Error && err.message.includes('authentication method')) {
      throw new HTTPException(503, { message: 'Agent is not configured (ANTHROPIC_API_KEY missing)' })
    }
    throw err
  }
})

app.get('/merchants/:id/sweeps', async (c) => {
  const merchant = await merchantOr404(c.req.param('id'))
  const rows = await sql<SweepRow[]>`
    select * from sweeps where merchant_id = ${merchant.id} order by created_at desc limit 20`
  return c.json(rows.map(serializeSweep))
})

/** The app calls this after the owner signed the sweep in their wallet. */
app.post('/sweeps/:id/confirm', async (c) => {
  if (!isUuid(c.req.param('id'))) throw new HTTPException(404, { message: 'Sweep not found' })
  const input = await body(c, z.object({ signature: z.string().min(64).max(100) }))
  try {
    return c.json(serializeSweep(await confirmSweep(c.req.param('id'), input.signature as Signature)))
  } catch (err) {
    throw new HTTPException(400, { message: (err as Error).message })
  }
})

app.post('/sweeps/:id/cancel', async (c) => {
  if (!isUuid(c.req.param('id'))) throw new HTTPException(404, { message: 'No open sweep with that id' })
  const [row] = await sql<SweepRow[]>`
    update sweeps set status = 'cancelled' where id = ${c.req.param('id')} and status = 'proposed' returning *`
  if (!row) throw new HTTPException(404, { message: 'No open sweep with that id' })
  return c.json(serializeSweep(row))
})

