import type { Address, Instruction, TransactionSigner } from '@solana/kit'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from '@solana-program/token'
import type { PaymentToken } from './tokens'

export interface SweepInput {
  /** The merchant's wallet. Signs through Mobile Wallet Adapter, never as a raw key. */
  from: TransactionSigner
  to: Address
  token: PaymentToken
  amount: bigint
}

/**
 * Instructions to move takings from the till wallet to the owner's wallet.
 * The agent only ever proposes these; the merchant signs them on their phone.
 */
export async function getSweepInstructions({ from, to, token, amount }: SweepInput): Promise<Instruction[]> {
  if (amount <= 0n) throw new Error('Sweep amount must be positive')
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
      { source, mint: token.mint, destination, authority: from, amount, decimals: token.decimals },
      config,
    ),
  ]
}
