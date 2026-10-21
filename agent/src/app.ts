import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { address, isAddress, isSignature, type Signature } from '@solana/kit'
import { fromBaseUnits, toBaseUnits } from '@tilltide/agent-pay-kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { runAgent } from './agent'
import { buildRedeemTransaction, RedeemError } from './services/redeem'
import { renderReceipt } from './receipt'
import { clientIp, rateLimit, requireOrigin } from './rate-limit'
import { reserveAgentRequest, UsageLimitError } from './services/usage'
import { AuthError, createNonce, createStaffInvite, redeemStaffInvite, revokeToken, sessionForToken, verifySignIn, type Session } from './auth'
import { config } from './config'
import { isDate } from './dates'
import { FxError } from './fx'
import { LEDGER_DECIMALS, sql, type MerchantRow, type PaymentRow, type RefundRow, type SweepRow } from './db'
import { merchantToken } from './services/merchants'
import { checkPayPalPayment, createPayment, createPayPalPayment, getPayment, PayPalSaleError, serializePayment } from './services/payments'
import { OnboardingError, refreshPayPalConnection, startPayPalOnboarding } from './services/paypal-onboarding'
import { PayPalError } from './paypal'
import { approveRefund, getRefund, proposeRefund, refundChallenge, RefundError, serializeRefund } from './services/refunds'
import { getDailySummary, reconcileDay, todayIn } from './services/summary'
import { listReports, writeDailyReport } from './services/reports'
import { createExportToken, exportCsv, redeemExportToken } from './services/export'
import { beginSweep, getSweep, proposeSweep, serializeSweep, settleSweep, submitSweep, SweepError, tillBalance } from './services/sweeps'
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
    currency: m.currency,
    closeTime: m.closeTime,
    cluster: config.cluster,
    pointsMint: config.pointsMint,
    paypalEnabled: Boolean(config.paypal),
    pointValue: fromBaseUnits(m.pointValue, LEDGER_DECIMALS),
    redeemMaxPercent: m.redeemMaxPercent,
    paypal: {
      status: m.paypalStatus,
      email: m.paypalEmail,
      /** Connect-with-PayPal onboarding is available (Tilltide is set up as a PayPal platform). */
      onboardingAvailable: Boolean(config.paypal && config.paypalPlatform.partnerMerchantId),
      /** PayPal sales are refused until the shop connects its PayPal (always in live mode). */
      required: config.paypalPlatform.requireConnected,
      feePercent: config.paypalPlatform.feeBps / 100,
    },
  }
}

export const app = new Hono()

if (config.corsOrigins.length) {
  app.use(cors({ origin: config.corsOrigins, allowHeaders: ['content-type', 'authorization'], allowMethods: ['GET', 'POST', 'PATCH'] }))
}
app.use(requireOrigin(config.originSecret))
const ip = (c: Context) => clientIp(c, Boolean(config.originSecret))
app.use(secureHeaders())
// Every request body here is small JSON; refuse anything big before parsing it.
app.use(bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'Request too large' }, 413) }))
app.use('*', rateLimit({ name: 'ip', windowMs: 60_000, max: config.rateLimits.perIp, key: ip }))
app.use('/auth/*', rateLimit({ name: 'auth', windowMs: 60_000, max: config.rateLimits.auth, key: ip }))

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

/**
 * PayPal sends the owner here after onboarding. The query string is only a hint: the connection is
 * confirmed by asking PayPal directly.
 */
app.get('/paypal/onboarded', async (c) => {
  const trackingId = c.req.query('merchantId') ?? ''
  const merchant = isUuid(trackingId) ? await refreshPayPalConnection(trackingId).catch(() => null) : null
  return merchant?.paypalStatus === 'connected'
    ? c.html(page('PayPal connected ✓', 'Go back to Tilltide. PayPal sales now go to your PayPal account.'))
    : c.html(page('Almost there', 'PayPal is still setting up your account. Go back to Tilltide and tap "Check PayPal" in a moment.'))
})

app.get('/paypal/cancel', (c) => c.html(page('Payment cancelled', 'No money was taken.')))

