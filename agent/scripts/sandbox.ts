/**
 * Browser sandbox: a local Solana chain with test USDC/PYUSD, a funded test customer, loyalty points,
 * a stand-in PayPal, and the real API on http://localhost:8787. Pair it with the web app
 * (`pnpm --filter @tilltide/seeker-app web:sandbox`) to click through the whole product.
 *
 * Nothing here touches devnet or mainnet. Sandbox-only routes live under /sandbox.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import {
  AccountRole,
  address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  isAddress,
  signTransaction,
  lamports,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token'
import { getCreateAccountInstruction } from '@solana-program/system'
import postgres from 'postgres'
import { PYUSD, startLocalValidator, startMockPayPal, TOKEN, TOKEN_2022, until, USDC } from '../test/support/local-chain'

const RPC_PORT = 28899
const API_PORT = Number(process.env.PORT ?? 8787)
const PAYPAL_PORT = 28799
const ADMIN_DB = process.env.SANDBOX_ADMIN_DATABASE_URL ?? 'postgres://tilltide:tilltide@localhost:5432/tilltide'
const DB = 'tilltide_sandbox'
/** Set for the hosted judge demo, e.g. https://demo.tilltide.bytez3.com. Unset for the local sandbox. */
const PUBLIC = process.env.SANDBOX_PUBLIC_URL?.replace(/\/$/, '') || undefined
/** Folder with the exported web app (`expo export -p web`), served at / by the hosted demo. */
const WEB_DIR = process.env.SANDBOX_WEB_DIR

function secretKeyBytes() {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  return new Uint8Array([...Buffer.from(jwk.d!, 'base64url'), ...Buffer.from(jwk.x!, 'base64url')])
}

const dir = mkdtempSync(join(tmpdir(), 'tilltide-sandbox-'))
const tokenAuthority = await generateKeyPairSigner()
console.log('Starting local Solana validator…')
const { rpc, stop } = await startLocalValidator({ port: RPC_PORT, ledgerDir: join(dir, 'ledger'), tokenAuthority: tokenAuthority.address, exitWithValidator: true })
const shutdown = () => {
  stop()
  // Ledgers grow to gigabytes and /tmp is often in memory: remove it on the way out.
  setTimeout(() => (rmSync(dir, { recursive: true, force: true }), process.exit(0)), 1500)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

const admin = postgres(ADMIN_DB, { onnotice: () => {} })
await admin.unsafe(`drop database if exists ${DB} with (force)`)
await admin.unsafe(`create database ${DB}`)
await admin.end()

const pointsAuthorityBytes = secretKeyBytes()
const pointsAuthority = await createKeyPairSignerFromBytes(pointsAuthorityBytes)
const customer = await generateKeyPairSigner()
const owner = await generateKeyPairSigner()
const treasury = await generateKeyPairSigner()
const pointsMint = await generateKeyPairSigner()

async function airdrop(to: Address, sol = 10n) {
  await rpc.requestAirdrop(to, lamports(sol * 1_000_000_000n)).send()
  await until('airdrop', async () => (await rpc.getBalance(to).send()).value > 0n)
}
for (const w of [tokenAuthority, pointsAuthority, customer]) await airdrop(w.address)

Object.assign(process.env, {
  DATABASE_URL: `${ADMIN_DB.replace(/\/[^/]*$/, `/${DB}`)}`,
  SOLANA_CLUSTER: 'devnet',
  SOLANA_RPC_URL: `http://127.0.0.1:${RPC_PORT}`,
  PORT: String(API_PORT),
  // A hosted demo (SANDBOX_PUBLIC_URL) serves the web app from the same origin as the API.
  AUTH_DOMAIN: PUBLIC ? new URL(PUBLIC).host : 'sandbox.tilltide.test',
  PUBLIC_URL: PUBLIC ?? `http://localhost:${API_PORT}`,
  CORS_ORIGINS: process.env.CORS_ORIGINS ?? 'http://localhost:8081,http://127.0.0.1:8081',
  POINTS_MINT: pointsMint.address,
  POINTS_AUTHORITY_SECRET: JSON.stringify([...pointsAuthorityBytes]),
  TREASURY_WALLET: treasury.address,
  SWEEP_FEE_BPS: '50',
  PAYPAL_PARTNER_MERCHANT_ID: 'TILLTIDE-SANDBOX-PARTNER',
  PAYPAL_REQUIRE_CONNECTED: 'true',
  PAYPAL_FEE_BPS: '50',
  PAYPAL_CLIENT_ID: 'sandbox',
  PAYPAL_CLIENT_SECRET: 'sandbox',
  PAYPAL_API_BASE: `http://127.0.0.1:${PAYPAL_PORT}`,
  WATCH_INTERVAL_MS: '1000',
  // Seeker tokens only exist on mainnet; the sandbox customer stands in for a Seeker owner.
  SEEKER_TEST_WALLETS: customer.address,
})
const paypal = startMockPayPal(PAYPAL_PORT)

const { sendAndConfirm } = await import('../src/solana')
const ata = async (o: Address, mint: Address, program: Address) => (await findAssociatedTokenPda({ owner: o, mint, tokenProgram: program }))[0]
async function send(feePayer: KeyPairSigner, instructions: Instruction[]) {
  return sendAndConfirm(feePayer, instructions)
}

// Points mint and test money for the customer.
const space = BigInt(getMintSize())
await send(pointsAuthority, [
  getCreateAccountInstruction({
    payer: pointsAuthority,
    newAccount: pointsMint,
    lamports: await rpc.getMinimumBalanceForRentExemption(space).send(),
    space,
    programAddress: TOKEN,
  }),
  getInitializeMintInstruction({ mint: pointsMint.address, decimals: 0, mintAuthority: pointsAuthority.address }),
])
for (const [mint, program] of [[USDC, TOKEN], [PYUSD, TOKEN_2022]] as const) {
  await send(tokenAuthority, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: tokenAuthority, owner: customer.address, mint, tokenProgram: program }),
    getMintToInstruction({ mint, token: await ata(customer.address, mint, program), mintAuthority: tokenAuthority, amount: 1_000_000_000n }, { programAddress: program }),
  ])
}

