import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { address, isAddress, isSignature, type Signature } from '@solana/kit'
import { toBaseUnits } from '@tilltide/agent-pay-kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { runAgent } from './agent'
import { clientIp, rateLimit } from './rate-limit'
import { reserveAgentRequest, UsageLimitError } from './services/usage'
import { AuthError, createNonce, revokeToken, verifySignIn, walletForToken } from './auth'
import { config } from './config'
import { isDate } from './dates'
import { LEDGER_DECIMALS, sql, type MerchantRow, type PaymentRow, type SweepRow } from './db'
import { merchantToken } from './services/merchants'
import { checkPayPalPayment, createPayment, createPayPalPayment, getPayment, serializePayment } from './services/payments'
import { getDailySummary, reconcileDay, todayIn } from './services/summary'
import { beginSweep, getSweep, serializeSweep, settleSweep, submitSweep, SweepError } from './services/sweeps'
import { checkPayment } from './services/watcher'
import { rpc } from './solana'

const wallet = z.string().refine(isAddress, 'Not a Solana address')
// IANA names only (e.g. Europe/London). Offsets like "+01:00" mean different things to Intl and Postgres.
const timezone = z
  .string()
  .regex(/^[A-Za-z]+(\/[A-Za-z0-9_-]+)+$|^UTC$/, 'Use a timezone name like Europe/London')
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz })
      return true
    } catch {
      return false
    }
  }, 'Unknown timezone')
  .refine(async (tz) => (await sql`select 1 from pg_timezone_names where name = ${tz}`).length > 0, 'Unknown timezone')
const isUuid = (id: string) => z.uuid().safeParse(id).success

async function body<T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = await schema.safeParseAsync(await c.req.json().catch(() => ({})))
  if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) })
  return parsed.data
}

function serializeMerchant(m: MerchantRow) {
  return {
    id: m.id,
    name: m.name,
    wallet: m.wallet,
    ownerWallet: m.ownerWallet,
    token: m.tokenSymbol,
    pointsPerUnit: Number(m.pointsPerUnit),
    timezone: m.timezone,
    cluster: config.cluster,
    pointsMint: config.pointsMint,
    paypalEnabled: Boolean(config.paypal),
  }
}

export const app = new Hono()

app.use(secureHeaders())
// Every request body here is small JSON; refuse anything big before parsing it.
app.use(bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'Request too large' }, 413) }))
app.use('*', rateLimit({ name: 'ip', windowMs: 60_000, max: config.rateLimits.perIp, key: clientIp }))
app.use('/auth/*', rateLimit({ name: 'auth', windowMs: 60_000, max: config.rateLimits.auth, key: clientIp }))

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
  console.error(err)
  return c.json({ error: 'Internal error' }, 500)
})

app.get('/health', (c) => c.json({ ok: true, cluster: config.cluster }))

// The app's MWA identity points at this server: wallets load the icon from here and can check
// the Android app against Digital Asset Links.
const favicon = readFileSync(new URL('../public/favicon.png', import.meta.url))
app.get('/favicon.png', (c) => c.body(favicon, 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }))
app.get('/.well-known/assetlinks.json', (c) =>
  c.json(
    config.androidCertSha256.length
      ? [
          {
            relation: ['delegate_permission/common.handle_all_urls'],
            target: { namespace: 'android_app', package_name: 'com.bytez3.tilltide', sha256_cert_fingerprints: config.androidCertSha256 },
          },
        ]
      : [],
  ),
)

// Customer-facing reads (points balance) are public; shop routes need a signed-in till wallet.
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

// ---- Sign In With Solana -------------------------------------------------------------

app.post('/auth/nonce', async (c) => c.json(await createNonce()))

app.post('/auth/verify', async (c) => {
  const input = await body(
    c,
    z.object({ address: z.string(), signedMessage: z.base64().max(4000), signature: z.base64().max(200) }),
  )
  try {
    const session = await verifySignIn({
      address: input.address,
      signedMessage: new Uint8Array(Buffer.from(input.signedMessage, 'base64')),
      signature: new Uint8Array(Buffer.from(input.signature, 'base64')),
    })
    return c.json(session)
  } catch (err) {
    if (err instanceof AuthError) throw new HTTPException(401, { message: err.message })
    throw err
  }
})

