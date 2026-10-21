import { afterEach, describe, expect, it } from 'vitest'
import { _clearFxCache, fromTokenUnits, toTokenUnits, usdPerUnit } from '../src/fx'

afterEach(() => {
  _clearFxCache()
  delete process.env.FX_RATES
})

describe('fx', () => {
  it('USD is 1:1 with stablecoins', async () => {
    expect(await usdPerUnit('USD')).toBe(1_000_000n)
  })

  it('reads the ECB rate and caches it', async () => {
    let calls = 0
    const fake = (async () => {
      calls++
      return new Response(JSON.stringify({ base: 'GBP', rates: { USD: 1.3347 } }))
    }) as typeof fetch
    expect(await usdPerUnit('GBP', fake)).toBe(1_334_700n)
    expect(await usdPerUnit('GBP', fake)).toBe(1_334_700n)
    expect(calls).toBe(1)
  })

  it('fails clearly when the feed is down and nothing is cached', async () => {
    const down = (async () => new Response('nope', { status: 503 })) as typeof fetch
    await expect(usdPerUnit('EUR', down)).rejects.toThrow(/Can't get the EUR exchange rate/)
  })

  it('honours fixed rates', async () => {
    process.env.FX_RATES = 'GBP:1.25'
    expect(await usdPerUnit('GBP')).toBe(1_250_000n)
  })

  it('converts to tokens rounding up to a whole cent, and back', () => {
    expect(toTokenUnits(4_500_000n, 1_334_700n)).toBe(6_010_000n) // £4.50 → 6.006... → 6.01
    expect(toTokenUnits(4_000_000n, 1_250_000n)).toBe(5_000_000n)
    expect(toTokenUnits(1_000_000n, 1_000_000n)).toBe(1_000_000n)
    expect(fromTokenUnits(5_000_000n, 1_250_000n)).toBe(4_000_000n)
  })
})
