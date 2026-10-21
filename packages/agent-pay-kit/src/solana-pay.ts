import { address, type Address } from '@solana/kit'
import { fromBaseUnits } from './amount'
import type { PaymentToken } from './tokens'

/** Fields of a Solana Pay transfer request: https://docs.solanapay.com/spec */
export interface TransferRequest {
  recipient: Address
  /** Base units of `token`. */
  amount: bigint
  token: PaymentToken
  /** Unique public key added to the payment so it can be found onchain. */
  reference: Address
  label?: string
  message?: string
  memo?: string
}

export function encodeTransferRequest(req: TransferRequest): string {
  const params = new URLSearchParams()
  params.set('amount', fromBaseUnits(req.amount, req.token.decimals))
  params.set('spl-token', req.token.mint)
  params.set('reference', req.reference)
  if (req.label) params.set('label', req.label)
  if (req.message) params.set('message', req.message)
  if (req.memo) params.set('memo', req.memo)
  // URLSearchParams encodes spaces as "+", which the Solana Pay spec doesn't accept.
  return `solana:${req.recipient}?${params.toString().replace(/\+/g, '%20')}`
}

export interface ParsedTransferRequest {
  recipient: Address
  amount?: string
  splToken?: Address
  references: Address[]
  label?: string
  message?: string
  memo?: string
}

export function parseTransferRequest(url: string): ParsedTransferRequest {
  if (!url.startsWith('solana:')) throw new Error('Not a Solana Pay URL')
  const [path = '', query = ''] = url.slice('solana:'.length).split('?')
  const params = new URLSearchParams(query)
  const splToken = params.get('spl-token')
  return {
    recipient: address(decodeURIComponent(path)),
    amount: params.get('amount') ?? undefined,
    splToken: splToken ? address(splToken) : undefined,
    references: params.getAll('reference').map((r) => address(r)),
    label: params.get('label') ?? undefined,
    message: params.get('message') ?? undefined,
    memo: params.get('memo') ?? undefined,
  }
}
