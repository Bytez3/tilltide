import postgres from 'postgres'
import { config } from '../config'

export const sql = postgres(config.databaseUrl, {
  // numeric columns hold token base units; keep them as strings and convert to bigint ourselves.
  types: { bigint: postgres.BigInt },
  transform: postgres.camel,
})

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired'
export type SweepStatus = 'proposed' | 'confirmed' | 'cancelled'

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
  rail: 'solana'
  reference: string
  amount: bigint
  tokenSymbol: 'USDC' | 'PYUSD'
  label: string | null
  status: PaymentStatus
  signature: string | null
  payer: string | null
  failureReason: string | null
  points: bigint | null
  pointsSignature: string | null
  createdAt: Date
  paidAt: Date | null
}

export interface SweepRow {
  id: string
  merchantId: string
  amount: bigint
  tokenSymbol: 'USDC' | 'PYUSD'
  toWallet: string
  reason: string | null
  status: SweepStatus
  signature: string | null
  createdAt: Date
}
