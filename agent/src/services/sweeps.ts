import { address, type Signature } from '@solana/kit'
import { fromBaseUnits, verifyPayment } from '@tilltide/agent-pay-kit'
import { config } from '../config'
import { sql, type MerchantRow, type SweepRow } from '../db'
import { rpc } from '../solana'
import { merchantToken } from './merchants'

/** Records a sweep proposal. Nothing moves until the owner signs it in the app. */
export async function proposeSweep(merchant: MerchantRow, amount: bigint, reason: string | null): Promise<SweepRow> {
  if (!merchant.ownerWallet) throw new Error('No owner wallet set. Add one in Settings first.')
  if (merchant.ownerWallet === merchant.wallet) throw new Error('Owner wallet is the same as the till wallet')
  const token = merchantToken(merchant)
  // One open proposal at a time keeps the confirm step unambiguous.
  await sql`update sweeps set status = 'cancelled' where merchant_id = ${merchant.id} and status = 'proposed'`
  const [row] = await sql<SweepRow[]>`
    insert into sweeps (merchant_id, amount, token_symbol, to_wallet, reason)
    values (${merchant.id}, ${amount.toString()}, ${token.symbol}, ${merchant.ownerWallet}, ${reason})
    returning *`
  return row!
}

/** Marks a sweep confirmed once its signed transaction is verified onchain. */
export async function confirmSweep(sweepId: string, signature: Signature) {
  const [sweep] = await sql<SweepRow[]>`select * from sweeps where id = ${sweepId}`
  if (!sweep) throw new Error('Sweep not found')
  if (sweep.status !== 'proposed') throw new Error(`Sweep is already ${sweep.status}`)
  const result = await verifyPayment(rpc, signature, {
    recipient: address(sweep.toWallet),
    token: config.tokens[sweep.tokenSymbol],
    amount: sweep.amount,
  })
  if (!result.ok) throw new Error(`Sweep transaction did not verify: ${result.reason}`)
  const [updated] = await sql<SweepRow[]>`
    update sweeps set status = 'confirmed', signature = ${signature} where id = ${sweepId} returning *`
  return updated!
}

export function serializeSweep(s: SweepRow) {
  const token = config.tokens[s.tokenSymbol]
  return {
    id: s.id,
    amount: s.amount.toString(),
    display: fromBaseUnits(s.amount, token.decimals),
    decimals: token.decimals,
    token: s.tokenSymbol,
    toWallet: s.toWallet,
    reason: s.reason,
    status: s.status,
    signature: s.signature,
    createdAt: s.createdAt.toISOString(),
  }
}