// ---- The signed-in shop ---------------------------------------------------------------
// Everything under /shop is scoped to the wallet that signed in. There is no way to name another shop.

type ShopEnv = { Variables: { wallet: string; token: string } }
const shop = new Hono<ShopEnv>()

shop.use(async (c, next) => {
  const token = c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{20,100})$/)?.[1]
  const wallet = token ? await walletForToken(token) : null
  if (!wallet || !token) throw new HTTPException(401, { message: 'Sign in again' })
  c.set('wallet', wallet)
  c.set('token', token)
  await next()
})

shop.post('/logout', async (c) => {
  await revokeToken(c.get('token'))
  return c.json({ ok: true })
})

async function myShop(c: { get(key: 'wallet'): string }): Promise<MerchantRow> {
  const [merchant] = await sql<MerchantRow[]>`select * from merchants where wallet = ${c.get('wallet')}`
  if (!merchant) throw new HTTPException(404, { message: 'No shop for this wallet yet' })
  return merchant
}

shop.get('/', async (c) => c.json(serializeMerchant(await myShop(c))))

/** Registers the shop for the signed-in till wallet (or returns it if it exists). */
shop.post('/', async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(80) }))
  const [row] = await sql<MerchantRow[]>`
    insert into merchants (name, wallet) values (${input.name}, ${c.get('wallet')})
    on conflict (wallet) do update set wallet = excluded.wallet
    returning *`
  return c.json(serializeMerchant(row!))
})

shop.patch('/', async (c) => {
  const merchant = await myShop(c)
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(80).optional(),
      ownerWallet: wallet.nullable().optional(),
      token: z.enum(['USDC', 'PYUSD']).optional(),
      pointsPerUnit: z.number().min(0).max(1000).optional(),
      timezone: timezone.optional(),
    }),
  )
  if (input.ownerWallet && input.ownerWallet === merchant.wallet) {
    throw new HTTPException(400, { message: 'The owner wallet must be different from the till wallet' })
  }
  const [row] = await sql<MerchantRow[]>`
    update merchants set
      name = ${input.name ?? merchant.name},
      owner_wallet = ${input.ownerWallet === undefined ? merchant.ownerWallet : input.ownerWallet},
      token_symbol = ${input.token ?? merchant.tokenSymbol},
      points_per_unit = ${input.pointsPerUnit ?? merchant.pointsPerUnit},
      timezone = ${input.timezone ?? merchant.timezone}
    where id = ${merchant.id} returning *`
  return c.json(serializeMerchant(row!))
})

/**
 * Merchant enters an amount; returns the URL to show as a QR.
 * `solana`: a Solana Pay transfer request. `paypal`: PayPal's checkout page, for customers without a wallet.
 */