const { sql } = await import('../src/db')
const { readFile } = await import('node:fs/promises')
await sql.unsafe(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'))

const { app } = await import('../src/app')
const { startWatcher } = await import('../src/services/watcher')
const { parseTransferRequest, toBaseUnits, fromBaseUnits } = await import('@tilltide/agent-pay-kit')

const balance = async (o: Address, mint: Address, program: Address) =>
  rpc.getTokenAccountBalance(await ata(o, mint, program), { commitment: 'confirmed' }).send().then((r) => r.value.amount).catch(() => '0')

app.get('/sandbox', async (c) =>
  c.json({
    customer: customer.address,
    owner: owner.address,
    treasury: treasury.address,
    customerBalances: {
      USDC: fromBaseUnits(BigInt(await balance(customer.address, USDC, TOKEN)), 6),
      PYUSD: fromBaseUnits(BigInt(await balance(customer.address, PYUSD, TOKEN_2022)), 6),
    },
  }),
)

/** Gives a wallet (the browser test wallet) SOL for transaction fees. */
app.post('/sandbox/airdrop', async (c) => {
  const { address: to } = await c.req.json<{ address: string }>()
  if (!isAddress(to)) return c.json({ error: 'Not an address' }, 400)
  await airdrop(address(to), 2n)
  return c.json({ ok: true })
})

/** Largest single payment the test customer makes, so the shared balance can't be emptied in one go. */
const MAX_TEST_PAYMENT = 500_000_000n // 500 tokens
const TOP_UP = 1_000_000_000n // 1000 tokens

/** Keeps the shared test customer funded, so a busy day of judges (or a stranger) can't empty it. */
async function topUp(mint: Address, program: Address) {
  if (BigInt(await balance(customer.address, mint, program)) >= MAX_TEST_PAYMENT) return
  await send(tokenAuthority, [
    getMintToInstruction({ mint, token: await ata(customer.address, mint, program), mintAuthority: tokenAuthority, amount: TOP_UP }, { programAddress: program }),
  ])
}

/**
 * The test customer pays a Solana Pay URL, exactly as a wallet would (transferChecked + reference).
 * The hosted demo is public, so it only pays this server's own payment requests: a shop's open payment,
 * to that shop's till, for no more than it asked.
 */
app.post('/sandbox/pay', async (c) => {
  const { url, amount } = await c.req.json<{ url: string; amount?: string }>()
  try {
    // Transaction request (points sale): do what a wallet does — fetch the transaction, sign, send.
    const link = decodeURIComponent(url.slice('solana:'.length))
    if (/^https?:\/\//.test(link)) {
      if (!link.startsWith(`${process.env.PUBLIC_URL}/`)) return c.json({ error: 'Not one of this sandbox\'s payment links' }, 400)
      const res = await (await fetch(link, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: customer.address }) })).json()
      if (!res.transaction) return c.json({ error: res.error ?? 'No transaction returned' }, 400)
      const tx = getTransactionDecoder().decode(Buffer.from(res.transaction, 'base64'))
      const signed = await signTransaction([customer.keyPair], tx)
      await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
      return c.json({ ok: true, message: res.message })
    }
    const req = parseTransferRequest(url)
    const [open] = await sql<{ expected: bigint; till: string }[]>`
      select coalesce(p.token_amount, p.amount) as expected, m.wallet as till from payments p join merchants m on m.id = p.merchant_id
      where p.status = 'pending' and p.rail = 'solana' and p.reference = any(${req.references.map(String)})`
    if (!open || open.till !== req.recipient) return c.json({ error: 'No open payment request matches this link' }, 400)
    const pay = toBaseUnits(amount ?? req.amount!, 6)
    if (pay <= 0n || pay > BigInt(open.expected) || pay > MAX_TEST_PAYMENT) return c.json({ error: 'The test customer only pays up to the amount asked' }, 400)
    const mint = req.splToken!
    if (mint !== USDC && mint !== PYUSD) return c.json({ error: 'The test customer only holds USDC and PYUSD' }, 400)
    const program = mint === PYUSD ? TOKEN_2022 : TOKEN
    await topUp(mint, program)
    const transfer = getTransferCheckedInstruction(
      {
        source: await ata(customer.address, mint, program),
        mint,
        destination: await ata(req.recipient, mint, program),
        authority: customer,
        amount: pay,
        decimals: 6,
      },
      { programAddress: program },
    )
    const signature = await send(customer, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: customer, owner: req.recipient, mint, tokenProgram: program }),
      { ...transfer, accounts: [...transfer.accounts, ...req.references.map((r) => ({ address: r, role: AccountRole.READONLY }))] },
    ])
    return c.json({ ok: true, signature, customer: customer.address })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

