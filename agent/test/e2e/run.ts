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
      APP_API_KEY: 'e2e-key',
      PORT: String(API_PORT),
      POINTS_AUTHORITY_SECRET: JSON.stringify([...pointsAuthorityBytes]),
    })
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
    server = { close: () => (stopWatcher(), http.close()) }

    async function api<T = any>(method: string, path: string, body?: unknown, key = 'e2e-key'): Promise<{ status: number; body: T }> {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json().catch(() => null)) as T }
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

    let merchantId = ''

    await step('rejects requests without the app key', async () => {
      const r = await api('POST', '/merchants', { name: 'x', wallet: till.address }, 'wrong')
      assert.equal(r.status, 401)
    })

    await step('registers the shop and sets the owner wallet', async () => {
      const r = await api('POST', '/merchants', { name: 'Pasty Shop', wallet: till.address })
      assert.equal(r.status, 200)
      merchantId = r.body.id
      const again = await api('POST', '/merchants', { name: 'Other name', wallet: till.address })
      assert.equal(again.body.id, merchantId, 'registering the same wallet returns the same shop')
      const p = await api('PATCH', `/merchants/${merchantId}`, { ownerWallet: owner.address, pointsPerUnit: 1 })
      assert.equal(p.body.ownerWallet, owner.address)
      assert.equal((await api('PATCH', `/merchants/${merchantId}`, { timezone: 'Mars/Olympus' })).status, 400)
    })

    let firstPaymentId = ''
    await step('USDC: QR request → customer pays → Paid ✓ with payer and points', async () => {
      const created = await api('POST', `/merchants/${merchantId}/payments`, { amount: '4.50', label: '2 pasties' })
      assert.equal(created.status, 201)
      firstPaymentId = created.body.id
      assert.match(created.body.url, new RegExp(`^solana:${till.address}\\?amount=4.5&spl-token=${USDC}&reference=`))
      assert.equal((await api('GET', `/payments/${firstPaymentId}`)).body.status, 'pending')

      await payFromUrl(created.body.url, customer)
      const paid = await until('paid', async () => {
        const r = await api('GET', `/payments/${firstPaymentId}`)
        return r.body.status === 'paid' && r.body.pointsIssued ? r.body : null
      })
      assert.equal(paid.payer, customer.address)
      assert.equal(paid.points, '4')
      assert.equal(await tokenBalance(customer.address, pointsMint.address, TOKEN), 4n)
      assert.equal(await tokenBalance(till.address, USDC, TOKEN), 4_500_000n)
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
      // Pretend the server crashed after sending: status 'sending' with the real (confirmed) signature.
      await sql`update payments set points_status = 'sending', points_claimed_at = now() - interval '10 minutes' where id = ${firstPaymentId}`
      const settled = await issuePointsForPayment(firstPaymentId)
      assert.equal(settled.issued, true)
      assert.equal(await tokenBalance(customer.address, pointsMint.address, TOKEN), 4n, 'no second mint')
      const [row] = await sql`select points_status from payments where id = ${firstPaymentId}`
      assert.equal(row!.pointsStatus, 'issued')
    })

    await step('underpayment is marked failed, not paid', async () => {
      const created = await api('POST', `/merchants/${merchantId}/payments`, { amount: '10' })
      await payFromUrl(created.body.url, customer, 5_000_000n)
      const failed = await until('failed', async () => {
        const r = await api('GET', `/payments/${created.body.id}`)
        return r.body.status === 'failed' ? r.body : null
      })
      assert.match(failed.failureReason, /received 5000000, expected 10000000/)
    })

    await step('a customer who pays after the request expired is still recorded as paid', async () => {
      const created = await api('POST', `/merchants/${merchantId}/payments`, { amount: '2' })
      await sql`update payments set status = 'expired' where id = ${created.body.id}`
      await payFromUrl(created.body.url, customer)
      const paid = await until('late paid', async () => {
        const r = await api('GET', `/payments/${created.body.id}`)
        return r.body.status === 'paid' ? r.body : null
      })
      assert.equal(paid.payer, customer.address)
    })

    await step('validation errors are 400s, not crashes', async () => {
      assert.equal((await api('POST', `/merchants/${merchantId}/payments`, { amount: '1.0000001' })).status, 400)
      assert.equal((await api('POST', `/merchants/${merchantId}/payments`, { amount: '0' })).status, 400)
      assert.equal((await api('POST', `/merchants/${merchantId}/payments`, { amount: 'abc' })).status, 400)
      assert.equal((await api('POST', `/merchants/${merchantId}/payments`, { amount: '1', rail: 'paypal' })).status, 400)
      assert.equal((await api('GET', `/merchants/${merchantId}/summary?date=yesterday`)).status, 400)
      assert.equal((await api('GET', `/payments/not-a-uuid`)).status, 404)
      assert.equal((await api('GET', `/merchants/not-a-uuid`)).status, 404)
      assert.equal((await api('POST', `/sweeps/not-a-uuid/confirm`, { signature: 'x'.repeat(88) })).status, 404)
      assert.equal((await api('GET', `/points/not-an-address`)).status, 400)
    })

    await step('summary and reconciliation match the chain; outside transfers are flagged', async () => {
      // A transfer into the till without a Tilltide reference.
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
      const r = await api('GET', `/merchants/${merchantId}/summary?reconcile=true`)
      assert.equal(r.status, 200)
      const { summary, reconciliation } = r.body
      assert.equal(summary.takings, '6.5')
      assert.equal(summary.paidCount, 2)
      assert.equal(summary.uniqueCustomers, 1)
      assert.equal(summary.failed.length, 1)
      assert.deepEqual(summary.paymentsMissingPoints, [])
      // 4.50 + 5 (underpaid, still received) + 2 + 1 (outside) = 12.50
      assert.equal(reconciliation.tillBalance, '12.5')
      assert.equal(reconciliation.onchainActivityNotInLedger.length, 1)
    })

    await step('sweep: proposal → till signs (as MWA would) → verified onchain → confirmed', async () => {
      const { proposeSweep, serializeSweep } = await import('../../src/services/sweeps')
      const { getMerchant } = await import('../../src/services/merchants')
      const { getSweepInstructions, TOKENS } = await import('@tilltide/agent-pay-kit')
      const merchant = (await getMerchant(merchantId))!

      await assert.rejects(proposeSweep(merchant, 1_000_000_000n, null), /only holds 12.5 USDC/)
      const sweep = serializeSweep(await proposeSweep(merchant, 10_000_000n, 'End of day'))
      assert.equal(sweep.status, 'proposed')

      const signature = await send(
        till,
        await getSweepInstructions({ from: till, to: owner.address, token: TOKENS.devnet.USDC, amount: BigInt(sweep.amount) }),
      )
      const confirmed = await api('POST', `/sweeps/${sweep.id}/confirm`, { signature })
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
      assert.equal(confirmed.body.status, 'confirmed')
      assert.equal(await tokenBalance(owner.address, USDC, TOKEN), 10_000_000n)

      // The same signature can't confirm a second proposal.
      const second = serializeSweep(await proposeSweep(merchant, 1_000_000n, null))
      const replay = await api('POST', `/sweeps/${second.id}/confirm`, { signature })
      assert.equal(replay.status, 400)

      // A customer payment to the owner isn't a sweep from the till.
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
      const wrongSource = await api('POST', `/sweeps/${second.id}/confirm`, { signature: notFromTill })
      assert.equal(wrongSource.status, 400)
      assert.match(wrongSource.body.error, /not sent from the till/)
      assert.equal((await api('POST', `/sweeps/${second.id}/cancel`)).body.status, 'cancelled')

      const recon = await api('GET', `/merchants/${merchantId}/summary?reconcile=true`)
      assert.equal(recon.body.reconciliation.sweptToOwnerToday, '10')
      assert.equal(recon.body.reconciliation.onchainActivityNotInLedger.length, 1, 'the sweep is not flagged')
    })

    await step('PYUSD (Token-2022): pay, verify, points, sweep', async () => {
      await api('PATCH', `/merchants/${merchantId}`, { token: 'PYUSD' })
      const created = await api('POST', `/merchants/${merchantId}/payments`, { amount: '3.25' })
      assert.match(created.body.url, new RegExp(`spl-token=${PYUSD}`))
      await payFromUrl(created.body.url, customer)
      const paid = await until('PYUSD paid', async () => {
        const r = await api('GET', `/payments/${created.body.id}`)
        return r.body.status === 'paid' && r.body.pointsIssued ? r.body : null
      })
      assert.equal(paid.token, 'PYUSD')
      assert.equal(paid.points, '3')
      assert.equal(await tokenBalance(till.address, PYUSD, TOKEN_2022), 3_250_000n)

      const { proposeSweep, serializeSweep } = await import('../../src/services/sweeps')
      const { getMerchant } = await import('../../src/services/merchants')
      const { getSweepInstructions, TOKENS } = await import('@tilltide/agent-pay-kit')
      const sweep = serializeSweep(await proposeSweep((await getMerchant(merchantId))!, 3_250_000n, null))
      const signature = await send(
        till,
        await getSweepInstructions({ from: till, to: owner.address, token: TOKENS.devnet.PYUSD, amount: 3_250_000n }),
      )
      assert.equal((await api('POST', `/sweeps/${sweep.id}/confirm`, { signature })).body.status, 'confirmed')
      assert.equal(await tokenBalance(owner.address, PYUSD, TOKEN_2022), 3_250_000n)
    })

    await step('customer points lookup', async () => {
      const r = await api('GET', `/points/${customer.address}`)
      assert.deepEqual(r.body, { wallet: customer.address, points: '9', configured: true })
    })

    await step('watcher expires abandoned requests', async () => {
      const created = await api('POST', `/merchants/${merchantId}/payments`, { amount: '1' })
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
