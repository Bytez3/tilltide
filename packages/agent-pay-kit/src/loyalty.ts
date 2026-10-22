import type { Address, Instruction, TransactionSigner } from '@solana/kit'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'

export interface PointsRule {
  /** Points earned per 1 whole payment token (e.g. 1 point per 1 USDC). */
  pointsPerUnit: number
  /** Multiplier applied when the customer qualifies for a bonus (e.g. Seeker / SKR holders). */
  bonusMultiplier?: number
}

/** Whole points for a payment. Rounds down, so partial units never earn a point. */
export function calculatePoints(amount: bigint, decimals: number, rule: PointsRule, bonus = false): bigint {
  // Rates are exact to hundredths of a point (e.g. 1.25); finer rates are rounded to the nearest 0.01.
  if (!Number.isFinite(rule.pointsPerUnit) || rule.pointsPerUnit < 0) throw new Error('pointsPerUnit must be a number >= 0')
  if (rule.bonusMultiplier !== undefined && (!Number.isFinite(rule.bonusMultiplier) || rule.bonusMultiplier < 0)) {
    throw new Error('bonusMultiplier must be a number >= 0')
  }
  // Work in hundredths of a point so rates like 1.5 points per unit stay exact.
  const rateHundredths = BigInt(Math.round(rule.pointsPerUnit * 100))
  const multiplierHundredths = BigInt(Math.round((bonus ? (rule.bonusMultiplier ?? 1) : 1) * 100))
  return (amount * rateHundredths * multiplierHundredths) / (10n ** BigInt(decimals) * 10_000n)
}

export interface IssuePointsInput {
  /** Pays fees and rent for the customer's points account. */
  payer: TransactionSigner
  /** Mint authority of the points token. Server-side only. */
  mintAuthority: TransactionSigner
  pointsMint: Address
  customer: Address
  points: bigint
}

/** Instructions that create the customer's points account if needed and mint points into it. */
export async function getIssuePointsInstructions(input: IssuePointsInput): Promise<Instruction[]> {
  const [customerAta] = await findAssociatedTokenPda({
    owner: input.customer,
    mint: input.pointsMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: input.payer,
      owner: input.customer,
      mint: input.pointsMint,
    }),
    getMintToInstruction({
      mint: input.pointsMint,
      token: customerAta,
      mintAuthority: input.mintAuthority,
      amount: input.points,
    }),
  ]
}
