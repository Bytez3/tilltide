/** A local Solana chain with test-controlled USDC/PYUSD mints, plus a stand-in PayPal. Used by the e2e suite and the browser sandbox. */
import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { address, createSolanaRpc, getAddressEncoder, type Address } from '@solana/kit'

export const USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
export const PYUSD = address('CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM')
export const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const TOKEN_2022 = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(500)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** Copies a real devnet mint and swaps in our own mint authority. */
export function mintAccountFile(dir: string, mint: Address, authority: Address): string {
  const raw = JSON.parse(execFileSync('solana', ['account', mint, '-u', 'devnet', '--output', 'json'], { encoding: 'utf8' }))
  const data = Buffer.from(raw.account.data[0], 'base64')
  data.writeUInt32LE(1, 0) // COption::Some
  Buffer.from(getAddressEncoder().encode(authority)).copy(data, 4)
  raw.account.data = [data.toString('base64'), 'base64']
  raw.account.rentEpoch = 0 // u64::MAX doesn't survive JSON.parse
  const file = join(dir, `${mint}.json`)
  writeFileSync(file, JSON.stringify(raw))
  return file
}

/** In-process stand-in for PayPal Orders v2. `approve(id)` is the customer approving; `holdForReview` makes the next capture PENDING. */
export function startMockPayPal(port: number) {
  const orders = new Map<string, any>()
  let n = 0
  const state = {
    holdForReview: false,
    captures: 0,
    refundCalls: 0,
    failNextRefund: false, // 503 before anything happens
    loseNextResponse: false, // refund happens, then the response is lost (503)
    rejectNextRefund: false, // 422 and nothing happens
    pendingRefunds: false, // new refunds start PENDING
  }
  const refundsByRequestId = new Map<string, any>()
  // Partner onboarding: tracking id (our merchant id) -> PayPal merchant id once "completed".
  const onboarded = new Map<string, string>()
  const refundHeaders: Record<string, string | undefined>[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
    }
    const url = new URL(req.url!, 'http://x')
    if (url.pathname === '/v1/oauth2/token') return send(200, { access_token: 'mock', expires_in: 3600 })
    if (req.method === 'POST' && url.pathname === '/v2/customer/partner-referrals') {
      const input = JSON.parse(body)
      return send(201, { links: [{ rel: 'action_url', href: `https://sandbox.paypal.test/onboard?tracking=${input.tracking_id}&return=${encodeURIComponent(input.partner_config_override.return_url)}` }] })
    }
    const integration = url.pathname.match(/^\/v1\/customer\/partners\/([^/]+)\/merchant-integrations$/)
    if (req.method === 'GET' && integration) {
      const merchantId = onboarded.get(url.searchParams.get('tracking_id') ?? '')
      return merchantId
        ? send(200, { merchant_id: merchantId, tracking_id: url.searchParams.get('tracking_id'), payments_receivable: true, primary_email_confirmed: true })
        : send(404, { message: 'not found' })
    }
    if (req.method === 'POST' && url.pathname === '/v2/checkout/orders') {
      const input = JSON.parse(body)
      const id = `ORDER${++n}`
      const order = {
        id,
        status: 'PAYER_ACTION_REQUIRED',
        purchase_units: input.purchase_units,
        bnCode: req.headers['paypal-partner-attribution-id'],
        links: [{ rel: 'payer-action', href: `https://sandbox.paypal.test/checkoutnow?token=${id}` }],
      }
      orders.set(id, order)
      return send(201, order)
    }
    const refundMatch = url.pathname.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/)
    if (req.method === 'POST' && refundMatch) {
      state.refundCalls++
      refundHeaders.push({ assertion: req.headers['paypal-auth-assertion'] as string | undefined })
      if (state.failNextRefund) {
        state.failNextRefund = false
        return send(503, { message: 'Service unavailable' })
      }
      if (state.rejectNextRefund) {
        state.rejectNextRefund = false
        return send(422, { message: 'Unprocessable', details: [{ issue: 'TRANSACTION_REFUSED' }] })
      }
      // Real PayPal returns the original refund for a repeated PayPal-Request-Id.
      const requestId = String(req.headers['paypal-request-id'])
      if (!refundsByRequestId.has(requestId)) {
        const capture = refundMatch[1]!
        const amount = JSON.parse(body).amount
        const order = [...orders.values()].find((o) => o.purchase_units[0].payments?.captures?.[0]?.id === capture)
        const already = [...refundsByRequestId.values()].filter((r) => r.capture === capture).reduce((t, r) => t + Number(r.amount.value), 0)
        if (already + Number(amount.value) > Number(order.purchase_units[0].amount.value) + 1e-9) {
          return send(422, { message: 'Refund exceeds captured amount', details: [{ issue: 'REFUND_AMOUNT_EXCEEDED' }] })
        }
        refundsByRequestId.set(requestId, { id: `REFUND${refundsByRequestId.size + 1}`, status: state.pendingRefunds ? 'PENDING' : 'COMPLETED', amount, capture })
      }
      if (state.loseNextResponse) {
        state.loseNextResponse = false
        return send(503, { message: 'Gateway timeout' })
      }
      return send(201, refundsByRequestId.get(requestId))
    }
    const refundGet = url.pathname.match(/^\/v2\/payments\/refunds\/([^/]+)$/)
    if (req.method === 'GET' && refundGet) {
      const r = [...refundsByRequestId.values()].find((x) => x.id === refundGet[1])
      return r ? send(200, r) : send(404, { message: 'not found' })
    }
    const m = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/)
    const order = m && orders.get(m[1]!)
    if (!order) return send(404, { message: 'not found' })
    if (m![2]) {
      if (order.status === 'COMPLETED') return send(422, { message: 'Already captured', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] })
      if (order.status !== 'APPROVED') return send(422, { message: 'Not approved', details: [{ issue: 'ORDER_NOT_APPROVED' }] })
      state.captures++
      order.status = 'COMPLETED'
      order.payer = { payer_id: 'BUYER1' }
      const status = state.holdForReview ? 'PENDING' : 'COMPLETED'
      order.purchase_units[0].payments = { captures: [{ id: `CAP-${order.id}`, status, amount: order.purchase_units[0].amount }] }
    }
    return send(200, order)
  })
  server.listen(port)
  return {
    state,
    approve: (id: string) => (orders.get(id).status = 'APPROVED'),
    releaseReview: (id: string) => (orders.get(id).purchase_units[0].payments.captures[0].status = 'COMPLETED'),
    order: (id: string) => orders.get(id),
    refunds: () => [...refundsByRequestId.values()],
    refundHeaders: () => refundHeaders,
    /** The owner finishes PayPal onboarding for this tracking id. */
    completeOnboarding: (trackingId: string, merchantId: string) => onboarded.set(trackingId, merchantId),
    completePendingRefunds: () => {
      for (const r of refundsByRequestId.values()) if (r.status === 'PENDING') r.status = 'COMPLETED'
    },
    close: () => server.close(),
  }
}