shop.post('/payments', async (c) => {
  const merchant = await myShop(c)
  const input = await body(
    c,
    z.object({
      amount: z.string().max(20),
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
  if (amount > 1_000_000n * 10n ** BigInt(LEDGER_DECIMALS)) throw new HTTPException(400, { message: 'Amount is too large' })
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

shop.get('/payments', async (c) => {
  const merchant = await myShop(c)
  const rows = await sql<PaymentRow[]>`
    select * from payments where merchant_id = ${merchant.id} order by created_at desc limit 50`
  return c.json(rows.map(serializePayment))
})

/** The app polls this while the QR is on screen. Also checks the rail directly so "Paid ✓" shows fast. */
shop.get('/payments/:id', async (c) => {
  const merchant = await myShop(c)
  const id = c.req.param('id')
  const [found] = isUuid(id) ? await sql<PaymentRow[]>`select * from payments where id = ${id} and merchant_id = ${merchant.id}` : []
  if (!found) throw new HTTPException(404, { message: 'Payment not found' })
  let payment = found
  // Open requests, plus recently closed Solana ones: a customer may have paid late, and the money did arrive.
  const recheck =
    payment.status === 'pending' ||
    (payment.rail === 'solana' && payment.status !== 'paid' && Date.now() - payment.createdAt.getTime() < 86_400_000)
  if (recheck && (await checkPayment(payment, merchant).catch(() => false))) payment = (await getPayment(id))!
  return c.json(serializePayment(payment))
})

shop.get('/summary', async (c) => {
  const merchant = await myShop(c)
  const date = c.req.query('date') ?? todayIn(merchant.timezone)
  if (!isDate(date)) throw new HTTPException(400, { message: 'date must be YYYY-MM-DD' })
  const reconcile = c.req.query('reconcile') === 'true'
  return c.json({
    summary: await getDailySummary(merchant, date),
    reconciliation: reconcile ? await reconcileDay(merchant, date) : null,
  })
})

shop.post('/chat', rateLimit({ name: 'chat', windowMs: 60_000, max: 10, key: (c) => c.get('wallet') }), async (c) => {
  const merchant = await myShop(c)
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
    await reserveAgentRequest(merchant)
    const { usage: _usage, ...result } = await runAgent(merchant, input.messages)
    return c.json(result)
  } catch (err) {
    if (err instanceof UsageLimitError) throw new HTTPException(429, { message: err.message })
    if (err instanceof Anthropic.RateLimitError) throw new HTTPException(429, { message: 'The agent is busy, try again in a moment' })
    if (err instanceof Anthropic.APIConnectionError) throw new HTTPException(503, { message: 'Could not reach the agent' })
    if (err instanceof Anthropic.APIError) throw new HTTPException(502, { message: `Agent error: ${err.message}` })
    if (err instanceof Error && err.message.includes('authentication method')) {
      throw new HTTPException(503, { message: 'Agent is not configured (ANTHROPIC_API_KEY missing)' })
    }
    throw err
  }
})

shop.get('/sweeps', async (c) => {
  const merchant = await myShop(c)
  const rows = await sql<SweepRow[]>`
    select * from sweeps where merchant_id = ${merchant.id} order by created_at desc limit 20`
  return c.json(rows.map(serializeSweep))
})

async function mySweep(c: { get(key: 'wallet'): string; req: { param(name: 'id'): string } }) {
  const merchant = await myShop(c)
  const id = c.req.param('id')
  const sweep = isUuid(id) ? await getSweep(merchant, id) : null
  if (!sweep) throw new HTTPException(404, { message: 'Sweep not found' })
  return { merchant, sweep }
}

/** Brings a sweep up to date with the chain. The app calls this before signing and while confirming. */
shop.post('/sweeps/:id/check', async (c) => {
  const { merchant, sweep } = await mySweep(c)
  return c.json(serializeSweep(await settleSweep(merchant, sweep)))
})

/** The app calls this right before opening the wallet, with the blockhash's last valid block height. */
shop.post('/sweeps/:id/begin', async (c) => {
  const { merchant, sweep } = await mySweep(c)
  const input = await body(c, z.object({ lastValidBlockHeight: z.string().regex(/^\d{1,20}$/) }))
  try {
    return c.json(serializeSweep(await beginSweep(merchant, sweep.id, BigInt(input.lastValidBlockHeight))))
  } catch (err) {
    if (err instanceof SweepError) throw new HTTPException(409, { message: err.message })
    throw err
  }
})

/** The app calls this as soon as the wallet has signed and sent the sweep. */
shop.post('/sweeps/:id/submit', async (c) => {
  const { merchant, sweep } = await mySweep(c)
  const input = await body(c, z.object({ signature: z.string().refine(isSignature, 'Not a transaction signature') }))
  try {
    return c.json(serializeSweep(await submitSweep(merchant, sweep.id, input.signature as Signature)))
  } catch (err) {
    if (err instanceof SweepError) throw new HTTPException(400, { message: err.message })
    throw err
  }
})

shop.post('/sweeps/:id/cancel', async (c) => {
  const { sweep } = await mySweep(c)
  const [row] = await sql<SweepRow[]>`
    update sweeps set status = 'cancelled' where id = ${sweep.id} and status = 'proposed' returning *`
  if (!row) throw new HTTPException(400, { message: `Sweep is ${sweep.status}; only a proposal can be cancelled` })
  return c.json(serializeSweep(row))
})

app.route('/shop', shop)
