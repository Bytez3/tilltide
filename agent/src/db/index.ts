import postgres from 'postgres'
import { config } from '../config'

export const sql = postgres(config.databaseUrl, {
  // numeric columns hold token base units; keep them as strings and convert to bigint ourselves.
  types: { bigint: postgres.BigInt },
  transform: postgres.camel,
  // Silence 'already exists, skipping' notices from re-runnable migrations.
  onnotice: () => {},
})

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired'
export type SweepStatus = 'proposed' | 'submitted' | 'confirmed' | 'cancelled'

export interface MerchantRow {
  id: string
  name: string
  wallet: string
  ownerWallet: string | null
  tokenSymbol: 'USDC' | 'PYUSD'
  pointsPerUnit: string
  bonusMultiplier: string
  timezone: string
  createdAt: Date
}

export interface PaymentRow {
  id: string
  merchantId: string
  rail: 'solana' | 'paypal'
  /** Solana Pay reference key. Null for PayPal payments. */
  reference: string | null
  /** 6-decimal base units on every rail. */
  amount: bigint
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
  error: string | null
  createdAt: Date
}