/** Starts solana-test-validator with copies of devnet USDC and PYUSD whose mint authority is `tokenAuthority`. */
export async function startLocalValidator(opts: { port: number; ledgerDir: string; tokenAuthority: Address; verbose?: boolean }) {
  const dir = opts.ledgerDir + '-accounts'
  execFileSync('mkdir', ['-p', dir])
  const validator = spawn(
    'solana-test-validator',
    [
      '--reset', '--quiet', '--ledger', opts.ledgerDir, '--rpc-port', String(opts.port),
      '--faucet-port', String(opts.port + 1000), '--gossip-port', String(opts.port + 2000),
      '--dynamic-port-range', `${opts.port + 3000}-${opts.port + 3100}`,
      '--account', USDC, mintAccountFile(dir, USDC, opts.tokenAuthority),
      '--account', PYUSD, mintAccountFile(dir, PYUSD, opts.tokenAuthority),
    ],
    { stdio: opts.verbose ? 'inherit' : 'ignore' },
  )
  let exited: string | null = null
  validator.on('exit', (code) => (exited = `solana-test-validator exited with code ${code}`))
  const rpc = createSolanaRpc(`http://127.0.0.1:${opts.port}`)
  await until(
    'validator',
    () => {
      if (exited) throw new Error(`${exited} (rerun with E2E_VERBOSE=1)`)
      return rpc.getHealth().send().then((h) => h === 'ok').catch(() => false)
    },
    60_000,
  )
  return { rpc, stop: () => validator.kill('SIGINT') }
}
