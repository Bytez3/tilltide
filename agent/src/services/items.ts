import { fromBaseUnits } from '@tilltide/agent-pay-kit'
import { LEDGER_DECIMALS, sql, type ItemRow, type SaleItem } from '../db'

export class ItemError extends Error {}

/** Icons a menu item can have. The app draws each with its own glyph and colour. */
export const ITEM_ICONS = [
  'pastry', 'bread', 'cake', 'cupcake', 'cookie', 'icecream', 'coffee', 'tea', 'soda', 'water', 'beer', 'wine',
  'pizza', 'burger', 'sandwich', 'noodles', 'fish', 'veg', 'fruit', 'flower', 'gift', 'clothing', 'book', 'other',
] as const
export type ItemIcon = (typeof ITEM_ICONS)[number]

export const MAX_ITEMS = 60
export const MAX_LINES = 30
export const MAX_QTY = 99

export function listItems(merchantId: string) {
  return sql<ItemRow[]>`
    select * from items where merchant_id = ${merchantId} and not archived order by position, created_at`
}

export async function createItem(merchantId: string, name: string, price: bigint, icon: ItemIcon = 'other') {
  return sql.begin(async (tx) => {
    // Serialise adds per shop so the cap and the position can't race.
    await tx`select pg_advisory_xact_lock(hashtext(${`items:${merchantId}`}))`
    const [stats] = await tx<{ count: number; next: number }[]>`
      select count(*)::int as count, coalesce(max(position) + 1, 0)::int as next
      from items where merchant_id = ${merchantId} and not archived`
    const { count, next } = stats!
    if (count >= MAX_ITEMS) throw new ItemError(`A shop can have up to ${MAX_ITEMS} items`)
    const [row] = await tx<ItemRow[]>`
      insert into items (merchant_id, name, price, position, icon) values (${merchantId}, ${name}, ${price.toString()}, ${next}, ${icon}) returning *`
    return row!
  })
}

export async function updateItem(merchantId: string, id: string, changes: { name?: string; price?: bigint; position?: number; icon?: ItemIcon }) {
  const [row] = await sql<ItemRow[]>`
    update items set
      name = coalesce(${changes.name ?? null}, name),
      price = coalesce(${changes.price?.toString() ?? null}::bigint, price),
      position = coalesce(${changes.position ?? null}::int, position),
      icon = coalesce(${changes.icon ?? null}, icon)
    where id = ${id} and merchant_id = ${merchantId} and not archived returning *`
  if (!row) throw new ItemError('Item not found')
  return row
}

/** Archived, not deleted: past sales keep their own copy of the name and price anyway. */
export async function archiveItem(merchantId: string, id: string) {
  const rows = await sql`update items set archived = true where id = ${id} and merchant_id = ${merchantId} and not archived`
  if (rows.count === 0) throw new ItemError('Item not found')
}

/**
 * Prices a basket from the shop's own item list, so the till can't be told a different price.
 * `extra` is anything typed on the keypad as well. Returns the total, the snapshot to store, and a label.
 */
export async function priceBasket(merchantId: string, lines: { id: string; qty: number }[], extra: bigint) {
  if (lines.length > MAX_LINES) throw new ItemError(`Up to ${MAX_LINES} different items per sale`)
  const qtyById = new Map<string, number>()
  for (const line of lines) {
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) throw new ItemError(`Quantities must be 1 to ${MAX_QTY}`)
    qtyById.set(line.id, (qtyById.get(line.id) ?? 0) + line.qty)
  }
  const ids = [...qtyById.keys()]
  const rows = ids.length
    ? await sql<ItemRow[]>`select * from items where merchant_id = ${merchantId} and not archived and id in ${sql(ids)}`
    : []
  if (rows.length !== ids.length) throw new ItemError('An item in this sale has been changed or removed. Refresh and try again.')

  const byId = new Map(rows.map((r) => [r.id, r]))
  const items: SaleItem[] = ids.map((id) => {
    const row = byId.get(id)!
    const qty = qtyById.get(id)!
    if (qty > MAX_QTY) throw new ItemError(`Quantities must be 1 to ${MAX_QTY}`)
    return { id, name: row.name, price: row.price.toString(), qty }
  })
  if (extra > 0n) items.push({ id: null, name: 'Other', price: extra.toString(), qty: 1 })
  const amount = items.reduce((sum, i) => sum + BigInt(i.price) * BigInt(i.qty), 0n)
  return { amount, items, label: basketLabel(items) }
}

/** "2× Pasty, Coffee, Other": the sale's description everywhere (receipt, PayPal, CSV), up to 80 characters. */
export function basketLabel(items: SaleItem[]): string {
  const label = items.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)).join(', ')
  return label.length > 80 ? `${label.slice(0, 79)}…` : label
}

/** Units and takings per item across paid sales, best sellers first. Keypad amounts are left out. */
export function itemTotals(payments: { items: SaleItem[] | null }[], decimals = LEDGER_DECIMALS) {
  const totals = new Map<string, { name: string; qty: number; sales: bigint }>()
  for (const p of payments) {
    for (const i of p.items ?? []) {
      if (!i.id) continue
      // Grouped by name, so a renamed item reads as it did on the day.
      const t = totals.get(i.name) ?? { name: i.name, qty: 0, sales: 0n }
      t.qty += i.qty
      t.sales += BigInt(i.price) * BigInt(i.qty)
      totals.set(i.name, t)
    }
  }
  return [...totals.values()]
    .sort((a, b) => b.qty - a.qty || (b.sales > a.sales ? 1 : b.sales < a.sales ? -1 : 0))
    .map((t) => ({ name: t.name, qty: t.qty, sales: fromBaseUnits(t.sales, decimals) }))
}
