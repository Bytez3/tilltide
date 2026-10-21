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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { PYUSD, sleep, startLocalValidator, startMockPayPal, TOKEN, TOKEN_2022, until, USDC } from '../support/local-chain'
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


let passed = 0
async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`• ${name} … `)
  await fn()
  passed++
  console.log('ok')
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'tilltide-e2e-'))
  const tokenAuthority = await generateKeyPairSigner()
  const pointsAuthorityBytes = (() => {
    const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
    return new Uint8Array([...Buffer.from(jwk.d!, 'base64url'), ...Buffer.from(jwk.x!, 'base64url')])
  })()

  console.log('Starting local validator…')
  const { rpc, stop: stopValidator } = await startLocalValidator({
    port: RPC_PORT,
    ledgerDir: join(dir, 'ledger'),
    tokenAuthority: tokenAuthority.address,
    verbose: Boolean(process.env.E2E_VERBOSE),
  })

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
    const treasury = await generateKeyPairSigner()
    // Env for the API, then import it (config reads env at import time).
    Object.assign(process.env, {
      POINTS_MINT: pointsMint.address,
      DATABASE_URL: dbUrl,
      SOLANA_CLUSTER: 'devnet',
      SOLANA_RPC_URL: RPC_URL,
      PORT: String(API_PORT),
      POINTS_AUTHORITY_SECRET: JSON.stringify([...pointsAuthorityBytes]),
      AUTH_DOMAIN: 'tilltide.test',
      FX_RATES: 'GBP:1.25,EUR:1.10',
      // Seeker Genesis Tokens and SKR only exist on mainnet; the customer stands in for a Seeker owner.
      SEEKER_TEST_WALLETS: customer.address,
      RATE_LIMIT_AUTH: '1000',
      RATE_LIMIT_PER_IP: '100000',
      AGENT_DAILY_LIMIT: '2',
      WATCH_INTERVAL_MS: '500',
      TREASURY_WALLET: treasury.address,
      SWEEP_FEE_BPS: '50',
      ANTHROPIC_API_KEY: '',
      PAYPAL_PARTNER_MERCHANT_ID: 'TILLTIDEPARTNER',
      PAYPAL_BN_CODE: 'Tilltide_SP',
      PAYPAL_REQUIRE_CONNECTED: 'true',
      PAYPAL_FEE_BPS: '50',
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

    /** The sweep transaction exactly as the app builds it, fee included. */
    async function sweepInstructions(sweep: { id: string; amount: string; feeAmount: string; feeWallet: string | null }, token: any) {
      const { getSweepInstructions } = await import('@tilltide/agent-pay-kit')
      return getSweepInstructions({
        from: till,
        to: owner.address,
        token,
        amount: BigInt(sweep.amount),
        fee: sweep.feeWallet ? { to: address(sweep.feeWallet), amount: BigInt(sweep.feeAmount) } : undefined,
        sweepId: sweep.id,
      })
    }

    /** What the app does to sweep: lock it with the blockhash expiry, have the wallet sign and send, then report. */
    async function sweepLikeTheApp(sweepId: string, instructions: Instruction[]) {
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
      const begin = await api('POST', `/shop/sweeps/${sweepId}/begin`, { lastValidBlockHeight: value.lastValidBlockHeight.toString() }, tillToken)
      assert.equal(begin.status, 200, JSON.stringify(begin.body))
      assert.equal(begin.body.status, 'signing')
      const signature = await send(till, instructions)
      return { signature, result: await api('POST', `/shop/sweeps/${sweepId}/submit`, { signature }, tillToken) }
    }

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
      assert.equal(r.body.token, 'PYUSD', 'PayPal first: new shops take PayPal USD by default')
      assert.equal(r.body.currency, 'GBP', 'UK shops price in pounds by default')
      // Most scenarios below run in USD so token amounts equal prices; the GBP scenario is near the end.
      const p = await api('PATCH', '/shop', { ownerWallet: owner.address, pointsPerUnit: 1, token: 'USDC', currency: 'USD' }, tillToken)
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

    await step('staff till: pair with a one-time code; take payments; never move money, refund or change settings', async () => {
      const invite = await api('POST', '/shop/staff/invites', { label: 'Saturday till' }, tillToken)
      assert.equal(invite.status, 201)
      assert.match(invite.body.code, /^\d{4}-\d{4}$/)
      const paired = await api('POST', '/auth/staff', { code: invite.body.code.replace('-', ' ') })
      assert.equal(paired.status, 200, JSON.stringify(paired.body))
      const staff = paired.body.token
      assert.equal((await api('POST', '/auth/staff', { code: invite.body.code })).status, 401, 'single use')
      assert.equal((await api('POST', '/auth/staff', { code: '0000-0000' })).status, 401)

      const shop = await api('GET', '/shop', undefined, staff)
      assert.equal(shop.body.role, 'staff')
      assert.equal(shop.body.name, 'Pasty Shop')
      const sale = await api('POST', '/shop/payments', { amount: '1.00' }, staff)
      assert.equal(sale.status, 201)
      assert.equal((await api('GET', `/shop/payments/${sale.body.id}`, undefined, staff)).status, 200)
      assert.equal((await api('GET', '/shop/payments', undefined, staff)).status, 200)
      assert.equal((await api('GET', '/shop/summary', undefined, staff)).status, 200)

      // Everything that moves money or changes the shop is owner-only, enforced by the server.
      const forbidden: [string, string, unknown?][] = [
        ['PATCH', '/shop', { ownerWallet: customer.address }],
        ['POST', '/shop', { name: 'Hijack' }],
        ['GET', '/shop/till'],
        ['POST', '/shop/sweeps', { amount: '1' }],
        ['GET', '/shop/sweeps'],
        ['POST', `/shop/payments/${sale.body.id}/refunds`, {}],
        ['GET', '/shop/refunds'],
        ['POST', '/shop/chat', { messages: [{ role: 'user', content: 'hi' }] }],
        ['POST', '/shop/paypal/connect'],
        ['POST', '/shop/staff/invites', { label: 'x' }],
        ['GET', '/shop/staff'],
        ['GET', '/shop/reports'],
        ['POST', '/shop/reports', {}],
        ['POST', '/shop/export', { from: '2026-01-01', to: '2026-01-02' }],
      ]
      for (const [method, path, payload] of forbidden) {
        const r = await api(method, path, payload, staff)
        assert.equal(r.status, 403, `${method} ${path} should be owner-only, got ${r.status}`)
      }

      // The owner sees the device and can sign it out at once.
      const list = await api('GET', '/shop/staff', undefined, tillToken)
      assert.equal(list.body.length, 1)
      assert.equal(list.body[0].label, 'Saturday till')
      assert.equal((await api('POST', `/shop/staff/${list.body[0].id}/remove`, undefined, tillToken)).status, 200)
      assert.equal((await api('GET', '/shop', undefined, staff)).status, 401)
      // Another shop's owner can't remove this shop's staff.
      const invite2 = await api('POST', '/shop/staff/invites', { label: 'Till 2' }, tillToken)
      await api('POST', '/auth/staff', { code: invite2.body.code })
      const id2 = (await api('GET', '/shop/staff', undefined, tillToken)).body[0].id
      const otherOwner = await signIn(owner)
      await api('POST', '/shop', { name: 'Someone else' }, otherOwner)
      assert.equal((await api('POST', `/shop/staff/${id2}/remove`, undefined, otherOwner)).status, 404)
      await api('POST', `/shop/staff/${id2}/remove`, undefined, tillToken)
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
      assert.equal((await api('GET', '/shop/summary?date=2026-02-31', undefined, tillToken)).status, 400)
      assert.equal((await api('PATCH', '/shop', { timezone: '+01:00' }, tillToken)).status, 400)
      assert.equal((await api('PATCH', '/shop', { timezone: '+0100' }, tillToken)).status, 400)
      assert.equal((await api('PATCH', '/shop', { timezone: 'Europe/London' }, tillToken)).status, 200)
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

      const { signature, result: submitted } = await sweepLikeTheApp(
        sweep.id,
        await sweepInstructions(sweep, TOKENS.devnet.USDC),
      )
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
      assert.equal(submitted.body.status, 'confirmed')
      // 0.5% fee: 9.95 to the owner, 0.05 to Tilltide, in the one transaction the owner signed.
      assert.equal(sweep.toOwner, '9.95')
      assert.equal(sweep.feeDisplay, '0.05')
      assert.equal(await tokenBalance(owner.address, USDC, TOKEN), 9_950_000n)
      assert.equal(await tokenBalance(treasury.address, USDC, TOKEN), 50_000n)
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
      assert.equal(recon.body.reconciliation.sweptOutToday, '10')
      assert.equal(recon.body.reconciliation.onchainActivityNotInLedger.length, 3, 'the sweep is not flagged')
    })

    await step("a submitted sweep can't be signed again until the chain shows it can't land", async () => {
      const { proposeSweep, serializeSweep } = await import('../../src/services/sweeps')
      const { signTransaction } = await import('../../src/solana')
      const { getSweepInstructions, TOKENS } = await import('@tilltide/agent-pay-kit')
      const merchant = (await sql<any[]>`select * from merchants where wallet = ${till.address}`)[0]
      const sweep = serializeSweep(await proposeSweep(merchant, 500_000n, null))

      // Signed but never broadcast: what a dropped transaction looks like.
      const instructions = await sweepInstructions(sweep, TOKENS.devnet.USDC)
      const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
      assert.equal((await api('POST', `/shop/sweeps/${sweep.id}/begin`, { lastValidBlockHeight: bh.lastValidBlockHeight.toString() }, tillToken)).status, 200)
      // Opening the wallet a second time while the first is still live is refused.
      assert.equal((await api('POST', `/shop/sweeps/${sweep.id}/begin`, { lastValidBlockHeight: bh.lastValidBlockHeight.toString() }, tillToken)).status, 409)
      const { signature: dropped } = await signTransaction(till, instructions)
      const submitted = await api('POST', `/shop/sweeps/${sweep.id}/submit`, { signature: dropped }, tillToken)
      assert.equal(submitted.body.status, 'submitted')
      await assert.rejects(proposeSweep(merchant, 500_000n, null), /still being signed or confirmed/)
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

      // While A is open in the wallet, the agent can't propose B (which would cancel A).
      const instructions = await sweepInstructions(a, TOKENS.devnet.USDC)
      const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
      await api('POST', `/shop/sweeps/${a.id}/begin`, { lastValidBlockHeight: bh.lastValidBlockHeight.toString() }, tillToken)
      await assert.rejects(proposeSweep(merchant, 100_000n, null), /still being signed/)
      assert.equal((await api('POST', `/shop/sweeps/${a.id}/cancel`, undefined, tillToken)).status, 400, "can't cancel mid-signing")
      const signature = await send(till, instructions)
      const submitted = await api('POST', `/shop/sweeps/${a.id}/submit`, { signature }, tillToken)
      assert.equal(submitted.body.status, 'confirmed', JSON.stringify(submitted.body))

      // A signed sweep that was cancelled earlier still counts if its memo lands.
      const c2 = serializeSweep(await proposeSweep(merchant, 100_000n, null))
      await api('POST', `/shop/sweeps/${c2.id}/cancel`, undefined, tillToken)
      const late = await send(till, await sweepInstructions(c2, TOKENS.devnet.USDC))
      assert.equal((await api('POST', `/shop/sweeps/${c2.id}/submit`, { signature: late }, tillToken)).body.status, 'confirmed')

      // A signing lock whose blockhash has expired with nothing onchain reopens the sweep.
      const d = serializeSweep(await proposeSweep(merchant, 100_000n, null))
      const { value: bh2 } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
      await api('POST', `/shop/sweeps/${d.id}/begin`, { lastValidBlockHeight: bh2.lastValidBlockHeight.toString() }, tillToken)
      await sql`update sweeps set signing_valid_until = 1 where id = ${d.id}`
      const reopened = await api('POST', `/shop/sweeps/${d.id}/check`, undefined, tillToken)
      assert.equal(reopened.body.status, 'proposed')
      assert.match(reopened.body.error, /did not send/)
      await api('POST', `/shop/sweeps/${d.id}/cancel`, undefined, tillToken)
    })

    await step("a sweep that skips Tilltide's fee is caught, not confirmed", async () => {
      const { proposeSweep, serializeSweep } = await import('../../src/services/sweeps')
      const { getSweepInstructions, TOKENS } = await import('@tilltide/agent-pay-kit')
      const merchant = (await sql<any[]>`select * from merchants where wallet = ${till.address}`)[0]
      const sweep = serializeSweep(await proposeSweep(merchant, 200_000n, null))
      // Full amount to the owner, no fee transfer, but with this sweep's memo.
      const noFee = await getSweepInstructions({ from: till, to: owner.address, token: TOKENS.devnet.USDC, amount: 200_000n, sweepId: sweep.id })
      const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
      await api('POST', `/shop/sweeps/${sweep.id}/begin`, { lastValidBlockHeight: bh.lastValidBlockHeight.toString() }, tillToken)
      const signature = await send(till, noFee)
      const r = await api('POST', `/shop/sweeps/${sweep.id}/submit`, { signature }, tillToken)
      assert.equal(r.body.status, 'failed')
      assert.match(r.body.error, /fee didn't add up/)
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
      const { result } = await sweepLikeTheApp(
        sweep.id,
        await sweepInstructions(sweep, TOKENS.devnet.PYUSD),
      )
      assert.equal(result.body.status, 'confirmed')
      assert.equal(await tokenBalance(owner.address, PYUSD, TOKEN_2022), 3_233_750n)
      assert.equal(await tokenBalance(treasury.address, PYUSD, TOKEN_2022), 16_250n)
    })

    await step('customer points lookup', async () => {
      const r = await api('GET', `/points/${customer.address}`)
      assert.deepEqual(r.body, { wallet: customer.address, points: '9', configured: true })
    })

    await step('points redemption: wallet fetches the transaction, pays the rest and burns points; cheating is refused', async () => {
      const { getTransactionDecoder, signTransaction, getBase64EncodedWireTransaction } = await import('@solana/kit')
      const { getRedeemPaymentInstructions, TOKENS } = await import('@tilltide/agent-pay-kit')
      await api('PATCH', '/shop', { token: 'USDC', pointValue: '0.10', redeemMaxPercent: 50 }, tillToken)
      const pointsNow = async () => BigInt((await api('GET', `/points/${customer.address}`)).body.points)
      assert.equal(await pointsNow(), 9n)

      /** What a wallet does with a transaction request: GET label, POST account, sign what comes back, send. */
      async function payWithWallet(url: string) {
        const link = decodeURIComponent(url.slice('solana:'.length))
        const meta = await (await fetch(link)).json()
        assert.equal(meta.label, 'Pasty Shop')
        const res = await (await fetch(link, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: customer.address }) })).json()
        const tx = getTransactionDecoder().decode(Buffer.from(res.transaction, 'base64'))
        const signed = await signTransaction([customer.keyPair], tx)
        await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
        return res.message as string
      }

      // Cheating: pay the discounted price but keep the points. Not paid.
      const created = await api('POST', '/shop/payments', { amount: '2.00', usePoints: true }, tillToken)
      assert.equal(created.status, 201, JSON.stringify(created.body))
      assert.match(created.body.url, /^solana:http%3A%2F%2F/)
      const reference = (await sql`select reference from payments where id = ${created.body.id}`)[0]!.reference
      await send(customer, await getRedeemPaymentInstructions({
        customer, recipient: till.address, token: TOKENS.devnet.USDC, toPay: 1_100_000n,
        pointsMint: pointsMint.address, points: 0n, reference: address(reference), memo: 'cheat',
      }))
      const noted = await waitFor(tillToken, created.body.id, (p) => Boolean(p.failureReason), 'cheat noted')
      assert.equal(noted.status, 'pending')
      assert.match(noted.failureReason, /short of 2/)

      // Honest: the wallet signs what the server built. 9 points × 0.10 = 0.90 off, pays 1.10.
      const message = await payWithWallet(created.body.url)
      assert.match(message, /using 9 points \(0.90 USD off\)\. You pay 1.10 USDC/)
      const paid = await waitFor(tillToken, created.body.id, (p) => p.status === 'paid' && p.pointsIssued, 'redeemed and paid')
      assert.equal(paid.pointsRedeemed, '9')
      assert.equal(paid.discount, '900000')
      assert.equal(paid.points, '1', 'points earned on the 1.10 actually paid')
      assert.equal(await pointsNow(), 1n)

      // Over the cap: burn points worth more than half the bill. Not paid.
      await api('PATCH', '/shop', { pointValue: '5.00' }, tillToken)
      const greedy = await api('POST', '/shop/payments', { amount: '2.00', usePoints: true }, tillToken)
      const ref2 = (await sql`select reference from payments where id = ${greedy.body.id}`)[0]!.reference
      await send(customer, await getRedeemPaymentInstructions({
        customer, recipient: till.address, token: TOKENS.devnet.USDC, toPay: 10_000n,
        pointsMint: pointsMint.address, points: 1n, reference: address(ref2), memo: 'greedy',
      }))
      const capped = await waitFor(tillToken, greedy.body.id, (p) => Boolean(p.failureReason), 'over cap noted')
      assert.match(capped.failureReason, /more than the 50% allowed/)
      await api('PATCH', '/shop', { pointValue: '0.01' }, tillToken)

      const { body } = await api('GET', '/shop/summary', undefined, tillToken)
      assert.equal(body.summary.pointsRedeemed, '9')
      assert.equal(body.summary.pointsDiscount, '0.9')
      assert.equal((await api('POST', '/shop/payments', { amount: '1', rail: 'paypal', usePoints: true }, tillToken)).status, 400)
    })

    await step('PayPal first: a shop must connect its own PayPal; a forged onboarding return is ignored', async () => {
      const shopId = (await api('GET', '/shop', undefined, tillToken)).body.id
      const refused = await api('POST', '/shop/payments', { amount: '1', rail: 'paypal' }, tillToken)
      assert.equal(refused.status, 400)
      assert.match(refused.body.error, /Connect your PayPal/)

      const connect = await api('POST', '/shop/paypal/connect', undefined, tillToken)
      assert.equal(connect.status, 200)
      assert.match(connect.body.url, new RegExp(`onboard\\?tracking=${shopId}`))
      assert.equal((await api('GET', '/shop', undefined, tillToken)).body.paypal.status, 'pending')

      // Someone crafts the return URL without finishing onboarding: not trusted.
      const forged = await fetch(`${API}/paypal/onboarded?merchantId=${shopId}&merchantIdInPayPal=EVIL&permissionsGranted=true`).then((r) => r.text())
      assert.match(forged, /Almost there/)
      assert.equal((await api('GET', '/shop', undefined, tillToken)).body.paypal.status, 'pending')

      paypal.completeOnboarding(shopId, 'SHOPPAYPAL1')
      const done = await fetch(`${API}/paypal/onboarded?merchantId=${shopId}`).then((r) => r.text())
      assert.match(done, /PayPal connected/)
      const shop = (await api('GET', '/shop', undefined, tillToken)).body
      assert.equal(shop.paypal.status, 'connected')
      assert.equal(shop.paypal.feePercent, 0.5)
    })

    await step('PayPal: QR opens checkout → customer approves → return page captures → Paid ✓', async () => {
      const created = await api('POST', '/shop/payments', { amount: '7.25', label: 'Cream tea', rail: 'paypal' }, tillToken)
      assert.equal(created.status, 201, JSON.stringify(created.body))
      assert.equal(created.body.url, 'https://sandbox.paypal.test/checkoutnow?token=ORDER1')
      const order = paypal.order('ORDER1')
      assert.deepEqual(order.purchase_units[0].amount, { currency_code: 'USD', value: '7.25' })
      // Paid to the shop's own PayPal, with Tilltide's 0.5% (rounded down to whole cents) and partner code.
      assert.deepEqual(order.purchase_units[0].payee, { merchant_id: 'SHOPPAYPAL1' })
      assert.deepEqual(order.purchase_units[0].payment_instruction, { platform_fees: [{ amount: { currency_code: 'USD', value: '0.03' } }] })
      assert.equal(order.bnCode, 'Tilltide_SP')
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
      assert.deepEqual(body.summary.byRail, { solana: '10.85', paypal: '30.25' }, 'cash received; the points sale counts 1.10')
    })

    await step('PayPal refunds: agent proposes, owner approves with a wallet signature, PayPal refunds exactly once', async () => {
      const { buildTools } = await import('../../src/agent')
      const merchant = (await sql<any[]>`select * from merchants where wallet = ${till.address}`)[0]
      const refunds: any[] = []
      const tools = Object.fromEntries(buildTools(merchant, [], refunds).map((t) => [t.name, t]))
      const run = (input: unknown) => (tools.refund_paypal_payment as any).run(tools.refund_paypal_payment!.parse(input)).then(JSON.parse)
      const creamTea = (await sql<any[]>`select id from payments where label = 'Cream tea'`)[0].id
      const solanaPayment = firstPaymentId

      assert.match((await run({ payment_id: solanaPayment, reason: 'x' })).error, /Only PayPal payments/)
      assert.match((await run({ payment_id: creamTea, amount: '8.00', reason: 'x' })).error, /Only 7.25 USD/)
      const proposal = await run({ payment_id: creamTea, amount: '2.00', reason: 'Scone was cold' })
      assert.equal(proposal.proposed, true)
      assert.equal(proposal.refund.status, 'proposed')
      assert.equal(paypal.refunds().length, 0, 'proposing refunds nothing')
      const id = proposal.refund.id

      const sign = async (signer: KeyPairSigner, statement: string, nonce: string) => {
        const msg = new TextEncoder().encode(
          `tilltide.test wants you to sign in with your Solana account:\n${signer.address}\n\n${statement}\n\nURI: https://tilltide.test\nVersion: 1\nChain ID: solana:devnet\nNonce: ${nonce}`,
        )
        return { signedMessage: Buffer.from(msg).toString('base64'), signature: Buffer.from(await signBytes(signer.keyPair.privateKey, msg)).toString('base64') }
      }

      // No signature, a stolen-session forgery, and a signature for different wording are all refused.
      assert.equal((await api('POST', `/shop/refunds/${id}/approve`, {}, tillToken)).status, 409)
      let ch = (await api('POST', `/shop/refunds/${id}/challenge`, undefined, tillToken)).body
      assert.match(ch.statement, /Approve a PayPal refund of 2.00 USD for "Cream tea"/)
      assert.equal((await api('POST', `/shop/refunds/${id}/approve`, await sign(customer, ch.statement, ch.nonce), tillToken)).status, 409)
      ch = (await api('POST', `/shop/refunds/${id}/challenge`, undefined, tillToken)).body
      assert.equal((await api('POST', `/shop/refunds/${id}/approve`, await sign(till, ch.statement.replace('2.00', '20.00'), ch.nonce), tillToken)).status, 409)
      assert.equal(paypal.refunds().length, 0)

      // PayPal is down at the moment of approval: the refund waits in 'processing', then a retry
      // completes it with the same idempotency key, so the customer is refunded once.
      ch = (await api('POST', `/shop/refunds/${id}/challenge`, undefined, tillToken)).body
      paypal.state.failNextRefund = true
      const approval = await sign(till, ch.statement, ch.nonce)
      const first = await api('POST', `/shop/refunds/${id}/approve`, approval, tillToken)
      assert.equal(first.body.status, 'processing')
      assert.equal((await api('POST', `/shop/refunds/${id}/approve`, approval, tillToken)).body.status, 'completed')
      assert.equal((await api('POST', `/shop/refunds/${id}/approve`, {}, tillToken)).body.status, 'completed')
      assert.equal(paypal.refunds().length, 1)
      assert.deepEqual(paypal.refunds()[0].amount, { value: '2.00', currency_code: 'USD' })
      assert.equal(paypal.refunds()[0].capture, 'CAP-ORDER1')
      // Refunded on the shop's behalf, from its PayPal.
      const assertion = paypal.refundHeaders().at(-1)!.assertion!
      assert.deepEqual(JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString()), { iss: 'mock', payer_id: 'SHOPPAYPAL1' })

      // The rest can still be refunded, but no more than that.
      assert.match((await run({ payment_id: creamTea, amount: '5.26', reason: 'x' })).error, /Only 5.25 USD/)
      const { body } = await api('GET', '/shop/summary', undefined, tillToken)
      assert.deepEqual(body.summary.refunds, { count: 1, total: '2' })
      assert.equal(body.summary.netTakings, String(Number(body.summary.takings) - 2))
    })

    await step('PayPal refunds stay single through lost responses, retried 4xx, parallel proposals and PENDING', async () => {
      const { proposeRefund, approveRefund, getRefund } = await import('../../src/services/refunds')
      const merchant = (await sql<any[]>`select * from merchants where wallet = ${till.address}`)[0]
      const order2 = (await sql<any[]>`select id from payments where paypal_order_id = 'ORDER2'`)[0].id
      const approve = async (refundId: string) => {
        const ch = (await api('POST', `/shop/refunds/${refundId}/challenge`, undefined, tillToken)).body
        const msg = new TextEncoder().encode(
          `tilltide.test wants you to sign in with your Solana account:\n${till.address}\n\n${ch.statement}\n\nURI: https://tilltide.test\nVersion: 1\nChain ID: solana:devnet\nNonce: ${ch.nonce}`,
        )
        const signed = { signedMessage: Buffer.from(msg).toString('base64'), signature: Buffer.from(await signBytes(till.keyPair.privateKey, msg)).toString('base64') }
        return api('POST', `/shop/refunds/${refundId}/approve`, signed, tillToken)
      }
      const settle = async (refundId: string) => {
        for (let i = 0; i < 40; i++) {
          const r = await getRefund(merchant, refundId)
          assert.notEqual(r!.status, 'failed', 'a refund that may have gone through must never be marked failed')
          if (r!.status === 'completed') return r
          await approveRefund(merchant, r!, null).catch(() => null)
          await sleep(300)
        }
        throw new Error('refund never settled')
      }
      const requestsFor = (id: string) => paypal.refunds().filter((r) => r.id && r.capture === 'CAP-ORDER2').length + 0 * id.length

      // Two proposals at once (the agent can call tools in parallel): only one survives.
      await Promise.all([proposeRefund(merchant, order2, null, 'a'), proposeRefund(merchant, order2, null, 'b')])
      assert.equal((await sql`select count(*)::int as n from refunds where payment_id = ${order2} and status = 'proposed'`)[0]!.n, 1)

      // The refund goes through but PayPal's response is lost: retries return the same refund, once.
      const lost = await proposeRefund(merchant, order2, 1_000_000n, 'lost response')
      paypal.state.loseNextResponse = true
      assert.equal((await approve(lost.id)).body.status, 'processing')
      await settle(lost.id)
      assert.equal(requestsFor(lost.id), 1)

      // First call fails (503), the retry gets a 4xx: it may have gone through, so it is NOT marked failed.
      const retried = await proposeRefund(merchant, order2, 1_000_000n, 'retried 4xx')
      paypal.state.failNextRefund = true
      await approve(retried.id)
      paypal.state.rejectNextRefund = true
      await settle(retried.id)
      assert.equal(requestsFor(retried.id), 2)

      // A 4xx on the very first call is a clean refusal: nothing moved, so it's failed and the money is still refundable.
      const refused = await proposeRefund(merchant, order2, 500_000n, 'refused')
      paypal.state.rejectNextRefund = true
      assert.equal((await approve(refused.id)).body.status, 'failed')
      assert.equal(requestsFor(refused.id), 2)

      // PENDING at PayPal: the watcher follows it to completion.
      paypal.state.pendingRefunds = true
      const pending = await proposeRefund(merchant, order2, 500_000n, 'pending')
      assert.equal((await approve(pending.id)).body.status, 'pending')
      paypal.state.pendingRefunds = false
      paypal.completePendingRefunds()
      await until('pending refund completes', async () => (await getRefund(merchant, pending.id))!.status === 'completed', 30_000)

      // 3.00 paid, 2.50 refunded: 0.50 left, no more.
      await assert.rejects(proposeRefund(merchant, order2, 600_000n, 'too much'), /Only 0.5 USD/)
      const last = await proposeRefund(merchant, order2, null, 'rest')
      assert.equal(last.amount, 500_000n)
      assert.equal((await api('POST', `/shop/refunds/${last.id}/cancel`, undefined, tillToken)).body.status, 'cancelled')
      assert.equal((await api('POST', `/shop/refunds/${last.id}/cancel`, undefined, tillToken)).status, 409)

      // Another shop can't see or touch it.
      const other = await signIn(owner)
      assert.equal((await api('GET', `/shop/refunds/${last.id}`, undefined, other)).status, 404)
      assert.equal((await api('POST', `/shop/refunds/${last.id}/challenge`, undefined, other)).status, 404)
    })

    await step('owners can start sweeps and refunds themselves (still wallet-signed to move money)', async () => {
      await api('PATCH', '/shop', { token: 'USDC' }, tillToken)
      const till_ = await api('GET', '/shop/till', undefined, tillToken)
      assert.equal(till_.status, 200)
      assert.equal(till_.body.token, 'USDC')
      assert.ok(Number(till_.body.display) > 0)
      assert.equal((await api('POST', '/shop/sweeps', { amount: '99999' }, tillToken)).status, 409)
      assert.equal((await api('POST', '/shop/sweeps', { amount: 'abc' }, tillToken)).status, 400)
      const sweep = await api('POST', '/shop/sweeps', { amount: '0.10', reason: 'manual' }, tillToken)
      assert.equal(sweep.status, 201)
      assert.equal(sweep.body.status, 'proposed')
      assert.equal(sweep.body.toOwner, '0.0995')
      await api('POST', `/shop/sweeps/${sweep.body.id}/cancel`, undefined, tillToken)

      const creamTea = (await sql<any[]>`select id from payments where label = 'Cream tea'`)[0].id
      const refund = await api('POST', `/shop/payments/${creamTea}/refunds`, { amount: '1.00', reason: 'manual' }, tillToken)
      assert.equal(refund.status, 201, JSON.stringify(refund.body))
      assert.equal(refund.body.status, 'proposed')
      assert.equal((await api('POST', `/shop/payments/${firstPaymentId}/refunds`, {}, tillToken)).status, 409, 'Solana payments are not PayPal-refundable')
      await api('POST', `/shop/refunds/${refund.body.id}/cancel`, undefined, tillToken)
      const other = await signIn(owner)
      assert.equal((await api('POST', `/shop/payments/${creamTea}/refunds`, {}, other)).status, 409, "another shop can't refund it")
    })

    await step('no sweep fee when the treasury is the shop\'s own owner wallet', async () => {
      const { proposeSweep } = await import('../../src/services/sweeps')
      const other = await signIn(owner)
      await api('PATCH', '/shop', { ownerWallet: treasury.address }, other)
      const shop = (await sql<any[]>`select * from merchants where wallet = ${owner.address}`)[0]
      const sweep = await proposeSweep(shop, 1_000_000n, null)
      assert.equal(sweep.feeAmount, 0n)
      assert.equal(sweep.feeWallet, null)
      await sql`update sweeps set status = 'cancelled' where id = ${sweep.id}`
    })

    await step("agent tools return real data and can't move money", async () => {
      const { buildTools } = await import('../../src/agent')
      // The PYUSD till was swept empty above; switch back to USDC, which still holds a balance.
      await api('PATCH', '/shop', { token: 'USDC' }, tillToken)
      const merchant = (await sql<any[]>`select * from merchants where wallet = ${till.address}`)[0]
      const proposed: any[] = []
      const tools = Object.fromEntries(buildTools(merchant, proposed).map((t) => [t.name, t]))
      assert.deepEqual(Object.keys(tools).sort(), ['get_daily_summary', 'get_payments', 'issue_points', 'refund_paypal_payment', 'sweep_to_owner'])
      const run = (name: string, input: unknown) => (tools[name] as any).run(tools[name]!.parse(input))

      const payments = JSON.parse(await run('get_payments', { status: 'paid', rail: 'paypal' }))
      assert.equal(payments.length, 3)
      assert.ok(payments.every((p: any) => p.rail === 'paypal' && p.status === 'paid'))
      assert.equal(payments.find((p: any) => p.label === 'Cream tea').amount, '7.25')
      assert.equal(JSON.parse(await run('get_payments', { since: new Date(Date.now() + 60_000).toISOString() })).length, 0)
      assert.throws(() => tools.get_payments!.parse({ since: 'last tuesday' }))

      const { summary, reconciliation } = JSON.parse(await run('get_daily_summary', { reconcile: true }))
      assert.equal(summary.takings, '41.1')
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

    await step('agent chat is capped per shop per day; oversized requests are refused', async () => {
      const chat = () => api('POST', '/shop/chat', { messages: [{ role: 'user', content: 'What did I take today?' }] }, tillToken)
      // No Claude key in tests, so each call fails upstream, but still counts toward the cap.
      assert.equal((await chat()).status, 503)
      assert.equal((await chat()).status, 503)
      const capped = await chat()
      assert.equal(capped.status, 429)
      assert.match(capped.body.error, /Daily agent limit/)

      const huge = await api('POST', '/shop/payments', { amount: '1', label: 'x'.repeat(100_000) }, tillToken)
      assert.equal(huge.status, 413)
      assert.equal((await fetch(`${API}/favicon.png`)).headers.get('content-type'), 'image/png')
      assert.deepEqual(await (await fetch(`${API}/ready`)).json(), { ok: true, database: 'ok', solana: 'ok', cluster: 'devnet' })
      assert.match(await (await fetch(`${API}/privacy`)).text(), /Privacy at Tilltide/)
      assert.match(await (await fetch(`${API}/terms`)).text(), /Tilltide never holds your money/)
      assert.deepEqual(await (await fetch(`${API}/.well-known/assetlinks.json`)).json(), [])
      const headers = (await fetch(`${API}/health`)).headers
      assert.equal(headers.get('x-content-type-options'), 'nosniff')
    })

    await step('watcher expires abandoned requests', async () => {
      const created = await api('POST', '/shop/payments', { amount: '1' }, tillToken)
      await sql`update payments set created_at = now() - interval '31 minutes' where id = ${created.body.id}`
      await until('expired', async () => (await sql`select status from payments where id = ${created.body.id}`)[0]!.status === 'expired')
    })

    await step('PayPal loyalty: PayPal customers earn points, get a code on the receipt, and spend it on a PayPal bill', async () => {
      const creamTea = (await sql<any[]>`select id from payments where label = 'Cream tea'`)[0].id
      const receipt = await fetch(`${API}/r/${creamTea}`).then((r) => r.text())
      const code = receipt.match(/<strong[^>]*>([A-Z0-9]{5}-[A-Z0-9]{5})<\/strong>/)?.[1]
      assert.ok(code, 'receipt shows a loyalty code')
      assert.match(receipt, /Your points at Pasty Shop/)
      const { ledgerBalance } = await import('../../src/services/paypal-loyalty')
      const shopId = (await api('GET', '/shop', undefined, tillToken)).body.id
      const before = await ledgerBalance(shopId, 'paypal:BUYER1')
      assert.equal(before, 7n + 3n + 20n, 'points from the three PayPal sales')

      await api('PATCH', '/shop', { pointValue: '0.10' }, tillToken)
      const unknown = await api('POST', '/shop/payments', { amount: '10', rail: 'paypal', loyaltyCode: 'ZZZZZ-ZZZZZ' }, tillToken)
      assert.equal(unknown.status, 400)
      // 30 points x 0.10 = 3.00 off a 10.00 bill (cap 50%). The code is case and dash insensitive.
      const sale = await api('POST', '/shop/payments', { amount: '10', rail: 'paypal', loyaltyCode: code!.toLowerCase().replace('-', '') }, tillToken)
      assert.equal(sale.status, 201, JSON.stringify(sale.body))
      assert.equal(sale.body.pointsRedeemed, '30')
      assert.equal(sale.body.discount, '3000000')
      const orderId = new URL(sale.body.url).searchParams.get('token')!
      assert.equal(paypal.order(orderId).purchase_units[0].amount.value, '7.00')
      // The points are held by the open sale: a second sale with the same code gets none.
      assert.equal(await ledgerBalance(shopId, 'paypal:BUYER1'), 0n)
      const second = await api('POST', '/shop/payments', { amount: '10', rail: 'paypal', loyaltyCode: code }, tillToken)
      assert.equal(second.body.pointsRedeemed, '0')

      paypal.approve(orderId)
      await waitFor(tillToken, sale.body.id, (p) => p.status === 'paid', 'loyalty sale paid')
      // Earned on the 7.00 actually paid.
      await until('ledger points', async () => (await ledgerBalance(shopId, 'paypal:BUYER1')) === 7n)
      await api('PATCH', '/shop', { pointValue: '0.01' }, tillToken)
    })

    await step('prices in pounds: wallet sales convert at the day\'s rate; PayPal charges in GBP', async () => {
      await api('PATCH', '/shop', { currency: 'GBP', token: 'USDC' }, tillToken)
      // £4.00 at £1 = $1.25 is 5.00 USDC, and the QR asks for exactly that.
      const sale = await api('POST', '/shop/payments', { amount: '4.00' }, tillToken)
      assert.equal(sale.status, 201, JSON.stringify(sale.body))
      assert.equal(sale.body.currency, 'GBP')
      assert.equal(sale.body.tokenAmount, '5000000')
      assert.match(sale.body.url, /amount=5&spl-token=/)
      // Paying the £ figure in tokens (4.00 USDC) is an underpayment.
      await payFromUrl(sale.body.url, customer, 4_000_000n)
      await waitFor(tillToken, sale.body.id, (p) => Boolean(p.failureReason), 'short in GBP noted')
      await payFromUrl(sale.body.url, customer)
      const paid = await waitFor(tillToken, sale.body.id, (p) => p.status === 'paid' && p.pointsIssued, 'GBP sale paid')
      assert.equal(paid.points, '4', 'points per £1')
      const receipt = await fetch(`${API}/r/${sale.body.id}`).then((r) => r.text())
      assert.match(receipt, /£4.00/)
      assert.match(receipt, /5.00 USDC/)

      const pp = await api('POST', '/shop/payments', { amount: '6.50', rail: 'paypal' }, tillToken)
      const orderId = new URL(pp.body.url).searchParams.get('token')!
      assert.deepEqual(paypal.order(orderId).purchase_units[0].amount, { currency_code: 'GBP', value: '6.50' })
      assert.equal(paypal.order(orderId).purchase_units[0].payment_instruction.platform_fees[0].amount.currency_code, 'GBP')
      assert.equal((await api('POST', '/shop/payments', { amount: '4.005' }, tillToken)).status, 400, 'whole pence only')
      await api('PATCH', '/shop', { currency: 'USD' }, tillToken)
    })

    await step('end-of-day report and CSV export (one-time link, formula-safe)', async () => {
      const made = await api('POST', '/shop/reports', {}, tillToken)
      assert.equal(made.status, 200, JSON.stringify(made.body))
      assert.match(made.body.text, /from \d+ sales \(PayPal .*, wallet .*\)\. Average sale/)
      assert.match(made.body.text, /refund/)
      assert.equal(made.body.narrative, null, 'no Claude key in tests: facts only')
      const list = await api('GET', '/shop/reports', undefined, tillToken)
      assert.equal(list.body[0].date, made.body.date)
      assert.equal((await api('POST', '/shop/reports', { date: '2026-02-31' }, tillToken)).status, 400)

      // A label someone typed as a spreadsheet formula.
      await api('POST', '/shop/payments', { amount: '1.00', label: '=HYPERLINK("http://evil","x")' }, tillToken)
      const today = made.body.date
      const link = await api('POST', '/shop/export', { from: today, to: today }, tillToken)
      assert.equal(link.status, 200)
      const res = await fetch(link.body.url)
      assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8')
      const csv = await res.text()
      const lines = csv.trim().split('\r\n')
      assert.equal(lines[0], 'date,time,type,status,description,currency,price,points_discount,received,paid_with,token_amount,fx_rate,customer,points_earned,points_spent,tilltide_fee,reference,id')
      assert.ok(lines.some((l) => l.includes(',sale,paid,2 pasties,USD,4.50,')))
      assert.ok(lines.some((l) => l.includes(',refund,completed,')))
      assert.ok(lines.some((l) => l.includes(',sweep to owner,confirmed,')))
      assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""http://evil"",""x"")"`)), 'formula defused')
      assert.equal((await fetch(link.body.url)).status, 404, 'single use')
      assert.equal((await api('POST', '/shop/export', { from: today, to: '2020-01-01' }, tillToken)).status, 400)
    })

    await step('Seeker bonus: a Seeker owner earns the shop\'s multiplier, and the receipt says so', async () => {
      await api('PATCH', '/shop', { seekerBonus: 2, currency: 'USD', token: 'USDC' }, tillToken)
      assert.equal((await api('GET', '/shop', undefined, tillToken)).body.seekerBonus, 2)
      const sale = await api('POST', '/shop/payments', { amount: '3.00' }, tillToken)
      await payFromUrl(sale.body.url, customer)
      const paid = await waitFor(tillToken, sale.body.id, (p) => p.status === 'paid' && p.pointsIssued, 'seeker sale')
      assert.equal(paid.points, '6', '3 points x2')
      assert.equal(paid.seekerBonus, true)
      assert.match(await fetch(`${API}/r/${sale.body.id}`).then((r) => r.text()), /Seeker bonus applied/)
      assert.equal((await api('PATCH', '/shop', { seekerBonus: 5 }, tillToken)).status, 400, 'at most x3')
      await api('PATCH', '/shop', { seekerBonus: 1 }, tillToken)
    })

    await step('migrations re-run cleanly on a database with every sweep status', async () => {
      const merchant = (await sql<any[]>`select * from merchants where wallet = ${till.address}`)[0]
      await sql`insert into sweeps (merchant_id, amount, token_symbol, to_wallet, status) values (${merchant.id}, 1, 'USDC', ${owner.address}, 'failed')`
      await sql.unsafe(await readFile(new URL('../../src/db/schema.sql', import.meta.url), 'utf8'))
    })

    console.log(`\nAll ${passed} end-to-end checks passed.`)
    await sql.end()
  } finally {
    server?.close()
    stopValidator()
    await new Promise((r) => setTimeout(r, 2000))
    rmSync(dir, { recursive: true, force: true })
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nFAILED:', err)
    process.exit(1)
  },
)
