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

export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address
}
