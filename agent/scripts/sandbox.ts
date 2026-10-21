/**
 * Browser sandbox: a local Solana chain with test USDC/PYUSD, a funded test customer, loyalty points,
 * a stand-in PayPal, and the real API on http://localhost:8787. Pair it with the web app
 * (`pnpm --filter @tilltide/seeker-app web:sandbox`) to click through the whole product.
 *
 * Nothing here touches devnet or mainnet. Sandbox-only routes live under /sandbox.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
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

function secretKeyBytes() {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  return new Uint8Array([...Buffer.from(jwk.d!, 'base64url'), ...Buffer.from(jwk.x!, 'base64url')])
}

const dir = mkdtempSync(join(tmpdir(), 'tilltide-sandbox-'))
const tokenAuthority = await generateKeyPairSigner()
console.log('Starting local Solana validator…')
const { rpc, stop } = await startLocalValidator({ port: RPC_PORT, ledgerDir: join(dir, 'ledger'), tokenAuthority: tokenAuthority.address })
process.on('SIGINT', () => (stop(), process.exit(0)))
process.on('SIGTERM', () => (stop(), process.exit(0)))

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
  AUTH_DOMAIN: 'sandbox.tilltide.test',
  PUBLIC_URL: `http://localhost:${API_PORT}`,
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

/** The test customer pays a Solana Pay URL, exactly as a wallet would (transferChecked + reference). */
app.post('/sandbox/pay', async (c) => {
  const { url, amount } = await c.req.json<{ url: string; amount?: string }>()
  try {
    // Transaction request (points sale): do what a wallet does — fetch the transaction, sign, send.
    const link = decodeURIComponent(url.slice('solana:'.length))
    if (/^https?:\/\//.test(link)) {
      const res = await (await fetch(link, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: customer.address }) })).json()
      if (!res.transaction) return c.json({ error: res.error ?? 'No transaction returned' }, 400)
      const tx = getTransactionDecoder().decode(Buffer.from(res.transaction, 'base64'))
      const signed = await signTransaction([customer.keyPair], tx)
      await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
      return c.json({ ok: true, message: res.message })
    }
    const req = parseTransferRequest(url)
    const mint = req.splToken!
    const program = mint === PYUSD ? TOKEN_2022 : TOKEN
    const transfer = getTransferCheckedInstruction(
      {
        source: await ata(customer.address, mint, program),
        mint,
        destination: await ata(req.recipient, mint, program),
        authority: customer,
        amount: toBaseUnits(amount ?? req.amount!, 6),
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
  const tracking = new URL(url).searchParams.get('tracking')
  if (!tracking) return c.json({ error: 'Not an onboarding link' }, 400)
  paypal.completeOnboarding(tracking, `SANDBOX-${tracking.slice(0, 8).toUpperCase()}`)
  await fetch(`http://localhost:${API_PORT}/paypal/onboarded?merchantId=${tracking}`)
  return c.json({ ok: true })
})

/** The customer approves a PayPal checkout (the stand-in PayPal then lets the API capture it). */
app.post('/sandbox/paypal/approve', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  const orderId = new URL(url).searchParams.get('token')
  if (!orderId || !paypal.order(orderId)) return c.json({ error: 'Unknown PayPal order' }, 400)
  paypal.approve(orderId)
  return c.json({ ok: true })
})

startWatcher()
serve({ fetch: app.fetch, port: API_PORT }, () => {
  console.log(`\nTilltide sandbox ready`)
  console.log(`  API          http://localhost:${API_PORT}`)
  console.log(`  Solana RPC   http://127.0.0.1:${RPC_PORT} (local validator)`)
  console.log(`  Customer     ${customer.address} (1000 USDC, 1000 PYUSD)`)
  console.log(`  Owner wallet ${owner.address}`)
  console.log(`  Agent chat   ${process.env.ANTHROPIC_API_KEY ? 'on' : 'off (set ANTHROPIC_API_KEY to enable)'}`)
})