// ---- Solana Pay transaction request (public: the customer's wallet calls these) -------------------
app.get('/pay/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = isUuid(id) ? await sql<{ name: string }[]>`
    select m.name from payments p join merchants m on m.id = p.merchant_id where p.id = ${id}` : []
  if (!row) throw new HTTPException(404, { message: 'Payment not found' })
  return c.json({ label: row.name, icon: `${config.publicUrl}/favicon.png` })
})

app.post('/pay/:id', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) throw new HTTPException(404, { message: 'Payment not found' })
  const input = await body(c, z.object({ account: wallet }))
  try {
    return c.json(await buildRedeemTransaction(id, input.account))
  } catch (err) {
    if (err instanceof RedeemError) throw new HTTPException(400, { message: err.message })
    throw err
  }
})

/** CSV download via a one-time token from POST /shop/export. */
app.get('/export/:file', async (c) => {
  const token = c.req.param('file').replace(/\.csv$/, '')
  const grant = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await redeemExportToken(token) : null
  if (!grant) throw new HTTPException(404, { message: 'This download link has expired. Make a new one in the app.' })
  const [merchant] = await sql<MerchantRow[]>`select * from merchants where id = ${grant.merchantId}`
  const from = grant.fromDay.toISOString().slice(0, 10)
  const to = grant.toDay.toISOString().slice(0, 10)
  const csv = await exportCsv(merchant!, from, to)
  return c.body(csv, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="tilltide-${from}-to-${to}.csv"`,
    'cache-control': 'no-store',
  })
})

/** Public customer receipt (the till shows it as a QR after a sale). */
app.get('/r/:id', async (c) => {
  const id = c.req.param('id')
  const receipt = isUuid(id) ? await renderReceipt(id) : null
  if (!receipt) return c.html(page('Receipt not found', 'Ask the shop to show the receipt again.'), 404)
  return c.html(receipt)
})

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

/** A staff till device pairs with a shop using the owner's one-time code. */
app.post('/auth/staff', async (c) => {
  const input = await body(c, z.object({ code: z.string().max(20) }))
  try {
    const { token, label } = await redeemStaffInvite(input.code)
    return c.json({ token, label })
  } catch (err) {
    if (err instanceof AuthError) throw new HTTPException(401, { message: err.message })
    throw err
  }
})

// ---- The signed-in shop ---------------------------------------------------------------
// Everything under /shop is scoped to the wallet that signed in. There is no way to name another shop.

type ShopEnv = { Variables: { wallet: string; token: string; session: Session } }

/**
 * What a staff device may do: take and follow payments, see today's summary. Everything else
 * (money movement, refunds, settings, the agent) is owner-only. Default deny: new routes are owner-only.
 */
const STAFF_ALLOWED: [string, RegExp][] = [
  ['GET', /^\/shop\/?$/],
  ['POST', /^\/shop\/payments$/],
  ['GET', /^\/shop\/payments(\/[^/]+)?$/],
  ['GET', /^\/shop\/summary$/],
  ['POST', /^\/shop\/logout$/],
]
const shop = new Hono<ShopEnv>()

shop.use(async (c, next) => {
  const token = c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{20,100})$/)?.[1]
  const session = token ? await sessionForToken(token) : null
  if (!session || !token) throw new HTTPException(401, { message: 'Sign in again' })
  if (session.role === 'staff' && !STAFF_ALLOWED.some(([m, re]) => m === c.req.method && re.test(c.req.path))) {
    throw new HTTPException(403, { message: 'Only the shop owner can do this' })
  }
  c.set('session', session)
  c.set('wallet', session.wallet ?? '')
  c.set('token', token)
  await next()
})

shop.post('/logout', async (c) => {
  await revokeToken(c.get('token'))
  return c.json({ ok: true })
})

async function myShop(c: { get(key: 'session'): Session }): Promise<MerchantRow> {
  const session = c.get('session')
  const [merchant] =
    session.role === 'staff'
      ? await sql<MerchantRow[]>`select * from merchants where id = ${session.merchantId}`
      : await sql<MerchantRow[]>`select * from merchants where wallet = ${session.wallet}`
  if (!merchant) throw new HTTPException(404, { message: 'No shop for this wallet yet' })
  return merchant
}

shop.get('/', async (c) => {
  const session = c.get('session')
  return c.json({ ...serializeMerchant(await myShop(c)), role: session.role, staffLabel: session.label })
})

/** Owner: create a pairing code for a staff till device. */
shop.post('/staff/invites', async (c) => {
  const merchant = await myShop(c)
  const input = await body(c, z.object({ label: z.string().trim().min(1).max(40) }))
  return c.json(await createStaffInvite(merchant.id, input.label), 201)
})

/** Owner: staff devices currently signed in. */
shop.get('/staff', async (c) => {
  const merchant = await myShop(c)
  const rows = await sql<{ id: string; label: string; createdAt: Date }[]>`
    select id, label, created_at from sessions
    where role = 'staff' and merchant_id = ${merchant.id} and expires_at > now() order by created_at`
  return c.json(rows.map((r) => ({ id: r.id, label: r.label, since: r.createdAt.toISOString() })))
})

