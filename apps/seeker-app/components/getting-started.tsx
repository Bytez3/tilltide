import AsyncStorage from '@react-native-async-storage/async-storage'
import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { colors, fonts, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api } from '@/lib/api'

const dismissKey = (shopId: string) => `tilltide:getting-started-dismissed:${shopId}`

/**
 * First-run guide for the owner: the few things to set up before the first real customer.
 * Each step is worked out from the shop itself, so it ticks off on its own.
 */
export function GettingStarted() {
  const { merchant, isStaff } = useMerchant()
  const [dismissed, setDismissed] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const payments = useQuery({ queryKey: ['payments', merchant?.id], queryFn: () => api.listPayments(), enabled: !!merchant && !isStaff })
  const items = useQuery({ queryKey: ['items', merchant?.id], queryFn: () => api.listItems(), enabled: !!merchant && !isStaff })
  const staff = useQuery({ queryKey: ['staff', merchant?.id], queryFn: () => api.listStaff(), enabled: !!merchant && !isStaff })

  useEffect(() => {
    if (!merchant) return
    AsyncStorage.getItem(dismissKey(merchant.id))
      .then((v) => setDismissed(v === '1'))
      .catch(() => setDismissed(false))
  }, [merchant])

  if (!merchant || isStaff || dismissed) return null

  const steps = [
    ...(merchant.paypalEnabled
      ? [{ label: 'Connect your PayPal', done: merchant.paypal.status === 'connected' || Boolean(merchant.paypal.email), go: '/settings' as const }]
      : []),
    { label: 'Add the owner wallet (where takings go)', done: Boolean(merchant.ownerWallet), go: '/settings' as const },
    { label: 'Add your menu items (optional)', done: (items.data ?? []).length > 0, go: '/settings' as const },
    { label: 'Take a first sale', done: (payments.data ?? []).some((p) => p.status === 'paid'), go: null },
    { label: 'Pair a staff phone (optional)', done: (staff.data ?? []).length > 0, go: '/settings' as const },
  ]
  const required = steps.filter((s) => !s.label.includes('optional'))
  if (required.every((s) => s.done)) return null
  const next = steps.find((s) => !s.done)!

  const doneCount = steps.filter((s) => s.done).length
  const hide = () => {
    setDismissed(true)
    AsyncStorage.setItem(dismissKey(merchant.id), '1').catch(() => {})
  }

  // Collapsed, it's one line: progress and the next step, so the till keeps the screen.
  if (!expanded) {
    return (
      <View style={[ui.card, { borderColor: colors.sea, borderWidth: 1, paddingVertical: 12, gap: 8 }]}>
        <View style={[ui.row, { justifyContent: 'space-between' }]}>
          <Text style={[ui.label, { color: colors.link }]}>
            Getting started · {doneCount}/{steps.length}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => setExpanded(true)} hitSlop={8}>
            <Text style={[ui.muted, { fontFamily: fonts.semibold }]}>All steps</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {steps.map((s) => (
            <View key={s.label} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: s.done ? colors.sea : colors.line }} />
          ))}
        </View>
        <Pressable accessibilityRole={next.go ? 'link' : undefined} disabled={!next.go} onPress={() => next.go && router.push(next.go)}>
          <Text style={[ui.body, { fontFamily: fonts.semibold }]}>
            Next: {next.label}
            {next.go ? ' ›' : ''}
          </Text>
        </Pressable>
      </View>
    )
  }

  return (
    <View style={[ui.card, { borderColor: colors.sea, borderWidth: 1, gap: 6 }]}>
      <View style={[ui.row, { justifyContent: 'space-between' }]}>
        <Text style={ui.h2}>
          Getting started · {doneCount}/{steps.length}
        </Text>
        <View style={[ui.row, { gap: 16 }]}>
          <Text style={ui.muted} accessibilityRole="button" onPress={() => setExpanded(false)}>
            Less
          </Text>
          <Text style={ui.muted} accessibilityRole="button" onPress={hide}>
            Hide
          </Text>
        </View>
      </View>
      {steps.map((s) => (
        <Pressable
          key={s.label}
          disabled={s.done || !s.go}
          onPress={() => s.go && router.push(s.go)}
          accessibilityRole={s.go && !s.done ? 'link' : undefined}
          style={ui.row}
        >
          <Text style={{ width: 20, color: s.done ? colors.paid : colors.muted, fontFamily: fonts.bold }}>{s.done ? '✓' : '○'}</Text>
          <Text style={[ui.body, s.done && { color: colors.muted, textDecorationLine: 'line-through' }, s === next && { fontFamily: fonts.semibold }]}>
            {s.label}
            {s === next && s.go ? ' ›' : ''}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}
