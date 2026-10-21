import type { Address, Instruction, TransactionSigner } from '@solana/kit'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from '@solana-program/token'
import { getAddMemoInstruction, LEGACY_MEMO_PROGRAM_ADDRESS_V3 } from '@solana-program/memo'
import type { PaymentToken } from './tokens'

/** Every sweep carries this memo, so the backend can tell it apart from any other transfer to the owner. */
export function sweepMemo(sweepId: string): string {
  return `tilltide:sweep:${sweepId}`
}

/** The platform fee on a sweep: `bps` basis points of the gross amount, rounded down. */
export function sweepFee(gross: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('Fee must be 0–10000 basis points')
  return (gross * BigInt(bps)) / 10_000n
}

export interface SweepInput {
  /** The merchant's wallet. Signs through Mobile Wallet Adapter, never as a raw key. */
  from: TransactionSigner
  to: Address
  token: PaymentToken
  /** Gross amount leaving the till. The owner receives `amount - fee.amount`. */
  amount: bigint
  /** Optional platform fee, paid in the same transaction so the owner sees and signs both. */
  fee?: { to: Address; amount: bigint }
  /** The sweep's id. Written onchain as a memo (see `sweepMemo`). */
  sweepId: string
}

/**
 * Instructions to move takings from the till wallet to the owner's wallet.
 * The agent only ever proposes these; the merchant signs them on their phone.
 */
export async function getSweepInstructions({ from, to, token, amount, fee, sweepId }: SweepInput): Promise<Instruction[]> {
  if (amount <= 0n) throw new Error('Sweep amount must be positive')
  const feeAmount = fee?.amount ?? 0n
  if (feeAmount < 0n || feeAmount >= amount) throw new Error('Fee must be less than the sweep amount')
  const config = { programAddress: token.tokenProgram }
  const [source] = await findAssociatedTokenPda({ owner: from.address, mint: token.mint, tokenProgram: token.tokenProgram })
  const [destination] = await findAssociatedTokenPda({ owner: to, mint: token.mint, tokenProgram: token.tokenProgram })
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: from,
      owner: to,
      mint: token.mint,
      tokenProgram: token.tokenProgram,
    }),
    getTransferCheckedInstruction(
      { source, mint: token.mint, destination, authority: from, amount: amount - feeAmount, decimals: token.decimals },
      config,
    ),
    ...(fee && feeAmount > 0n ? await feeInstructions(from, fee.to, feeAmount, token, source) : []),
    // v3 Memo program: deployed on every cluster and the local test validator, and parsed by RPC nodes.
    getAddMemoInstruction({ memo: sweepMemo(sweepId) }, { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 }),
  ]
}

async function feeInstructions(from: TransactionSigner, to: Address, amount: bigint, token: PaymentToken, source: Address) {
  const [destination] = await findAssociatedTokenPda({ owner: to, mint: token.mint, tokenProgram: token.tokenProgram })
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: from, owner: to, mint: token.mint, tokenProgram: token.tokenProgram }),
    getTransferCheckedInstruction(
      { source, mint: token.mint, destination, authority: from, amount, decimals: token.decimals },
      { programAddress: token.tokenProgram },
    ),
  ]
}
