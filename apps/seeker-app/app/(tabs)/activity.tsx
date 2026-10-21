import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { FlatList, Pressable, RefreshControl, Text, TextInput, View } from 'react-native'
import { RefundCard } from '@/components/refund-card'
import { SetupCard } from '@/components/setup-card'
import { SweepCard } from '@/components/sweep-card'
import { Button } from '@/components/ui'
import { colors, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api, Payment, Refund, Sweep } from '@/lib/api'
import { currencySymbol, formatMoney, shortAddress } from '@/lib/format'

const STATUS_COLOUR: Record<Payment['status'], string> = {
  paid: colors.paid,
  pending: colors.muted,
  failed: colors.danger,
  expired: colors.warn,
}

export default function ActivityScreen() {
  const { merchant, isStaff } = useMerchant()
  const payments = useQuery({
    queryKey: ['payments', merchant?.id],
    queryFn: () => api.listPayments(),
    enabled: !!merchant,
    refetchInterval: 10_000,
  })
  const summary = useQuery({
    queryKey: ['summary', merchant?.id],
    queryFn: () => api.getSummary(),
    enabled: !!merchant,
    refetchInterval: 30_000,
  })
  const [sweepAmount, setSweepAmount] = useState<string | null>(null)
  const [sweep, setSweep] = useState<Sweep | null>(null)
  const [refund, setRefund] = useState<Refund | null>(null)
  const [error, setError] = useState<string | null>(null)
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

  if (!merchant) {
    return (
      <View style={[ui.screen, ui.content]}>
        <SetupCard />
      </View>
    )
  }

  async function startSweep() {
    setError(null)
    if (!merchant!.ownerWallet) return setError('Add an owner wallet in Settings first.')
    try {
      setSweepAmount((await api.till()).display)
    } catch (e) {
      setError(message(e))
    }
  }

  async function proposeSweep() {
    if (!sweepAmount) return
    setError(null)
    try {
      setSweep(await api.proposeSweep(sweepAmount, 'Sent from the Activity tab'))
      setSweepAmount(null)
    } catch (e) {
      setError(message(e))
    }
  }

  async function startRefund(payment: Payment) {
    setError(null)
    try {
      setRefund(await api.proposeRefund(payment.id, undefined, payment.label ? `Refund for ${payment.label}` : 'Refund'))
    } catch (e) {
      setError(message(e))
    }
  }

  const refresh = () => {
    payments.refetch()
    summary.refetch()
  }

  const s = summary.data?.summary
  return (
    <FlatList
      style={ui.screen}
      contentContainerStyle={ui.content}
      data={payments.data ?? []}
      keyExtractor={(p) => p.id}
      refreshControl={<RefreshControl refreshing={payments.isFetching} onRefresh={refresh} />}
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          <View style={ui.card}>
            <Text style={ui.muted}>Today</Text>
            <Text style={ui.h1}>{s ? `${currencySymbol(s.token)}${Number(s.takings).toFixed(2)}` : '—'}</Text>
            {s && (
              <Text style={ui.muted}>
                {s.paidCount} sales · {s.uniqueCustomers} customers · {s.pointsIssued} points issued
              </Text>
            )}
            {s && s.refunds.count > 0 && (
              <Text style={ui.muted}>
                {s.refunds.count} refund{s.refunds.count === 1 ? '' : 's'} · net {currencySymbol(s.token)}
                {Number(s.netTakings).toFixed(2)}
              </Text>
            )}
            {s && Number(s.byRail.paypal) > 0 && (
              <Text style={ui.muted}>
                Wallet {Number(s.byRail.solana).toFixed(2)} · PayPal {Number(s.byRail.paypal).toFixed(2)}
              </Text>
            )}
            {!isStaff && sweepAmount === null && !sweep && <Button title="Send takings to owner" variant="secondary" onPress={startSweep} />}
            {sweepAmount !== null && (
              <View style={{ gap: 8 }}>
                <Text style={ui.body}>Amount to move from the till ({merchant.token})</Text>
                <TextInput style={ui.input} keyboardType="decimal-pad" value={sweepAmount} onChangeText={setSweepAmount} />
                <View style={ui.row}>
                  <Button title="Cancel" variant="secondary" onPress={() => setSweepAmount(null)} style={{ flex: 1 }} />
                  <Button title="Review" onPress={proposeSweep} disabled={!(Number(sweepAmount) > 0)} style={{ flex: 2 }} />
                </View>
              </View>
            )}
          </View>
          {sweep && <SweepCard sweep={sweep} onChange={(next) => (setSweep(next), refresh())} />}
          {refund && <RefundCard refund={refund} onChange={(next) => (setRefund(next), refresh())} />}
          {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
        </View>
      }
      ListEmptyComponent={<Text style={ui.muted}>No sales yet. Take one from the Charge tab.</Text>}
      renderItem={({ item }) => (
        <View style={[ui.card, ui.row, { justifyContent: 'space-between' }]}>
          <View style={{ gap: 2, flexShrink: 1 }}>
            <Text style={ui.h2}>{formatMoney(item.amount, item.decimals, item.currency)}</Text>
            <Text style={ui.muted}>
              {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {item.rail === 'paypal' ? ' · PayPal' : item.payer ? ` · ${shortAddress(item.payer)}` : ''}
              {item.points && item.points !== '0' ? ` · ${item.points} pts` : ''}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text style={{ color: STATUS_COLOUR[item.status], fontWeight: '600', textTransform: 'capitalize' }}>{item.status}</Text>
            {!isStaff && item.rail === 'paypal' && item.status === 'paid' && (
              <Pressable accessibilityRole="button" onPress={() => startRefund(item)}>
                <Text style={{ color: colors.sea, fontWeight: '600' }}>Refund</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    />
  )
}
