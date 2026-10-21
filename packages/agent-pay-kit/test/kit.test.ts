import { describe, expect, it } from 'vitest'
import { address } from '@solana/kit'
import {
  calculatePoints,
  sweepFee,
  planRedemption,
  encodeTransactionRequest,
  encodeTransferRequest,
  fromBaseUnits,
  parseTransferRequest,
  toBaseUnits,
  TOKENS,
} from '../src'

const USDC = TOKENS.devnet.USDC
const recipient = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
const reference = address('5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG')

describe('amounts', () => {
  it('round-trips decimal strings through base units', () => {
    expect(toBaseUnits('12.5', 6)).toBe(12_500_000n)
    expect(toBaseUnits('0.000001', 6)).toBe(1n)
    expect(toBaseUnits('3', 6)).toBe(3_000_000n)
    expect(fromBaseUnits(12_500_000n, 6)).toBe('12.5')
    expect(fromBaseUnits(3_000_000n, 6)).toBe('3')
    expect(fromBaseUnits(1n, 6)).toBe('0.000001')
  })

  it('rejects bad input', () => {
    expect(() => toBaseUnits('1.0000001', 6)).toThrow()
    expect(() => toBaseUnits('-1', 6)).toThrow()
    expect(() => toBaseUnits('abc', 6)).toThrow()
  })
})

describe('solana pay', () => {
  it('encodes a spec-compliant transfer request and parses it back', () => {
    const url = encodeTransferRequest({
      recipient,
      amount: 4_250_000n,
      token: USDC,
      reference,
      label: 'Pasty Shop',
      message: 'Order 42',
    })
    expect(url).toBe(
      `solana:${recipient}?amount=4.25&spl-token=${USDC.mint}&reference=${reference}&label=Pasty%20Shop&message=Order%2042`,
    )
    const parsed = parseTransferRequest(url)
    expect(parsed.recipient).toBe(recipient)
    expect(parsed.amount).toBe('4.25')
    expect(parsed.splToken).toBe(USDC.mint)
    expect(parsed.references).toEqual([reference])
    expect(parsed.label).toBe('Pasty Shop')
  })
})

describe('loyalty points', () => {
  it('awards whole points at the merchant rate', () => {
    expect(calculatePoints(toBaseUnits('4.99', 6), 6, { pointsPerUnit: 1 })).toBe(4n)
    expect(calculatePoints(toBaseUnits('10', 6), 6, { pointsPerUnit: 1.5 })).toBe(15n)
    expect(calculatePoints(toBaseUnits('0.5', 6), 6, { pointsPerUnit: 1 })).toBe(0n)
  })

  it('applies the bonus multiplier only for bonus customers', () => {
    const rule = { pointsPerUnit: 1, bonusMultiplier: 2 }
    expect(calculatePoints(toBaseUnits('10', 6), 6, rule, false)).toBe(10n)
    expect(calculatePoints(toBaseUnits('10', 6), 6, rule, true)).toBe(20n)
  })
})

describe('sweep fee', () => {
  it('takes basis points of the gross amount, rounded down', () => {
    expect(sweepFee(100_000_000n, 50)).toBe(500_000n) // 0.5% of 100 USDC
    expect(sweepFee(199n, 50)).toBe(0n)
    expect(sweepFee(100_000_000n, 0)).toBe(0n)
    expect(() => sweepFee(1n, -1)).toThrow()
    expect(() => sweepFee(1n, 1.5)).toThrow()
  })
})

describe('points redemption', () => {
  const rule = { pointValue: 100_000n, maxPercent: 50 } // 1 point = 0.10, up to half the bill

  it('spends as many points as the cap allows, rounding down', () => {
    expect(planRedemption(2_000_000n, 9n, rule)).toEqual({ points: 9n, discount: 900_000n, toPay: 1_100_000n })
    expect(planRedemption(2_000_000n, 500n, rule)).toEqual({ points: 10n, discount: 1_000_000n, toPay: 1_000_000n })
    expect(planRedemption(150_000n, 500n, rule)).toEqual({ points: 0n, discount: 0n, toPay: 150_000n })
  })

  it('does nothing without points or a point value', () => {
    expect(planRedemption(2_000_000n, 0n, rule).points).toBe(0n)
    expect(planRedemption(2_000_000n, 9n, { pointValue: 0n, maxPercent: 50 }).toPay).toBe(2_000_000n)
  })

  it('encodes a Solana Pay transaction request link', () => {
    expect(encodeTransactionRequest('https://api.example/pay/abc?x=1')).toBe('solana:https%3A%2F%2Fapi.example%2Fpay%2Fabc%3Fx%3D1')
    expect(() => encodeTransactionRequest('ftp://nope')).toThrow()
  })
})
