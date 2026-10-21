import { sql, type MerchantRow } from '../db'
import { config } from '../config'

export async function getMerchant(id: string): Promise<MerchantRow | null> {
  const [row] = await sql<MerchantRow[]>`select * from merchants where id = ${id}`
  return row ?? null
}

export function merchantToken(merchant: MerchantRow) {
  return config.tokens[merchant.tokenSymbol]
}