/** Owner: sign a staff device out, immediately. */
shop.post('/staff/:id/remove', async (c) => {
  const merchant = await myShop(c)
  const id = c.req.param('id')
  if (!isUuid(id)) throw new HTTPException(404, { message: 'Staff device not found' })
  const rows = await sql`delete from sessions where id = ${id} and role = 'staff' and merchant_id = ${merchant.id} returning id`
  if (!rows.length) throw new HTTPException(404, { message: 'Staff device not found' })
  return c.json({ ok: true })
})

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
      /** What one point is worth when spent, e.g. "0.01". */
      pointValue: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
      redeemMaxPercent: z.number().int().min(0).max(90).optional(),
      currency: z.enum(['GBP', 'USD', 'EUR']).optional(),
      /** Without PayPal onboarding: the PayPal email PayPal sales are paid to. */
      paypalEmail: z.email().max(254).nullable().optional(),
      timezone: timezone.optional(),
      /** Local closing time for the end-of-day report, HH:MM. */
      closeTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
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
      point_value = ${input.pointValue !== undefined ? toBaseUnits(input.pointValue, LEDGER_DECIMALS).toString() : merchant.pointValue.toString()},
      redeem_max_percent = ${input.redeemMaxPercent ?? merchant.redeemMaxPercent},
      paypal_email = ${input.paypalEmail === undefined ? merchant.paypalEmail : input.paypalEmail},
      currency = ${input.currency ?? merchant.currency},
      close_time = ${input.closeTime ?? merchant.closeTime},
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
      /** Let the customer pay part of the bill with loyalty points. */
      usePoints: z.boolean().default(false),
      /** PayPal customer's loyalty code from an earlier receipt: spends their points on this bill. */
      loyaltyCode: z.string().max(20).optional(),
    }),
  )
  if (input.usePoints && (input.rail !== 'solana' || !config.pointsMint)) {
    throw new HTTPException(400, { message: 'Points can only be used on wallet payments, with points set up' })
  }
  let amount: bigint
  try {
    // Prices are in the shop's currency, in whole pence/cents on every rail.
    amount = toBaseUnits(input.amount, 2) * 10n ** BigInt(LEDGER_DECIMALS - 2)
  } catch (err) {
    throw new HTTPException(400, { message: (err as Error).message })
  }
  if (amount <= 0n) throw new HTTPException(400, { message: 'Amount must be more than zero' })
  if (amount > 1_000_000n * 10n ** BigInt(LEDGER_DECIMALS)) throw new HTTPException(400, { message: 'Amount is too large' })
  if (input.rail === 'paypal') {
    if (!config.paypal) throw new HTTPException(400, { message: 'PayPal is not set up on the server' })
    try {
      const { payment, url } = await createPayPalPayment(merchant, amount, input.label, input.loyaltyCode || undefined)
      return c.json({ ...serializePayment(payment), url }, 201)
    } catch (err) {
      if (err instanceof PayPalSaleError) throw new HTTPException(400, { message: err.message })
      throw new HTTPException(502, { message: `PayPal: ${(err as Error).message}` })
    }
  }
  try {
    const { payment, url } = await createPayment(merchant, amount, input.label, input.usePoints)
    return c.json({ ...serializePayment(payment), url }, 201)
  } catch (err) {
    if (err instanceof FxError) throw new HTTPException(503, { message: err.message })
    throw err
  }
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

/** End-of-day reports, newest first. */
shop.get('/reports', async (c) => c.json(await listReports(await myShop(c))))

/** Write (or rewrite) the end-of-day report for a day now. */
shop.post('/reports', async (c) => {
  const merchant = await myShop(c)
  const input = await body(c, z.object({ date: z.string().optional() }))
  const date = input.date ?? todayIn(merchant.timezone)
  if (!isDate(date)) throw new HTTPException(400, { message: 'date must be YYYY-MM-DD' })
  const report = await writeDailyReport(merchant, date)
  return c.json({ date: report.date, text: report.text, narrative: report.narrative, createdAt: report.createdAt })
})

/** A one-time link to download sales, refunds and sweeps as CSV (the session token never goes in a URL). */
shop.post('/export', async (c) => {
  const merchant = await myShop(c)
  const input = await body(c, z.object({ from: z.string(), to: z.string() }))
  if (!isDate(input.from) || !isDate(input.to) || input.from > input.to) throw new HTTPException(400, { message: 'Use from/to dates YYYY-MM-DD, from on or before to' })
  if ((Date.parse(input.to) - Date.parse(input.from)) / 86_400_000 > 366) throw new HTTPException(400, { message: 'Export at most a year at a time' })
  const token = await createExportToken(merchant, input.from, input.to)
  return c.json({ url: `${config.publicUrl}/export/${token}.csv`, expiresInMinutes: 5 })
})

/** Starts Connect-with-PayPal: returns PayPal's onboarding link for the owner to open. */
shop.post('/paypal/connect', async (c) => {
  const merchant = await myShop(c)
  try {
    return c.json({ url: await startPayPalOnboarding(merchant) })
  } catch (err) {
    if (err instanceof OnboardingError) throw new HTTPException(409, { message: err.message })
    if (err instanceof PayPalError) throw new HTTPException(502, { message: `PayPal: ${err.message}` })
    throw err
  }
})

