import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Button, Input } from '@/components/ui'
import { colors, fonts, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api, Item } from '@/lib/api'
import { currencySymbol } from '@/lib/format'
import { guessIcon, ITEM_ICONS, ItemIcon } from '@/components/item-icon'

const PRICE = /^\d{1,6}(\.\d{1,2})?$/

/** The owner's quick-sale menu: items the till can tap into a basket. */
export function MenuEditor() {
  const { merchant } = useMerchant()
  const queryClient = useQueryClient()
  const items = useQuery({ queryKey: ['items', merchant?.id], queryFn: () => api.listItems(), enabled: !!merchant })
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  // Picked by hand, or null to follow the name ("Latte" → coffee).
  const [icon, setIcon] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const symbol = currencySymbol(merchant?.currency ?? 'GBP')
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['items', merchant?.id] })
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

  async function add() {
    setError(null)
    if (!name.trim()) return setError('Give the item a name')
    if (!PRICE.test(price.trim()) || Number(price) <= 0) return setError(`Price must be like 4.50`)
    setBusy(true)
    try {
      await api.createItem(name.trim(), price.trim(), icon ?? guessIcon(name))
      setName('')
      setPrice('')
      setIcon(null)
      setPicking(false)
      await refresh()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={ui.card}>
      <Text style={ui.h2}>Menu</Text>
      <Text style={ui.muted}>Items the till can tap into a sale. Prices are checked by the server, so a till can&apos;t change them.</Text>
      {(items.data ?? []).map((item) =>
        editing === item.id ? (
          <ItemEditor key={item.id} item={item} symbol={symbol} onDone={() => (setEditing(null), refresh())} />
        ) : (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityHint="Edit this item"
            onPress={() => setEditing(item.id)}
            style={[ui.row, { justifyContent: 'space-between', paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line }]}
          >
            <View style={[ui.row, { gap: 10, flexShrink: 1 }]}>
              <ItemIcon icon={item.icon} size={30} />
              <Text style={[ui.body, { fontFamily: fonts.semibold, flexShrink: 1 }]}>{item.name}</Text>
            </View>
            <View style={[ui.row, { gap: 12 }]}>
              <Text style={ui.body}>
                {symbol}
                {Number(item.price).toFixed(2)}
              </Text>
              <Text style={[ui.muted, { color: colors.sea, fontFamily: fonts.semibold }]}>Edit</Text>
            </View>
          </Pressable>
        ),
      )}
      <View style={[ui.row, { marginTop: 4 }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Choose an icon" onPress={() => setPicking((v) => !v)}>
          <ItemIcon icon={icon ?? guessIcon(name)} size={42} />
        </Pressable>
        <Input placeholder="Item, e.g. Pasty" value={name} onChangeText={setName} maxLength={40} style={{ flex: 2, minWidth: 0 }} />
        <Input placeholder={`${symbol}0.00`} value={price} onChangeText={setPrice} keyboardType="decimal-pad" maxLength={9} style={{ flex: 1, minWidth: 0 }} onSubmitEditing={add} />
      </View>
      {picking && <IconPicker value={icon ?? guessIcon(name)} onPick={(i) => (setIcon(i), setPicking(false))} />}
      <Button title="Add to menu" variant="secondary" onPress={add} loading={busy} />
      {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
    </View>
  )
}

function ItemEditor({ item, symbol, onDone }: { item: Item; symbol: string; onDone: () => void }) {
  const [name, setName] = useState(item.name)
  const [price, setPrice] = useState(Number(item.price).toFixed(2))
  const [icon, setIcon] = useState(item.icon)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function save() {
    if (!name.trim()) return setError('Give the item a name')
    if (!PRICE.test(price.trim()) || Number(price) <= 0) return setError('Price must be like 4.50')
    run(() => api.updateItem(item.id, { name: name.trim(), price: price.trim(), icon }))
  }

  return (
    <View style={{ gap: 8, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line }}>
      <View style={ui.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="Choose an icon" onPress={() => setPicking((v) => !v)}>
          <ItemIcon icon={icon} size={42} />
        </Pressable>
        <Input value={name} onChangeText={setName} maxLength={40} style={{ flex: 2, minWidth: 0 }} accessibilityLabel="Item name" />
        <Input value={price} onChangeText={setPrice} keyboardType="decimal-pad" maxLength={9} style={{ flex: 1, minWidth: 0 }} accessibilityLabel={`Price in ${symbol}`} />
      </View>
      {picking && <IconPicker value={icon} onPick={(i) => (setIcon(i), setPicking(false))} />}
      <View style={ui.row}>
        <Button title="Remove" variant="secondary" onPress={() => run(() => api.deleteItem(item.id))} disabled={busy} style={{ flex: 1 }} />
        <Button title="Cancel" variant="secondary" onPress={onDone} disabled={busy} style={{ flex: 1 }} />
        <Button title="Save" onPress={save} loading={busy} style={{ flex: 1 }} />
      </View>
      {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
    </View>
  )
}

/** A grid of every item icon; the current one is ringed. */
function IconPicker({ value, onPick }: { value: string; onPick: (icon: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 4 }}>
      {Object.entries(ITEM_ICONS).map(([key, meta]) => (
        <Pressable
          key={key}
          accessibilityRole="button"
          accessibilityLabel={meta.label}
          accessibilityState={{ selected: key === value }}
          onPress={() => onPick(key)}
          style={{ borderRadius: 14, padding: 2, borderWidth: 2, borderColor: key === value ? colors.sea : 'transparent' }}
        >
          <ItemIcon icon={key} size={38} />
        </Pressable>
      ))}
    </View>
  )
}
