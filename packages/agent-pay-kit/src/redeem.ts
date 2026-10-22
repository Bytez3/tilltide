import type { Address, Instruction, TransactionSigner } from '@solana/kit'
import { AccountRole, createNoopSigner } from '@solana/kit'
import {
  findAssociatedTokenPda,
  getBurnCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { getAddMemoInstruction, LEGACY_MEMO_PROGRAM_ADDRESS_V3 } from '@solana-program/memo'
import type { PaymentToken } from './tokens'

/** A Solana Pay transaction request URL: the wallet fetches the transaction from `link`. */
export function encodeTransactionRequest(link: string): string {
  if (!/^https?:\/\//.test(link)) throw new Error('Transaction request link must be http(s)')
  return `solana:${encodeURIComponent(link)}`
}

export interface RedemptionRule {
  /** What one point is worth, in base units of the payment token (e.g. 10_000 = 0.01 USDC). */
  pointValue: bigint
  /** The most of a bill points may cover, in percent (e.g. 50). */
  maxPercent: number
}

/** How many points a customer can spend on a bill, and the discount that buys. Rounds down. */
export function planRedemption(price: bigint, pointsBalance: bigint, rule: RedemptionRule) {
  if (rule.pointValue <= 0n || pointsBalance <= 0n || !Number.isFinite(rule.maxPercent)) return { points: 0n, discount: 0n, toPay: price }
  const cap = (price * BigInt(Math.max(0, Math.min(100, Math.floor(rule.maxPercent))))) / 100n
  const points = [pointsBalance, cap / rule.pointValue].reduce((a, b) => (a < b ? a : b))
  const discount = points * rule.pointValue
  return { points, discount, toPay: price - discount }
}

export interface RedeemPaymentInput {
  /**
   * The customer's wallet: pays, burns the points, and signs. Pass an Address when the transaction is
   * built for someone else's wallet to sign (Solana Pay transaction request); pass their signer otherwise.
   */
  customer: Address | TransactionSigner
  recipient: Address
  token: PaymentToken
  /** Amount of the payment token to send (price minus the points discount). */
  toPay: bigint
  pointsMint: Address
  /** Points to burn (0 decimals). */
  points: bigint
  /** Solana Pay reference, added read-only to the transfer so the payment can be found. */
  reference: Address
  memo: string
}

/** Pays the discounted amount and burns the customer's points, in one transaction they sign. */
export async function getRedeemPaymentInstructions(input: RedeemPaymentInput): Promise<Instruction[]> {
  const { recipient, token } = input
  const signer = typeof input.customer === 'string' ? createNoopSigner(input.customer) : input.customer
  const customer = signer.address
  const [source] = await findAssociatedTokenPda({ owner: customer, mint: token.mint, tokenProgram: token.tokenProgram })
  const [destination] = await findAssociatedTokenPda({ owner: recipient, mint: token.mint, tokenProgram: token.tokenProgram })
  const instructions: Instruction[] = [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: signer,
      owner: recipient,
      mint: token.mint,
      tokenProgram: token.tokenProgram,
    }),
  ]
  if (input.toPay > 0n) {
    const transfer = getTransferCheckedInstruction(
      { source, mint: token.mint, destination, authority: signer, amount: input.toPay, decimals: token.decimals },
      { programAddress: token.tokenProgram },
    )
    instructions.push({ ...transfer, accounts: [...transfer.accounts, { address: input.reference, role: AccountRole.READONLY }] })
  }
  if (input.points > 0n) {
    const [pointsAccount] = await findAssociatedTokenPda({ owner: customer, mint: input.pointsMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    const burn = getBurnCheckedInstruction({ account: pointsAccount, mint: input.pointsMint, authority: signer, amount: input.points, decimals: 0 })
    // Fully covered by points: the reference goes on the burn instead so the payment can still be found.
    instructions.push(input.toPay > 0n ? burn : { ...burn, accounts: [...burn.accounts, { address: input.reference, role: AccountRole.READONLY }] })
  }
  instructions.push(getAddMemoInstruction({ memo: input.memo }, { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 }))
  return instructions
}
