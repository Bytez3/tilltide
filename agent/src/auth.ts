/**
 * Sign In With Solana. The app asks the till wallet (over MWA) to sign a SIWS message carrying a
 * one-time nonce; the server verifies the signature and issues a session token for that wallet.
 * Every merchant route is then scoped to the shop that wallet owns.
 */
import { createHash, randomBytes } from 'node:crypto'
import { address, getPublicKeyFromAddress, isAddress, verifySignature, type SignatureBytes } from '@solana/kit'
import { config } from './config'
import { sql } from './db'

const NONCE_TTL_MS = 10 * 60 * 1000
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

/** Verifies a signed SIWS message and returns a new session token for the wallet. */
export async function verifySignIn(input: { address: string; signedMessage: Uint8Array; signature: Uint8Array }) {
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
  if (!message.startsWith(header)) throw new AuthError('Sign-in message is for a different site or wallet')

  const issuedAt = field(message, 'Issued At')
  if (issuedAt && Math.abs(Date.now() - Date.parse(issuedAt)) > NONCE_TTL_MS) throw new AuthError('Sign-in message is too old')
  const expiresAt = field(message, 'Expiration Time')
  if (expiresAt && Date.parse(expiresAt) < Date.now()) throw new AuthError('Sign-in message has expired')

  const nonce = field(message, 'Nonce')
  if (!nonce) throw new AuthError('Sign-in message has no nonce')
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
