import { fromBaseUnits } from '@tilltide/agent-pay-kit'

export function formatAmount(baseUnits: string, decimals: number, token: string): string {
  const value = Number(fromBaseUnits(BigInt(baseUnits), decimals))
  return `${value.toFixed(2)} ${token}`
}

export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address
}
