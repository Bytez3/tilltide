import { useQuery } from '@tanstack/react-query'
import { FlatList, RefreshControl, Text, View } from 'react-native'
import { SetupCard } from '@/components/setup-card'
import { colors, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api, Payment } from '@/lib/api'
import { formatAmount, shortAddress } from '@/lib/format'

const STATUS_COLOUR: Record<Payment['status'], string> = {
  paid: colors.paid,
  pending: colors.muted,
  failed: colors.danger,
  expired: colors.warn,
}

export default function ActivityScreen() {
  const { merchant } = useMerchant()
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

  if (!merchant) {
    return (
      <View style={[ui.screen, ui.content]}>
        <SetupCard />
      </View>
    )
  }

  const s = summary.data?.summary
  return (
    <FlatList
      style={ui.screen}
      contentContainerStyle={ui.content}
      data={payments.data ?? []}
      keyExtractor={(p) => p.id}
      refreshControl={
        <RefreshControl
          refreshing={payments.isFetching}
          onRefresh={() => {
            payments.refetch()
            summary.refetch()
          }}
        />
      }
      ListHeaderComponent={
        <View style={ui.card}>
          <Text style={ui.muted}>Today</Text>
          <Text style={ui.h1}>{s ? `${Number(s.takings).toFixed(2)} ${s.token}` : '—'}</Text>
          {s && (
            <Text style={ui.muted}>
              {s.paidCount} sales · {s.uniqueCustomers} customers · {s.pointsIssued} points issued
            </Text>
          )}
          {s && s.refunds.count > 0 && (
            <Text style={ui.muted}>
              {s.refunds.count} refund{s.refunds.count === 1 ? '' : 's'} · net {Number(s.netTakings).toFixed(2)} USD
            </Text>
          )}
          {s && Number(s.byRail.paypal) > 0 && (
            <Text style={ui.muted}>
              Wallet {Number(s.byRail.solana).toFixed(2)} · PayPal {Number(s.byRail.paypal).toFixed(2)}
            </Text>
          )}
        </View>
      }
      ListEmptyComponent={<Text style={ui.muted}>No sales yet. Take one from the Charge tab.</Text>}
      renderItem={({ item }) => (
        <View style={[ui.card, ui.row, { justifyContent: 'space-between' }]}>
          <View style={{ gap: 2 }}>
            <Text style={ui.h2}>{formatAmount(item.amount, item.decimals, item.token)}</Text>
            <Text style={ui.muted}>
              {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {item.rail === 'paypal' ? ' · PayPal' : item.payer ? ` · ${shortAddress(item.payer)}` : ''}
              {item.points && item.points !== '0' ? ` · ${item.points} pts` : ''}
            </Text>
          </View>
          <Text style={{ color: STATUS_COLOUR[item.status], fontWeight: '600', textTransform: 'capitalize' }}>
            {item.status}
          </Text>
        </View>
      )}
    />
  )
}
