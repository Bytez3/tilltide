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
  const rest = url.slice('solana:'.length)
  // Split at the first '?' only: later '?' characters are legal inside query values.
  const q = rest.indexOf('?')
  const path = q === -1 ? rest : rest.slice(0, q)
  const query = q === -1 ? '' : rest.slice(q + 1)
  // Decode each value with decodeURIComponent, so a literal '+' stays '+' (URLSearchParams would make it a space).
  const params = new Map<string, string[]>()
  for (const pair of query.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=')
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq))
    const value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1))
    params.set(key, [...(params.get(key) ?? []), value])
  }
  const get = (key: string) => params.get(key)?.[0]
  const amount = get('amount')
  // The spec allows only a plain non-negative decimal amount: no exponents, signs or spaces.
  if (amount !== undefined && !/^\d+(\.\d+)?$/.test(amount)) throw new Error(`Invalid amount in Solana Pay URL: ${amount}`)
  const splToken = get('spl-token')
  return {
    recipient: address(decodeURIComponent(path)),
    amount,
    splToken: splToken ? address(splToken) : undefined,
    references: (params.get('reference') ?? []).map((r) => address(r)),
    label: get('label'),
    message: get('message'),
    memo: get('memo'),
  }
}
