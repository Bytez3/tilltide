/**
 * End-to-end test against a real local Solana validator and Postgres.
 *
 * Loads copies of the devnet USDC and PYUSD mints whose mint authority we control, then drives
 * the real API: payment request → customer pays with the Solana Pay reference → watcher marks it
 * paid → points minted → reconciliation → sweep signed by the till (as MWA would) → confirmed.
 *
 *   pnpm --filter @tilltide/agent e2e
 *
 * Needs: solana-test-validator on PATH, Postgres at E2E_DATABASE_URL (default: the docker one).
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import {
  AccountRole,
  address,
  createSolanaRpc,
  generateKeyPairSigner,
  getAddressEncoder,
  lamports,
  signBytes,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token'

const RPC_PORT = 18899
const API_PORT = 18787
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`
const API = `http://127.0.0.1:${API_PORT}`
const ADMIN_DB = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://tilltide:tilltide@localhost:5432/tilltide'
const E2E_DB = 'tilltide_e2e'

const USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const PYUSD = address('CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM')
const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022 = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

let passed = 0
async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`• ${name} … `)
  await fn()
  passed++
  console.log('ok')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(500)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** Copies a real devnet mint and swaps in our own mint authority. */
function mintAccountFile(dir: string, mint: Address, authority: Address): string {
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
function startMockPayPal(port: number) {
  const orders = new Map<string, any>()
  let n = 0
  const state = { holdForReview: false, captures: 0 }
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
    }
    const url = new URL(req.url!, 'http://x')
    if (url.pathname === '/v1/oauth2/token') return send(200, { access_token: 'mock', expires_in: 3600 })
    if (req.method === 'POST' && url.pathname === '/v2/checkout/orders') {
      const input = JSON.parse(body)
      const id = `ORDER${++n}`
      const order = {
        id,
        status: 'PAYER_ACTION_REQUIRED',
        purchase_units: input.purchase_units,
        links: [{ rel: 'payer-action', href: `https://sandbox.paypal.test/checkoutnow?token=${id}` }],
      }
      orders.set(id, order)
      return send(201, order)
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
    close: () => server.close(),
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'tilltide-e2e-'))
  const tokenAuthority = await generateKeyPairSigner()
  const pointsAuthorityBytes = (() => {
    const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
    return new Uint8Array([...Buffer.from(jwk.d!, 'base64url'), ...Buffer.from(jwk.x!, 'base64url')])
  })()

  console.log('Starting local validator…')
  const validator = spawn(
    'solana-test-validator',
    [
      '--reset', '--quiet', '--ledger', join(dir, 'ledger'), '--rpc-port', String(RPC_PORT),
      '--faucet-port', String(RPC_PORT + 1000), '--gossip-port', String(RPC_PORT + 2000),
      '--dynamic-port-range', `${RPC_PORT + 3000}-${RPC_PORT + 3100}`,
      '--account', USDC, mintAccountFile(dir, USDC, tokenAuthority.address),
      '--account', PYUSD, mintAccountFile(dir, PYUSD, tokenAuthority.address),
    ],
    { stdio: process.env.E2E_VERBOSE ? 'inherit' : 'ignore' },
  )
  let validatorExit: string | null = null
  validator.on('exit', (code) => (validatorExit = `solana-test-validator exited with code ${code}`))
  const rpc = createSolanaRpc(RPC_URL)
  await until(
    'validator',
    () => {
      if (validatorExit) throw new Error(`${validatorExit} (rerun with E2E_VERBOSE=1)`)
      return rpc.getHealth().send().then((h) => h === 'ok').catch(() => false)
    },
    60_000,
  )

  const admin = postgres(ADMIN_DB)
  await admin.unsafe(`drop database if exists ${E2E_DB} with (force)`)
  await admin.unsafe(`create database ${E2E_DB}`)
  await admin.end()
  const dbUrl = ADMIN_DB.replace(/\/[^/]*$/, `/${E2E_DB}`)

  let server: { close(): void } | undefined
  try {
    // Wallets
    const [till, owner, customer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()])
    const { createKeyPairSignerFromBytes } = await import('@solana/kit')
    const pointsAuthority = await createKeyPairSignerFromBytes(pointsAuthorityBytes)
    for (const who of [tokenAuthority, till, customer, pointsAuthority]) {
      await rpc.requestAirdrop(who.address, lamports(10_000_000_000n)).send()
    }
    await until('airdrops', async () => {
      const balances = await Promise.all([tokenAuthority, till, customer, pointsAuthority].map((w) => rpc.getBalance(w.address).send()))
      return balances.every((b) => b.value > 0n)
    })

    const pointsMint = await generateKeyPairSigner()
    // Env for the API, then import it (config reads env at import time).
    Object.assign(process.env, {
      POINTS_MINT: pointsMint.address,
      DATABASE_URL: dbUrl,
      SOLANA_CLUSTER: 'devnet',
      SOLANA_RPC_URL: RPC_URL,
      PORT: String(API_PORT),
      POINTS_AUTHORITY_SECRET: JSON.stringify([...pointsAuthorityBytes]),
      AUTH_DOMAIN: 'tilltide.test',
      PAYPAL_CLIENT_ID: 'mock',
      PAYPAL_CLIENT_SECRET: 'mock',
      PAYPAL_API_BASE: `http://127.0.0.1:${API_PORT + 12}`,
      PUBLIC_URL: API,
    })
    const paypal = startMockPayPal(API_PORT + 12)
    const { sendAndConfirm } = await import('../../src/solana')

    async function send(feePayer: KeyPairSigner, instructions: Instruction[]) {
      return sendAndConfirm(feePayer, instructions)
    }
    async function ata(ownerAddr: Address, mint: Address, program: Address) {
      return (await findAssociatedTokenPda({ owner: ownerAddr, mint, tokenProgram: program }))[0]
    }
    async function tokenBalance(ownerAddr: Address, mint: Address, program: Address) {
      return rpc
        .getTokenAccountBalance(await ata(ownerAddr, mint, program), { commitment: 'confirmed' })
        .send()
        .then((r) => BigInt(r.value.amount))
        .catch(() => 0n)
    }
    async function fund(mint: Address, program: Address, to: Address, amount: bigint) {
      await send(tokenAuthority, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: tokenAuthority, owner: to, mint, tokenProgram: program }),
        getMintToInstruction(
          { mint, token: await ata(to, mint, program), mintAuthority: tokenAuthority, amount },
          { programAddress: program },
        ),
      ])
    }

    // Points mint
    const { getCreateAccountInstruction } = await import('@solana-program/system')
    const { getInitializeMintInstruction, getMintSize } = await import('@solana-program/token')
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

    await fund(USDC, TOKEN, customer.address, 100_000_000n)
    await fund(PYUSD, TOKEN_2022, customer.address, 100_000_000n)

    const { sql } = await import('../../src/db')
    const { readFile } = await import('node:fs/promises')
    await sql.unsafe(await readFile(new URL('../../src/db/schema.sql', import.meta.url), 'utf8'))
    // Run the schema twice: migrations must be re-runnable on every deploy.
    await sql.unsafe(await readFile(new URL('../../src/db/schema.sql', import.meta.url), 'utf8'))

    const { serve } = await import('@hono/node-server')
    const { app } = await import('../../src/app')
    const { startWatcher } = await import('../../src/services/watcher')
    const stopWatcher = startWatcher()
    const http = serve({ fetch: app.fetch, port: API_PORT })
    server = { close: () => (stopWatcher(), http.close(), paypal.close()) }

    async function api<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json().catch(() => null)) as T }
    }

    /** What the wallet does for Sign In With Solana: build the standard message and sign it. */
    async function siwsMessage(signer: KeyPairSigner, nonce: string, domain: string, statement: string) {
      return new TextEncoder().encode(
        `${domain} wants you to sign in with your Solana account:\n${signer.address}\n\n${statement}\n\n` +
          `URI: https://${domain}\nVersion: 1\nChain ID: solana:devnet\nNonce: ${nonce}\n` +
          // A phone with a badly wrong clock must still be able to sign in.
          `Issued At: ${new Date(Date.now() - 3 * 86_400_000).toISOString()}`,
      )
    }
    async function signIn(signer: KeyPairSigner): Promise<string> {
      const { body: n } = await api('POST', '/auth/nonce')
      const message = await siwsMessage(signer, n.nonce, n.domain, n.statement)
      const signature = await signBytes(signer.keyPair.privateKey, message)
      const r = await api('POST', '/auth/verify', {
        address: signer.address,
        signedMessage: Buffer.from(message).toString('base64'),
        signature: Buffer.from(signature).toString('base64'),
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      return r.body.token
    }

    /** What a customer's wallet does with a Solana Pay URL: transferChecked + the reference as a read-only key. */
    async function payFromUrl(url: string, payer: KeyPairSigner, overrideAmount?: bigint) {
      const { parseTransferRequest, toBaseUnits } = await import('@tilltide/agent-pay-kit')
      const req = parseTransferRequest(url)
      const mint = req.splToken!
      const program = mint === PYUSD ? TOKEN_2022 : TOKEN
      const amount = overrideAmount ?? toBaseUnits(req.amount!, 6)
      const transfer = getTransferCheckedInstruction(
        {
          source: await ata(payer.address, mint, program),
          mint,
          destination: await ata(req.recipient, mint, program),
          authority: payer,
          amount,
          decimals: 6,
        },
        { programAddress: program },
      )
      const withReference = {
        ...transfer,
        accounts: [...transfer.accounts, ...req.references.map((r) => ({ address: r, role: AccountRole.READONLY }))],
      }
      return send(payer, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: req.recipient, mint, tokenProgram: program }),
        withReference,
      ])
    }

    async function waitFor(token: string, paymentId: string, done: (p: any) => boolean, what: string) {
      return until(what, async () => {
        const r = await api('GET', `/shop/payments/${paymentId}`, undefined, token)
        return done(r.body) ? r.body : null
      })
    }

    let tillToken = ''

    await step('sign in with Solana: valid signature gets a session; forged or replayed ones do not', async () => {
      assert.equal((await api('GET', '/shop')).status, 401)
      assert.equal((await api('GET', '/shop', undefined, 'made-up-token')).status, 401)

      const { body: n } = await api('POST', '/auth/nonce')
      const message = await siwsMessage(till, n.nonce, n.domain, n.statement)
      const forged = await signBytes(customer.keyPair.privateKey, message)
      const bad = await api('POST', '/auth/verify', {
        address: till.address,
        signedMessage: Buffer.from(message).toString('base64'),
        signature: Buffer.from(forged).toString('base64'),
      })
      assert.equal(bad.status, 401)

      const good = { address: till.address, signedMessage: Buffer.from(message).toString('base64'), signature: Buffer.from(await signBytes(till.keyPair.privateKey, message)).toString('base64') }
      assert.equal((await api('POST', '/auth/verify', good)).status, 200)
      assert.equal((await api('POST', '/auth/verify', good)).status, 401, 'nonce is single use')

      const wrongDomain = await siwsMessage(till, (await api('POST', '/auth/nonce')).body.nonce, 'evil.example', n.statement)
      const r = await api('POST', '/auth/verify', {
        address: till.address,
        signedMessage: Buffer.from(wrongDomain).toString('base64'),
        signature: Buffer.from(await signBytes(till.keyPair.privateKey, wrongDomain)).toString('base64'),
      })
      assert.equal(r.status, 401)

      const mainnetMsg = new TextEncoder().encode(
        new TextDecoder().decode(await siwsMessage(till, (await api('POST', '/auth/nonce')).body.nonce, n.domain, n.statement)).replace('solana:devnet', 'solana:mainnet'),
      )
      const mainnet = await api('POST', '/auth/verify', {
        address: till.address,
        signedMessage: Buffer.from(mainnetMsg).toString('base64'),
        signature: Buffer.from(await signBytes(till.keyPair.privateKey, mainnetMsg)).toString('base64'),
      })
      assert.equal(mainnet.status, 401, 'wrong chain rejected')

      tillToken = await signIn(till)
    })

    await step('registers the shop for the signed-in wallet and sets the owner wallet', async () => {
      assert.equal((await api('GET', '/shop', undefined, tillToken)).status, 404)
      const r = await api('POST', '/shop', { name: 'Pasty Shop' }, tillToken)
      assert.equal(r.status, 200)
      assert.equal(r.body.wallet, till.address)
      const again = await api('POST', '/shop', { name: 'Other name' }, tillToken)
      assert.equal(again.body.id, r.body.id, 'registering again returns the same shop')
      const p = await api('PATCH', '/shop', { ownerWallet: owner.address, pointsPerUnit: 1 }, tillToken)
      assert.equal(p.body.ownerWallet, owner.address)
      assert.equal((await api('PATCH', '/shop', { timezone: 'Mars/Olympus' }, tillToken)).status, 400)
      assert.equal((await api('PATCH', '/shop', { ownerWallet: till.address }, tillToken)).status, 400)
    })

    let firstPaymentId = ''
    await step('USDC: QR request → customer pays → Paid ✓ with payer and points, despite a dust tx on the reference', async () => {
      const created = await api('POST', '/shop/payments', { amount: '4.50', label: '2 pasties' }, tillToken)
      assert.equal(created.status, 201)
      firstPaymentId = created.body.id
      assert.match(created.body.url, new RegExp(`^solana:${till.address}\\?amount=4.5&spl-token=${USDC}&reference=`))

      // Anyone can read the reference off the QR. A dust transfer carrying it must not block the real payment.
      await payFromUrl(created.body.url, customer, 1n)
      const noted = await waitFor(tillToken, firstPaymentId, (p) => Boolean(p.failureReason), 'dust noted')
      assert.equal(noted.status, 'pending')

      await payFromUrl(created.body.url, customer)
      const paid = await waitFor(tillToken, firstPaymentId, (p) => p.status === 'paid' && p.pointsIssued, 'paid')
      assert.equal(paid.payer, customer.address)
      assert.equal(paid.points, '4')
      assert.equal(paid.failureReason, null)
      assert.equal(await tokenBalance(customer.address, pointsMint.address, TOKEN), 4n)
    })

    await step("another shop can't read this shop's payments or sweeps", async () => {
      const otherToken = await signIn(owner)
      await api('POST', '/shop', { name: 'Someone else' }, otherToken)
      assert.equal((await api('GET', `/shop/payments/${firstPaymentId}`, undefined, otherToken)).status, 404)
      assert.deepEqual((await api('GET', '/shop/payments', undefined, otherToken)).body, [])
      await api('POST', '/shop/logout', undefined, otherToken)
      assert.equal((await api('GET', '/shop', undefined, otherToken)).status, 401, 'logout revokes the session')
    })

    await step('points are never issued twice', async () => {
      const { issuePointsForPayment } = await import('../../src/services/payments')
      const again = await issuePointsForPayment(firstPaymentId)
      assert.equal(again.issued, false)
      await Promise.all([issuePointsForPayment(firstPaymentId), issuePointsForPayment(firstPaymentId)])
      assert.equal(await tokenBalance(customer.address, pointsMint.address, TOKEN), 4n)
    })

    await step('an interrupted points mint is settled from the chain, not re-sent blindly', async () => {
      const { issuePointsForPayment } = await import('../../src/services/payments')
      await sql`update payments set points_status = 'sending', points_claimed_at = now() - interval '10 minutes' where id = ${firstPaymentId}`
      const settled = await issuePointsForPayment(firstPaymentId)
      assert.equal(settled.issued, true)
      assert.equal(await tokenBalance(customer.address, pointsMint.address, TOKEN), 4n, 'no second mint')
      const [row] = await sql`select points_status from payments where id = ${firstPaymentId}`
      assert.equal(row!.pointsStatus, 'issued')
    })

    let underpaidId = ''
    await step('underpayment shows the problem while open and becomes failed at expiry', async () => {
      const created = await api('POST', '/shop/payments', { amount: '10' }, tillToken)
      underpaidId = created.body.id
      await payFromUrl(created.body.url, customer, 5_000_000n)
      const open = await waitFor(tillToken, underpaidId, (p) => Boolean(p.failureReason), 'underpay noted')
      assert.equal(open.status, 'pending')
      assert.match(open.failureReason, /received 5000000, expected 10000000/)
      await sql`update payments set created_at = now() - interval '31 minutes' where id = ${underpaidId}`
      await until('failed', async () => (await sql`select status from payments where id = ${underpaidId}`)[0]!.status === 'failed')
    })

    await step('a customer who pays after the request expired is still recorded as paid', async () => {
      const created = await api('POST', '/shop/payments', { amount: '2' }, tillToken)
      await sql`update payments set status = 'expired' where id = ${created.body.id}`
      await payFromUrl(created.body.url, customer)
      const paid = await waitFor(tillToken, created.body.id, (p) => p.status === 'paid', 'late paid')
      assert.equal(paid.payer, customer.address)
    })

    await step('validation errors are 400s, not crashes', async () => {
      const post = (body: unknown) => api('POST', '/shop/payments', body, tillToken)
      assert.equal((await post({ amount: '1.0000001' })).status, 400)
      assert.equal((await post({ amount: '0' })).status, 400)
      assert.equal((await post({ amount: 'abc' })).status, 400)
      assert.equal((await post({ amount: '99999999' })).status, 400)
      assert.equal((await post({ amount: '1.005', rail: 'paypal' })).status, 400, 'PayPal needs whole cents')
      assert.equal((await post({})).status, 400)
      assert.equal((await api('GET', '/shop/summary?date=yesterday', undefined, tillToken)).status, 400)
      assert.equal((await api('GET', '/shop/payments/not-a-uuid', undefined, tillToken)).status, 404)
      assert.equal((await api('POST', '/shop/sweeps/not-a-uuid/check', undefined, tillToken)).status, 404)
      assert.equal((await api('POST', '/auth/verify', { address: 'x', signedMessage: '!!', signature: '' })).status, 400)
      assert.equal((await api('GET', '/points/not-an-address')).status, 400)
    })

    await step('summary and reconciliation match the chain; money outside the ledger is flagged', async () => {
      await send(customer, [
        getTransferCheckedInstruction({
          source: await ata(customer.address, USDC, TOKEN),
          mint: USDC,
          destination: await ata(till.address, USDC, TOKEN),
          authority: customer,
          amount: 1_000_000n,
          decimals: 6,
        }),
      ])
      const r = await api('GET', '/shop/summary?reconcile=true', undefined, tillToken)
      assert.equal(r.status, 200)
      const { summary, reconciliation } = r.body
      assert.equal(summary.takings, '6.5')
      assert.equal(summary.paidCount, 2)
      assert.equal(summary.uniqueCustomers, 1)
      assert.equal(summary.failed.length, 1)
      assert.deepEqual(summary.paymentsMissingPoints, [])
      // Till: 4.50 + 2 paid, 0.000001 dust, 5 underpaid, 1 outside.
      assert.equal(reconciliation.tillBalance, '12.500001')
      // Dust, underpayment and the outside transfer all moved money the ledger doesn't count.
      assert.equal(reconciliation.onchainActivityNotInLedger.length, 3)
    })

    await step('sweep: propose → till signs (as MWA would) → submit → verified onchain → confirmed', async () => {
      const { proposeSweep, serializeSweep } = await import('../../src/services/sweeps')
      const { getSweepInstructions, TOKENS } = await import('@tilltide/agent-pay-kit')
      const merchant = (await sql<any[]>`select * from merchants where wallet = ${till.address}`)[0]

      await assert.rejects(proposeSweep(merchant, 1_000_000_000n, null), /only holds 12.500001 USDC/)
      const sweep = serializeSweep(await proposeSweep(merchant, 10_000_000n, 'End of day'))
      assert.equal(sweep.status, 'proposed')
      assert.equal((await api('POST', `/shop/sweeps/${sweep.id}/check`, undefined, tillToken)).body.status, 'proposed')

      const signature = await send(
        till,
        await getSweepInstructions({ from: till, to: owner.address, token: TOKENS.devnet.USDC, amount: BigInt(sweep.amount), sweepId: sweep.id }),
      )
      const submitted = await api('POST', `/shop/sweeps/${sweep.id}/submit`, { signature }, tillToken)
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
      assert.equal(submitted.body.status, 'confirmed')
      assert.equal(await tokenBalance(owner.address, USDC, TOKEN), 10_000_000n)
      assert.equal((await api('POST', `/shop/sweeps/${sweep.id}/cancel`, undefined, tillToken)).status, 400)

      // The same signature can't confirm a second proposal.
      const second = serializeSweep(await proposeSweep(merchant, 1_000_000n, null))
      const replay = await api('POST', `/shop/sweeps/${second.id}/submit`, { signature }, tillToken)
      assert.equal(replay.status, 400)

      // A customer payment to the owner isn't a sweep from the till: it goes back to proposed with the reason.
      const notFromTill = await send(customer, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: customer, owner: owner.address, mint: USDC }),
        getTransferCheckedInstruction({
          source: await ata(customer.address, USDC, TOKEN),
          mint: USDC,
          destination: await ata(owner.address, USDC, TOKEN),
          authority: customer,
          amount: 1_000_000n,
          decimals: 6,
        }),
      ])
      const wrongSource = await api('POST', `/shop/sweeps/${second.id}/submit`, { signature: notFromTill }, tillToken)
      assert.equal(wrongSource.body.status, 'proposed')
      assert.match(wrongSource.body.error, /isn't this sweep/)
      assert.equal((await api('POST', `/shop/sweeps/${second.id}/cancel`, undefined, tillToken)).body.status, 'cancelled')

      const recon = await api('GET', '/shop/summary?reconcile=true', undefined, tillToken)
      assert.equal(recon.body.reconciliation.sweptToOwnerToday, '10')
      assert.equal(recon.body.reconciliation.onchainActivityNotInLedger.length, 3, 'the sweep is not flagged')
    })

    await step("a submitted sweep can't be signed again until the chain shows it can't land", async () => {
      const { proposeSweep, serializeSweep } = await import('../../src/services/sweeps')
      const { signTransaction } = await import('../../src/solana')
      const { getSweepInstructions, TOKENS } = await import('@tilltide/agent-pay-kit')
      const merchant = (await sql<any[]>`select * from merchants where wallet = ${till.address}`)[0]
      const sweep = serializeSweep(await proposeSweep(merchant, 500_000n, null))

      // Signed but never broadcast: what a dropped transaction looks like.
      const instructions = await getSweepInstructions({ from: till, to: owner.address, token: TOKENS.devnet.USDC, amount: 500_000n, sweepId: sweep.id })
      const { signature: dropped } = await signTransaction(till, instructions)
      const submitted = await api('POST', `/shop/sweeps/${sweep.id}/submit`, { signature: dropped }, tillToken)
      assert.equal(submitted.body.status, 'submitted')
      await assert.rejects(proposeSweep(merchant, 500_000n, null), /still confirming/)
      assert.equal((await api('POST', `/shop/sweeps/${sweep.id}/cancel`, undefined, tillToken)).status, 400)
      assert.equal((await api('POST', `/shop/sweeps/${sweep.id}/check`, undefined, tillToken)).body.status, 'submitted')

      await sql`update sweeps set submitted_at = now() - interval '5 minutes' where id = ${sweep.id}`
      const reverted = await api('POST', `/shop/sweeps/${sweep.id}/check`, undefined, tillToken)
      assert.equal(reverted.body.status, 'proposed')
      assert.match(reverted.body.error, /never reached the chain/)

      // The wallet sent it but the app lost the signature: check finds the matching transfer.
      await send(till, instructions)
      const found = await api('POST', `/shop/sweeps/${sweep.id}/check`, undefined, tillToken)
      assert.equal(found.body.status, 'confirmed')
    })

    await step('a look-alike manual transfer never confirms a sweep; a cancelled sweep that was signed still does', async () => {
      const { proposeSweep, serializeSweep } = await import('../../src/services/sweeps')
      const { getSweepInstructions, TOKENS } = await import('@tilltide/agent-pay-kit')
      const merchant = (await sql<any[]>`select * from merchants where wallet = ${till.address}`)[0]

      const a = serializeSweep(await proposeSweep(merchant, 250_000n, null))
      // The owner moves the same amount by hand, no memo: that is not the sweep.
      await send(till, [
        getTransferCheckedInstruction({
          source: await ata(till.address, USDC, TOKEN),
          mint: USDC,
          destination: await ata(owner.address, USDC, TOKEN),
          authority: till,
          amount: 250_000n,
          decimals: 6,
        }),
      ])
      assert.equal((await api('POST', `/shop/sweeps/${a.id}/check`, undefined, tillToken)).body.status, 'proposed')

      // The owner signs A just as the agent proposes B (which cancels A). A's transfer still counts.
      const instructions = await getSweepInstructions({ from: till, to: owner.address, token: TOKENS.devnet.USDC, amount: 250_000n, sweepId: a.id })
      const b = serializeSweep(await proposeSweep(merchant, 100_000n, null))
      assert.equal((await sql`select status from sweeps where id = ${a.id}`)[0]!.status, 'cancelled')
      const signature = await send(till, instructions)
      const submitted = await api('POST', `/shop/sweeps/${a.id}/submit`, { signature }, tillToken)
      assert.equal(submitted.body.status, 'confirmed', JSON.stringify(submitted.body))
      await api('POST', `/shop/sweeps/${b.id}/cancel`, undefined, tillToken)
    })

    await step('PYUSD (Token-2022): pay, verify, points, sweep', async () => {
      await api('PATCH', '/shop', { token: 'PYUSD' }, tillToken)
      const created = await api('POST', '/shop/payments', { amount: '3.25' }, tillToken)
      assert.match(created.body.url, new RegExp(`spl-token=${PYUSD}`))
      await payFromUrl(created.body.url, customer)
      const paid = await waitFor(tillToken, created.body.id, (p) => p.status === 'paid' && p.pointsIssued, 'PYUSD paid')
      assert.equal(paid.token, 'PYUSD')
      assert.equal(paid.points, '3')
      assert.equal(await tokenBalance(till.address, PYUSD, TOKEN_2022), 3_250_000n)

      const { proposeSweep, serializeSweep } = await import('../../src/services/sweeps')
      const { getSweepInstructions, TOKENS } = await import('@tilltide/agent-pay-kit')
      const merchant = (await sql<any[]>`select * from merchants where wallet = ${till.address}`)[0]
      const sweep = serializeSweep(await proposeSweep(merchant, 3_250_000n, null))
      const signature = await send(
        till,
        await getSweepInstructions({ from: till, to: owner.address, token: TOKENS.devnet.PYUSD, amount: 3_250_000n, sweepId: sweep.id }),
      )
      assert.equal((await api('POST', `/shop/sweeps/${sweep.id}/submit`, { signature }, tillToken)).body.status, 'confirmed')
      assert.equal(await tokenBalance(owner.address, PYUSD, TOKEN_2022), 3_250_000n)
    })

    await step('customer points lookup', async () => {
      const r = await api('GET', `/points/${customer.address}`)
      assert.deepEqual(r.body, { wallet: customer.address, points: '9', configured: true })
    })

    await step('PayPal: QR opens checkout → customer approves → return page captures → Paid ✓', async () => {
      const created = await api('POST', '/shop/payments', { amount: '7.25', label: 'Cream tea', rail: 'paypal' }, tillToken)
      assert.equal(created.status, 201, JSON.stringify(created.body))
      assert.equal(created.body.url, 'https://sandbox.paypal.test/checkoutnow?token=ORDER1')
      const order = paypal.order('ORDER1')
      assert.deepEqual(order.purchase_units[0].amount, { currency_code: 'USD', value: '7.25' })
      assert.equal((await api('GET', `/shop/payments/${created.body.id}`, undefined, tillToken)).body.status, 'pending')

      paypal.approve('ORDER1')
      // The return page and the watcher race to capture; only one capture may happen.
      const [page] = await Promise.all([
        fetch(`${API}/paypal/return?token=ORDER1&PayerID=BUYER1`).then((r) => r.text()),
        api('GET', `/shop/payments/${created.body.id}`, undefined, tillToken),
      ])
      assert.match(page, /Paid ✓|Almost there/)
      const paid = await waitFor(tillToken, created.body.id, (p) => p.status === 'paid', 'PayPal paid')
      assert.equal(paid.payer, 'paypal:BUYER1')
      assert.equal(paid.amount, '7250000')
      assert.equal(paypal.state.captures, 1)
    })

    await step('PayPal: the watcher captures an approved order even if the customer never returns', async () => {
      const created = await api('POST', '/shop/payments', { amount: '3', rail: 'paypal' }, tillToken)
      paypal.approve('ORDER2')
      await until('watcher capture', async () => (await sql`select status from payments where id = ${created.body.id}`)[0]!.status === 'paid')
    })

    await step('PayPal: a capture held for review stays open (never expires) until PayPal releases it', async () => {
      paypal.state.holdForReview = true
      const created = await api('POST', '/shop/payments', { amount: '20', rail: 'paypal' }, tillToken)
      paypal.approve('ORDER3')
      const held = await waitFor(tillToken, created.body.id, (p) => Boolean(p.failureReason), 'held')
      assert.equal(held.status, 'pending')
      assert.match(held.failureReason, /reviewing/)
      await sql`update payments set created_at = now() - interval '31 minutes' where id = ${created.body.id}`
      await sleep(4000)
      assert.equal((await sql`select status from payments where id = ${created.body.id}`)[0]!.status, 'pending')
      paypal.releaseReview('ORDER3')
      paypal.state.holdForReview = false
      await waitFor(tillToken, created.body.id, (p) => p.status === 'paid', 'released')
    })

    await step('PayPal: an expired request is never captured', async () => {
      const created = await api('POST', '/shop/payments', { amount: '5', rail: 'paypal' }, tillToken)
      await sql`update payments set status = 'expired' where id = ${created.body.id}`
      paypal.approve('ORDER4')
      const page = await fetch(`${API}/paypal/return?token=ORDER4`).then((r) => r.text())
      assert.match(page, /Request expired/)
      await sleep(3500)
      assert.equal(paypal.order('ORDER4').status, 'APPROVED', 'not captured')
      assert.equal((await api('GET', `/shop/payments/${created.body.id}`, undefined, tillToken)).body.status, 'expired')
    })

    await step('summary splits takings by rail', async () => {
      const { body } = await api('GET', '/shop/summary', undefined, tillToken)
      assert.deepEqual(body.summary.byRail, { solana: '9.75', paypal: '30.25' })
    })

    await step("agent tools return real data and can't move money", async () => {
      const { buildTools } = await import('../../src/agent')
      // The PYUSD till was swept empty above; switch back to USDC, which still holds a balance.
      await api('PATCH', '/shop', { token: 'USDC' }, tillToken)
      const merchant = (await sql<any[]>`select * from merchants where wallet = ${till.address}`)[0]
      const proposed: any[] = []
      const tools = Object.fromEntries(buildTools(merchant, proposed).map((t) => [t.name, t]))
      assert.deepEqual(Object.keys(tools).sort(), ['get_daily_summary', 'get_payments', 'issue_points', 'sweep_to_owner'])
      const run = (name: string, input: unknown) => (tools[name] as any).run(tools[name]!.parse(input))

      const payments = JSON.parse(await run('get_payments', { status: 'paid', rail: 'paypal' }))
      assert.equal(payments.length, 3)
      assert.ok(payments.every((p: any) => p.rail === 'paypal' && p.status === 'paid'))
      assert.equal(payments.find((p: any) => p.label === 'Cream tea').amount, '7.25')
      assert.equal(JSON.parse(await run('get_payments', { since: new Date(Date.now() + 60_000).toISOString() })).length, 0)
      assert.throws(() => tools.get_payments!.parse({ since: 'last tuesday' }))

      const { summary, reconciliation } = JSON.parse(await run('get_daily_summary', { reconcile: true }))
      assert.equal(summary.takings, '40')
      assert.ok(reconciliation.tillBalance)

      assert.match(await run('issue_points', { payment_id: firstPaymentId }), /already issued/)
      assert.equal(await run('issue_points', { payment_id: '00000000-0000-4000-8000-000000000000' }), 'Payment not found for this shop')

      const before = await import('../../src/services/sweeps').then((m) => m.tillBalance(merchant))
      const tooMuch = JSON.parse(await run('sweep_to_owner', { amount: '100000', reason: 'test' }))
      assert.equal(tooMuch.proposed, false)
      assert.match(tooMuch.error, /only holds/)
      const ok = JSON.parse(await run('sweep_to_owner', { amount: '1', reason: 'End of day' }))
      assert.equal(ok.proposed, true, JSON.stringify(ok))
      assert.equal(ok.sweep.status, 'proposed', 'a proposal only; nothing moved')
      assert.equal(proposed.length, 1)
      assert.equal(await import('../../src/services/sweeps').then((m) => m.tillBalance(merchant)), before)
    })

    await step('watcher expires abandoned requests', async () => {
      const created = await api('POST', '/shop/payments', { amount: '1' }, tillToken)
      await sql`update payments set created_at = now() - interval '31 minutes' where id = ${created.body.id}`
      await until('expired', async () => (await sql`select status from payments where id = ${created.body.id}`)[0]!.status === 'expired')
    })

    console.log(`\nAll ${passed} end-to-end checks passed.`)
    await sql.end()
  } finally {
    server?.close()
    validator.kill('SIGINT')
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nFAILED:', err)
    process.exit(1)
  },
)
