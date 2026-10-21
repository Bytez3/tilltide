/**
 * Sign In With Solana. The app asks the till wallet (over MWA) to sign a SIWS message carrying a
 * one-time nonce; the server verifies the signature and issues a session token for that wallet.
 * Every merchant route is then scoped to the shop that wallet owns.
 */
import { createHash, randomBytes } from 'node:crypto'
import { address, getPublicKeyFromAddress, isAddress, verifySignature, type SignatureBytes } from '@solana/kit'
import { config } from './config'
import { sql } from './db'

const NONCE_TTL_MS = 10 * 60 * 1000 // how long a nonce can wait to be signed
const SESSION_TTL_DAYS = 30

export const SIGN_IN_STATEMENT = 'Sign in to Tilltide to run your shop.'

export async function createNonce() {
  const nonce = randomBytes(16).toString('hex')
  await sql`insert into auth_nonces (nonce) values (${nonce})`
  await sql`delete from auth_nonces where created_at < now() - interval '1 day'`
  return { nonce, domain: config.authDomain, statement: SIGN_IN_STATEMENT }
}

function field(message: string, name: string): string | null {
  return message.match(new RegExp(`\\n${name}: ([^\\n]+)`))?.[1]?.trim() ?? null
}

export class AuthError extends Error {}

/**
 * Checks a Sign In With Solana message: the signature is the wallet's, and it was made for this site
 * and cluster. Returns the wallet, the message text and its nonce. Nonce bookkeeping is the caller's job.
 */
export async function verifySiwsMessage(input: { address: string; signedMessage: Uint8Array; signature: Uint8Array }) {
  if (!isAddress(input.address)) throw new AuthError('Not a Solana address')
  if (input.signature.length !== 64) throw new AuthError('Bad signature')
  const wallet = address(input.address)

  const valid = await verifySignature(
    await getPublicKeyFromAddress(wallet),
    input.signature as SignatureBytes,
    input.signedMessage,
  )
  if (!valid) throw new AuthError('Signature does not match the wallet')

  const message = new TextDecoder().decode(input.signedMessage)
  const header = `${config.authDomain} wants you to sign in with your Solana account:\n${wallet}`
  if (!message.startsWith(header)) throw new AuthError('Signed message is for a different site or wallet')

  // Freshness comes from single-use nonces, not timestamps: shop phones often have the wrong clock.
  const uri = field(message, 'URI')
  if (uri) {
    let host: string | null = null
    try {
      host = new URL(uri).host
    } catch {}
    if (host !== config.authDomain) throw new AuthError('Signed message is for a different site')
  }
  const chainId = field(message, 'Chain ID')
  if (chainId && chainId.replace(/^solana:/, '') !== config.cluster) {
    throw new AuthError(`Signed message is for ${chainId}, not ${config.cluster}`)
  }
  const nonce = field(message, 'Nonce')
  if (!nonce) throw new AuthError('Signed message has no nonce')
  return { wallet, message, nonce }
}

/** Verifies a SIWS sign-in and returns a new session token for the wallet. */
export async function verifySignIn(input: { address: string; signedMessage: Uint8Array; signature: Uint8Array }) {
  const { wallet, nonce } = await verifySiwsMessage(input)
  // Single use: deleting it is the check.
  const [used] = await sql`
    delete from auth_nonces where nonce = ${nonce} and created_at > now() - ${`${NONCE_TTL_MS / 1000} seconds`}::interval
    returning nonce`
  if (!used) throw new AuthError('Sign-in nonce is unknown, used or expired')

  const token = randomBytes(32).toString('base64url')
  await sql`
    insert into sessions (token_hash, wallet, expires_at)
    values (${hashToken(token)}, ${wallet}, now() + ${`${SESSION_TTL_DAYS} days`}::interval)`
  return { token, wallet }
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

/** The wallet a bearer token belongs to, or null. */
export async function walletForToken(token: string): Promise<string | null> {
  const [row] = await sql<{ wallet: string }[]>`
    select wallet from sessions where token_hash = ${hashToken(token)} and expires_at > now()`
  return row?.wallet ?? null
}

export async function revokeToken(token: string) {
  await sql`delete from sessions where token_hash = ${hashToken(token)}`
}
