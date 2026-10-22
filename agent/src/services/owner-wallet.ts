/**
 * Changing the owner wallet, where sweeps send the takings. Like a refund, it needs the till wallet to
 * sign the exact wording (Sign In With Solana format, single-use nonce), so a stolen session alone can't
 * redirect the money.
 */
import { randomBytes } from 'node:crypto'
import { verifySiwsMessage } from '../auth'
import { config } from '../config'
import { sql, type MerchantRow } from '../db'

const CHALLENGE_TTL = '10 minutes'

export class OwnerWalletError extends Error {}

export function ownerWalletStatement(wallet: string): string {
  return `Send this shop's takings to ${wallet}. Only this wallet will receive transfers from the till.`
}

/** A fresh single-use challenge naming the new owner wallet. */
export async function ownerWalletChallenge(merchant: MerchantRow, wallet: string) {
  if (wallet === merchant.wallet) throw new OwnerWalletError('The owner wallet must be different from the till wallet')
  const nonce = randomBytes(16).toString('hex')
  await sql`
    update merchants set owner_wallet_pending = ${wallet}, owner_wallet_nonce = ${nonce}, owner_wallet_nonce_at = now()
    where id = ${merchant.id}`
  return { nonce, domain: config.authDomain, statement: ownerWalletStatement(wallet) }
}

/** Sets the owner wallet once the till wallet has signed the challenge for it. */
export async function approveOwnerWallet(merchant: MerchantRow, signed: { signedMessage: Uint8Array; signature: Uint8Array }): Promise<MerchantRow> {
  const { message, nonce } = await verifySiwsMessage({ address: merchant.wallet, ...signed }).catch((e) => {
    throw new OwnerWalletError(e instanceof Error ? e.message : String(e))
  })
  const [pending] = await sql<{ wallet: string | null }[]>`select owner_wallet_pending as wallet from merchants where id = ${merchant.id}`
  if (!pending?.wallet || !message.includes(`\n\n${ownerWalletStatement(pending.wallet)}\n`)) {
    throw new OwnerWalletError('That signature is for a different wallet change')
  }
  const [row] = await sql<MerchantRow[]>`
    update merchants set owner_wallet = owner_wallet_pending,
      owner_wallet_pending = null, owner_wallet_nonce = null, owner_wallet_nonce_at = null
    where id = ${merchant.id} and owner_wallet_nonce = ${nonce} and owner_wallet_pending = ${pending.wallet}
      and owner_wallet_nonce_at > now() - ${CHALLENGE_TTL}::interval
    returning *`
  if (!row) throw new OwnerWalletError('That approval has expired or was already used; try again')
  return row
}
