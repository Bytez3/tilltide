import { fromBaseUnits } from '@tilltide/agent-pay-kit'

const SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' }

/** A price in the shop's currency: "£4.50". Unknown codes fall back to "4.50 CODE". */
export function formatMoney(baseUnits: string, decimals: number, currency: string): string {
  const value = Number(fromBaseUnits(BigInt(baseUnits), decimals)).toFixed(2)
  return SYMBOL[currency] ? `${SYMBOL[currency]}${value}` : `${value} ${currency}`
}

/** A token amount: "5.72 PYUSD". */
export function formatAmount(baseUnits: string, decimals: number, token: string): string {
  const value = Number(fromBaseUnits(BigInt(baseUnits), decimals))
  return `${value.toFixed(2)} ${token}`
}

export function currencySymbol(currency: string): string {
  return SYMBOL[currency] ?? currency
}

/** "Wed 21 Oct" from a YYYY-MM-DD shop date (read as a calendar day, not shifted by timezone). */
export function formatDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  if (!y || !m || !d) return isoDate
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

/** An address in groups of four, so it's easy to check against the wallet prompt. */
export function groupedAddress(address: string): string {
  return address.match(/.{1,4}/g)?.join(' ') ?? address
}

export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address
}
