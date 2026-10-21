/**
 * Token amounts are carried as bigint base units everywhere. Decimal strings
 * only exist at the edges (user input, Solana Pay URLs, display).
 */

export function toBaseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid amount: "${value}"`)
  const [whole = '0', fraction = ''] = trimmed.split('.')
  if (fraction.length > decimals) throw new Error(`Amount "${value}" has more than ${decimals} decimal places`)
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
}

export function fromBaseUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n
  const abs = negative ? -amount : amount
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}