/** The shop owner finishes PayPal onboarding (in real life this happens on paypal.com). */
app.post('/sandbox/paypal/onboard', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  const tracking = URL.canParse(url) ? new URL(url).searchParams.get('tracking') : null
  if (!tracking) return c.json({ error: 'Not an onboarding link' }, 400)
  paypal.completeOnboarding(tracking, `SANDBOX-${tracking.slice(0, 8).toUpperCase()}`)
  await fetch(`http://localhost:${API_PORT}/paypal/onboarded?merchantId=${encodeURIComponent(tracking)}`)
  return c.json({ ok: true })
})

/** The customer approves a PayPal checkout (the stand-in PayPal then lets the API capture it). */
app.post('/sandbox/paypal/approve', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  const orderId = URL.canParse(url) ? new URL(url).searchParams.get('token') : null
  if (!orderId || !paypal.order(orderId)) return c.json({ error: 'Unknown PayPal order' }, 400)
  paypal.approve(orderId)
  return c.json({ ok: true })
})

/**
 * The browser test wallet needs the chain, but the validator only listens on localhost. Pass through
 * just the calls a wallet makes, so the hosted demo doesn't expose the validator's admin methods.
 */
const RPC_METHODS = new Set(['getLatestBlockhash', 'sendTransaction'])
app.post('/sandbox/rpc', async (c) => {
  const body = await c.req.json().catch(() => null)
  // One call at a time, and a transaction is at most 1232 bytes (about 1.7 KB as base64).
  if (!body || Array.isArray(body) || !RPC_METHODS.has(body.method) || JSON.stringify(body).length > 4096) {
    return c.json({ error: 'Not allowed in the sandbox' }, 400)
  }
  const res = await fetch(`http://127.0.0.1:${RPC_PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return c.body(await res.text(), res.status as 200, { 'content-type': 'application/json' })
})

let root: { fetch: typeof app.fetch } = app
if (WEB_DIR) {
  const { Hono } = await import('hono')
  const { serveStatic } = await import('@hono/node-server/serve-static')
  const web = new Hono()
  // The app's screens and every exported file (bundles, icons, manifest); everything else is the API.
  const screens = new Set(['/', '/activity', '/agent', '/settings'])
  web.get('*', async (c, next) => (screens.has(c.req.path) ? serveStatic({ root: WEB_DIR, path: 'index.html' })(c, next) : next()))
  web.get('*', serveStatic({ root: WEB_DIR }))
  web.route('/', app)
  root = web
}

startWatcher()
serve({ fetch: root.fetch, port: API_PORT }, () => {
  console.log(`\nTilltide sandbox ready`)
  console.log(`  API          ${PUBLIC ?? `http://localhost:${API_PORT}`}${WEB_DIR ? ' (and the web app)' : ''}`)
  console.log(`  Solana RPC   http://127.0.0.1:${RPC_PORT} (local validator)`)
  console.log(`  Customer     ${customer.address} (1000 USDC, 1000 PYUSD)`)
  console.log(`  Owner wallet ${owner.address}`)
  console.log(`  Agent chat   ${process.env.ANTHROPIC_API_KEY ? 'on' : 'off (set ANTHROPIC_API_KEY to enable)'}`)
})
