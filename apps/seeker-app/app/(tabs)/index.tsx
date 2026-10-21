import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import * as Haptics from 'expo-haptics'
import { SetupCard } from '@/components/setup-card'
import { Button } from '@/components/ui'
import { colors, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api, Payment } from '@/lib/api'
import { formatAmount } from '@/lib/format'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']

export default function ChargeScreen() {
  const { merchant, loading } = useMerchant()
  const [amount, setAmount] = useState('')
  const [payment, setPayment] = useState<(Payment & { url: string }) | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => clearInterval(poll.current ?? undefined), [])

  if (loading) return <ActivityIndicator style={{ marginTop: 48 }} color={colors.sea} />
  if (!merchant) {
    return (
      <ScrollView style={ui.screen} contentContainerStyle={ui.content}>
        <SetupCard />
      </ScrollView>
    )
  }

  function press(key: string) {
    setError(null)
    setAmount((current) => {
      if (key === '⌫') return current.slice(0, -1)
      if (key === '.' && current.includes('.')) return current
      if (current.includes('.') && current.split('.')[1]!.length >= 2) return current
      if (current === '0' && key !== '.') return key
      return (current + key).slice(0, 9)
    })
  }

  async function charge() {
    if (!merchant) return
    setCreating(true)
    setError(null)
    try {
      const created = await api.createPayment(merchant.id, amount)
      setPayment(created)
      poll.current = setInterval(async () => {
        const latest = await api.getPayment(created.id).catch(() => null)
        if (!latest || latest.status === 'pending') return
        clearInterval(poll.current ?? undefined)
        setPayment({ ...latest, url: created.url })
        if (latest.status === 'paid') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      }, 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  function reset() {
    clearInterval(poll.current ?? undefined)
    setPayment(null)
    setAmount('')
  }

  if (payment) {
    const display = formatAmount(payment.amount, payment.decimals, payment.token)
    return (
      <ScrollView style={ui.screen} contentContainerStyle={[ui.content, { alignItems: 'center' }]}>
        <Text style={[ui.h1, { fontSize: 40 }]}>{display}</Text>
        {payment.status === 'pending' && (
          <>
            <View style={[ui.card, { padding: 20 }]}>
              <QRCode value={payment.url} size={260} />
            </View>
            <View style={ui.row}>
              <ActivityIndicator color={colors.sea} />
              <Text style={ui.muted}>Waiting for payment. Scan with any Solana wallet.</Text>
            </View>
          </>
        )}
        {payment.status === 'paid' && (
          <View style={[ui.card, { alignItems: 'center', alignSelf: 'stretch', paddingVertical: 32 }]}>
            <Text style={{ fontSize: 56, color: colors.paid }}>✓</Text>
            <Text style={[ui.h1, { color: colors.paid }]}>Paid</Text>
            {payment.points && payment.points !== '0' && (
              <Text style={ui.body}>
                {payment.points} points {payment.pointsIssued ? 'sent to' : 'going to'} the customer
              </Text>
            )}
          </View>
        )}
        {(payment.status === 'failed' || payment.status === 'expired') && (
          <View style={[ui.card, { alignSelf: 'stretch' }]}>
            <Text style={[ui.h2, { color: colors.danger }]}>
              {payment.status === 'expired' ? 'Request expired' : 'Payment problem'}
            </Text>
            {payment.failureReason && <Text style={ui.muted}>{payment.failureReason}</Text>}
          </View>
        )}
        <Button
          title={payment.status === 'pending' ? 'Cancel' : 'New sale'}
          variant={payment.status === 'pending' ? 'secondary' : 'primary'}
          onPress={reset}
          style={{ alignSelf: 'stretch' }}
        />
      </ScrollView>
    )
  }

  const valid = Number(amount) > 0
  return (
    <View style={[ui.screen, ui.content]}>
      <Text style={ui.muted}>{merchant.name}</Text>
      <Text style={[ui.h1, { fontSize: 52, textAlign: 'center', marginVertical: 16 }]}>
        {amount || '0'} <Text style={{ fontSize: 22, color: colors.muted }}>{merchant.token}</Text>
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
        {KEYS.map((key) => (
          <Pressable
            key={key}
            onPress={() => press(key)}
            accessibilityLabel={key === '⌫' ? 'Delete' : key}
            style={({ pressed }) => [
              ui.card,
              { width: '31%', alignItems: 'center', paddingVertical: 18, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Text style={{ fontSize: 26, color: colors.ink }}>{key}</Text>
          </Pressable>
        ))}
      </View>
      {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
      <Button title={valid ? `Charge ${amount} ${merchant.token}` : 'Enter an amount'} onPress={charge} disabled={!valid} loading={creating} />
    </View>
  )
}
