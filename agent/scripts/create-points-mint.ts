/**
 * One-off devnet setup: creates a points authority keypair (unless POINTS_AUTHORITY_SECRET is set),
 * funds it with an airdrop, and creates a 0-decimal SPL mint for loyalty points.
 * Prints the env vars to paste into agent/.env.
 */
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createKeyPairSignerFromBytes, generateKeyPairSigner, lamports } from '@solana/kit'
import { getCreateAccountInstruction } from '@solana-program/system'
import { getInitializeMintInstruction, getMintSize, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { config } from '../src/config'
import { rpc, sendAndConfirm } from '../src/solana'

if (config.cluster !== 'devnet') throw new Error('This script only runs on devnet')

const KEY_FILE = '.points-authority.json'

async function loadOrCreateAuthority() {
  if (config.pointsAuthoritySecret) {
    return { signer: await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(config.pointsAuthoritySecret))), secret: config.pointsAuthoritySecret }
  }
  // Reuse a key from an earlier run so a failed airdrop doesn't strand funds on a throwaway key.
  if (existsSync(KEY_FILE)) {
    const secret = readFileSync(KEY_FILE, 'utf8').trim()
    return { signer: await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(secret))), secret }
  }
  // Same 64-byte [private | public] layout as solana-keygen JSON files.
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  const secretBytes = new Uint8Array([...Buffer.from(jwk.d!, 'base64url'), ...Buffer.from(jwk.x!, 'base64url')])
  writeFileSync(KEY_FILE, JSON.stringify([...secretBytes]), { mode: 0o600 })
  return { signer: await createKeyPairSignerFromBytes(secretBytes), secret: JSON.stringify([...secretBytes]) }
}

const { signer: authority, secret } = await loadOrCreateAuthority()
console.log(`Points authority: ${authority.address}`)

const { value: balance } = await rpc.getBalance(authority.address).send()
if (balance < 50_000_000n) {
  console.log('Requesting devnet airdrop…')
  const funded = await rpc
    .requestAirdrop(authority.address, lamports(1_000_000_000n))
    .send()
    .then(() => true)
    .catch(() => false)
  if (funded) {
    for (let i = 0; i < 30; i++) {
      const { value } = await rpc.getBalance(authority.address).send()
      if (value > 0n) break
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  const { value: after } = await rpc.getBalance(authority.address).send()
  if (after < 10_000_000n) {
    console.log(`\nThe devnet faucet is rate-limited. Fund this address with devnet SOL, then rerun:`)
    console.log(`  ${authority.address}`)
    console.log('  https://faucet.solana.com')
    process.exit(1)
  }
}

const mint = await generateKeyPairSigner()
const space = BigInt(getMintSize())
const rent = await rpc.getMinimumBalanceForRentExemption(space).send()
const signature = await sendAndConfirm(authority, [
  getCreateAccountInstruction({ payer: authority, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
  getInitializeMintInstruction({ mint: mint.address, decimals: 0, mintAuthority: authority.address }),
])
console.log(`Created points mint in ${signature}\n`)
console.log(`POINTS_MINT=${mint.address}`)
console.log(`POINTS_AUTHORITY_SECRET=${secret}`)
