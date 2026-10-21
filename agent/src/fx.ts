/**
 * Exchange rates from the shop's currency to US dollars (USDC and PYUSD are 1:1 with USD).
 * Rates are European Central Bank reference rates via Frankfurter, cached for 10 minutes; a stale
 * rate up to 24 hours old is used if the feed is down. FX_RATES fixes rates (tests, the sandbox).
 */
export type ShopCurrency = 'GBP' | 'USD' | 'EUR'
export const SHOP_CURRENCIES: ShopCurrency[] = ['GBP', 'USD', 'EUR']

/** Micro-units: tokens (USD) per 1 unit of the shop's currency, × 1,000,000. */
export type MicroRate = bigint

const FRESH_MS = 10 * 60 * 1000
const STALE_MS = 24 * 60 * 60 * 1000
const cache = new Map<ShopCurrency, { rate: MicroRate; at: number }>()

function fixedRates(): Map<string, MicroRate> {
  const out = new Map<string, MicroRate>()
  for (const pair of (process.env.FX_RATES ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [code, value] = pair.split(':')
    if (code && value && /^\d+(\.\d{1,6})?$/.test(value)) out.set(code.toUpperCase(), BigInt(Math.round(Number(value) * 1e6)))
  }
  return out
}

export class FxError extends Error {}

export async function usdPerUnit(currency: ShopCurrency, fetchImpl: typeof fetch = fetch): Promise<MicroRate> {
  if (currency === 'USD') return 1_000_000n
  const fixed = fixedRates().get(currency)
  if (fixed) return fixed
  const cached = cache.get(currency)
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.rate
  try {
    const res = await fetchImpl(`https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=USD`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { rates?: { USD?: number } }
    const usd = body.rates?.USD
    if (typeof usd !== 'number' || !(usd > 0)) throw new Error('No USD rate')
    const rate = BigInt(Math.round(usd * 1e6))
    cache.set(currency, { rate, at: Date.now() })
    return rate
  } catch (err) {
    if (cached && Date.now() - cached.at < STALE_MS) return cached.rate
    throw new FxError(`Can't get the ${currency} exchange rate right now (${err instanceof Error ? err.message : err})`)
  }
}

/** Shop-currency amount (6-dp units) → token amount (6-dp units), rounded up to a whole cent. */
export function toTokenUnits(amount: bigint, rate: MicroRate): bigint {
  const exact = (amount * rate + 999_999n) / 1_000_000n
  return ((exact + 9_999n) / 10_000n) * 10_000n
}

/** Token amount → shop-currency amount at the sale's rate (rounded down). */
export function fromTokenUnits(tokens: bigint, rate: MicroRate): bigint {
  return (tokens * 1_000_000n) / rate
}

/** For tests only. */
export function _clearFxCache() {
  cache.clear()
}
