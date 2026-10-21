import postgres from 'postgres'
import { config } from '../config'

export const sql = postgres(config.databaseUrl, {
  // numeric columns hold token base units; keep them as strings and convert to bigint ourselves.
  types: { bigint: postgres.BigInt },
  transform: postgres.camel,
  // Silence 'already exists, skipping' notices from re-runnable migrations.
  onnotice: () => {},
})

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'void'
export type SweepStatus = 'proposed' | 'signing' | 'submitted' | 'confirmed' | 'cancelled' | 'failed'

export interface MerchantRow {
  id: string
  name: string
  wallet: string
  ownerWallet: string | null
  tokenSymbol: 'USDC' | 'PYUSD'
  pointsPerUnit: string
  bonusMultiplier: string
  timezone: string
  /** Value of one loyalty point in 6-decimal units (10000 = 0.01). */
  pointValue: bigint
  /** The most of a bill (percent) that points can pay for. */
  redeemMaxPercent: number
  /** The shop's own PayPal (partner onboarding), or an email to pay; 'connected' once verified with PayPal. */
  paypalMerchantId: string | null
  paypalEmail: string | null
  paypalStatus: 'none' | 'pending' | 'connected'
  /** Prices, takings and points are in this currency. */
  currency: 'GBP' | 'USD' | 'EUR'
  /** Local closing time (HH:MM) when the end-of-day report is written. */
  closeTime: string
  createdAt: Date
}

export interface PaymentRow {
  id: string
  merchantId: string
  /** 'cash' and 'card' (the shop's own card reader) are recorded sales: paid on creation, no money through Tilltide. */
  rail: 'solana' | 'paypal' | 'cash' | 'card'
  /** Solana Pay reference key. Null for PayPal payments. */
  reference: string | null
  /** The price, in `currency`, 6-decimal units, on every rail. */
  amount: bigint
  /** The shop's currency when the sale was made. */
  currency: 'GBP' | 'USD' | 'EUR'
  /** Wallet sales: tokens (USDC/PYUSD) the customer must send, at `fxRate`. Null for PayPal. */
  tokenAmount: bigint | null
  /** USD (tokens) per 1 unit of `currency`, × 1,000,000. */
  fxRate: bigint
  /** 'USD' for PayPal payments. */
  tokenSymbol: 'USDC' | 'PYUSD' | 'USD'
  label: string | null
  status: PaymentStatus
  signature: string | null
  payer: string | null
  failureReason: string | null
  points: bigint | null
  /** null: not yet issued. 'sending': mint sent, awaiting the chain. 'none': payment earned 0 points. */
  pointsStatus: 'sending' | 'issued' | 'none' | null
  pointsSignature: string | null
  pointsClaimedAt: Date | null
  createdAt: Date
  paidAt: Date | null
  paypalOrderId: string | null
  paypalCaptureId: string | null
  /** The customer may pay part of this bill with points (Solana Pay transaction request). */
  allowPoints: boolean
  pointsRedeemed: bigint
  /** Part of `amount` covered by points. The till received amount - discount. */
  discount: bigint
  /** Points were multiplied by the shop's Seeker bonus. */
  pointsBonus: boolean
  /** Tilltide's platform fee on a PayPal sale (6-decimal units). */
  paypalFee: bigint
  /** For PayPal loyalty: whose points this sale spends ('paypal:<payer id>'). */
  loyaltyKey: string | null
  /** The basket, priced as at the sale. Null when the price was typed on the keypad. */
  items: SaleItem[] | null
}

/** Ledger amounts use 6 decimals on every rail (USDC and PYUSD are 6; PayPal USD is scaled up). */
export const LEDGER_DECIMALS = 6

export interface SweepRow {
  id: string
  merchantId: string
  amount: bigint
  tokenSymbol: 'USDC' | 'PYUSD'
  toWallet: string
  reason: string | null
  status: SweepStatus
  signature: string | null
  submittedAt: Date | null
  /** Part of `amount` that goes to Tilltide's treasury; the owner receives amount - feeAmount. */
  feeAmount: bigint
  feeWallet: string | null
  /** While 'signing': the block height after which the wallet's transaction can no longer land. */
  signingValidUntil: bigint | null
  error: string | null
  createdAt: Date
}

export type RefundStatus = 'proposed' | 'processing' | 'pending' | 'completed' | 'failed' | 'cancelled'

export interface RefundRow {
  id: string
  merchantId: string
  paymentId: string
  /** Ledger units (6 decimals), in `currency`. */
  amount: bigint
  currency: 'GBP' | 'USD' | 'EUR'
  reason: string | null
  status: RefundStatus
  approvalNonce: string | null
  paypalRefundId: string | null
  error: string | null
  createdAt: Date
  approvedAt: Date | null
  executingUntil: Date | null
  paypalAttempts: number
}

/** One line of a sale. `price` is per unit, in 6-decimal units, as a string (JSON has no bigint). `id` is null for a keypad amount. */
export interface SaleItem {
  id: string | null
  name: string
  price: string
  qty: number
}

export interface ItemRow {
  id: string
  merchantId: string
  name: string
  icon: string
  price: bigint
  position: number
  archived: boolean
  createdAt: Date
}