/** Re-checks the PayPal connection with PayPal (after the owner finishes onboarding). */
shop.post('/paypal/refresh', async (c) => {
  const merchant = await myShop(c)
  return c.json(serializeMerchant((await refreshPayPalConnection(merchant.id)) ?? merchant))
})

/** What the till holds right now, for pre-filling a sweep. */
shop.get('/till', async (c) => {
  const merchant = await myShop(c)
  const token = merchantToken(merchant)
  const balance = await tillBalance(merchant)
  return c.json({ token: token.symbol, balance: balance.toString(), display: fromBaseUnits(balance, token.decimals) })
})

/** The owner proposes a sweep themselves (the agent can too). Still needs their wallet signature to move. */
shop.post('/sweeps', async (c) => {
  const merchant = await myShop(c)
  const input = await body(c, z.object({ amount: z.string().max(20), reason: z.string().max(200).optional() }))
  let amount: bigint
  try {
    amount = toBaseUnits(input.amount, merchantToken(merchant).decimals)
  } catch (err) {
    throw new HTTPException(400, { message: (err as Error).message })
  }
  try {
    return c.json(serializeSweep(await proposeSweep(merchant, amount, input.reason ?? null)), 201)
  } catch (err) {
    if (err instanceof SweepError) throw new HTTPException(409, { message: err.message })
    throw err
  }
})

async function mySweep(c: { get(key: 'session'): Session; req: { param(name: 'id'): string } }) {
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

/** The owner starts a PayPal refund themselves (the agent can too). Still needs their wallet signature. */
shop.post('/payments/:id/refunds', async (c) => {
  const merchant = await myShop(c)
  const id = c.req.param('id')
  if (!isUuid(id)) throw new HTTPException(404, { message: 'Payment not found' })
  const input = await body(c, z.object({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(), reason: z.string().max(200).optional() }))
  try {
    const refund = await proposeRefund(merchant, id, input.amount ? toBaseUnits(input.amount, LEDGER_DECIMALS) : null, input.reason ?? null)
    return c.json(serializeRefund(refund), 201)
  } catch (err) {
    if (err instanceof RefundError) throw new HTTPException(409, { message: err.message })
    throw err
  }
})

shop.get('/refunds', async (c) => {
  const merchant = await myShop(c)
  const rows = await sql<RefundRow[]>`
    select * from refunds where merchant_id = ${merchant.id} order by created_at desc limit 20`
  return c.json(rows.map(serializeRefund))
})

async function myRefund(c: { get(key: 'session'): Session; req: { param(name: 'id'): string } }) {
  const merchant = await myShop(c)
  const id = c.req.param('id')
  const refund = isUuid(id) ? await getRefund(merchant, id) : null
  if (!refund) throw new HTTPException(404, { message: 'Refund not found' })
  return { merchant, refund }
}

shop.get('/refunds/:id', async (c) => c.json(serializeRefund((await myRefund(c)).refund)))

/** A single-use message for the owner's wallet to sign, naming this refund and its amount. */
shop.post('/refunds/:id/challenge', async (c) => {
  const { merchant, refund } = await myRefund(c)
  try {
    return c.json(await refundChallenge(merchant, refund))
  } catch (err) {
    if (err instanceof RefundError) throw new HTTPException(409, { message: err.message })
    throw err
  }
})

/** Approve with the signed challenge. Also retries a refund stuck in 'processing' (idempotently). */
shop.post('/refunds/:id/approve', async (c) => {
  const { merchant, refund } = await myRefund(c)
  const input = await body(c, z.object({ signedMessage: z.base64().max(4000).optional(), signature: z.base64().max(200).optional() }))
  try {
    const signed =
      input.signedMessage && input.signature
        ? { signedMessage: new Uint8Array(Buffer.from(input.signedMessage, 'base64')), signature: new Uint8Array(Buffer.from(input.signature, 'base64')) }
        : null
    return c.json(serializeRefund(await approveRefund(merchant, refund, signed)))
  } catch (err) {
    if (err instanceof RefundError) throw new HTTPException(409, { message: err.message })
    throw err
  }
})

shop.post('/refunds/:id/cancel', async (c) => {
  const { refund } = await myRefund(c)
  const [row] = await sql<RefundRow[]>`
    update refunds set status = 'cancelled', approval_nonce = null where id = ${refund.id} and status = 'proposed' returning *`
  if (!row) throw new HTTPException(409, { message: `Refund is ${refund.status}; only a proposal can be cancelled` })
  return c.json(serializeRefund(row))
})

app.route('/shop', shop)
