import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { FlatList, Linking, Pressable, RefreshControl, Text, View } from 'react-native'
import { RefundCard } from '@/components/refund-card'
import { SetupCard } from '@/components/setup-card'
import { SweepCard } from '@/components/sweep-card'
import { Button, Input } from '@/components/ui'
import { colors, fonts, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api, Payment, Refund, Sweep } from '@/lib/api'
import { currencySymbol, formatDay, formatMoney, shortAddress } from '@/lib/format'

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
  const reports = useQuery({
    queryKey: ['reports', merchant?.id],
    queryFn: () => api.reports(),
    enabled: !!merchant && !isStaff,
  })
  const [reportBusy, setReportBusy] = useState(false)

  // Finished approvals clear themselves after a few seconds; anything that needs checking stays.
  useEffect(() => {
    if (sweep?.status !== 'confirmed' && sweep?.status !== 'cancelled') return
    const timer = setTimeout(() => setSweep(null), 6000)
    return () => clearTimeout(timer)
  }, [sweep?.status])
  useEffect(() => {
    if (refund?.status !== 'completed' && refund?.status !== 'cancelled') return
    const timer = setTimeout(() => setRefund(null), 6000)
    return () => clearTimeout(timer)
  }, [refund?.status])
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

  async function writeReport() {
    setReportBusy(true)
    setError(null)
    try {
      await api.writeReport()
      await reports.refetch()
    } catch (e) {
      setError(message(e))
    } finally {
      setReportBusy(false)
    }
  }

  /** This month so far, as CSV, via a one-time link. */
  async function exportMonth() {
    setError(null)
    try {
      const today = new Date().toISOString().slice(0, 10)
      const { url } = await api.exportLink(`${today.slice(0, 8)}01`, today)
      await Linking.openURL(url)
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
          {/* Anything waiting on the owner comes first. */}
          {sweep && <SweepCard sweep={sweep} onChange={(next) => (setSweep(next), refresh())} />}
          {refund && <RefundCard refund={refund} onChange={(next) => (setRefund(next), refresh())} />}
          {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
          <View style={ui.card}>
            <Text style={ui.muted}>Today</Text>
            <Text style={[ui.h1, { fontSize: 40, letterSpacing: -0.5 }]}>{s ? `${currencySymbol(s.token)}${Number(s.takings).toFixed(2)}` : '—'}</Text>
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
            {s && Number(s.takings) > 0 && (
              <RailSplit paypal={Number(s.byRail.paypal)} wallet={Number(s.byRail.solana)} symbol={currencySymbol(s.token)} />
            )}
            {!isStaff && sweepAmount === null && !sweep && <Button title="Send takings to owner" variant="secondary" onPress={startSweep} />}
            {sweepAmount !== null && (
              <View style={{ gap: 8 }}>
                <Text style={ui.body}>Amount to move from the till ({merchant.token})</Text>
                <Input keyboardType="decimal-pad" value={sweepAmount} onChangeText={setSweepAmount} />
                <View style={ui.row}>
                  <Button title="Cancel" variant="secondary" onPress={() => setSweepAmount(null)} style={{ flex: 1 }} />
                  <Button title="Review" onPress={proposeSweep} disabled={!(Number(sweepAmount) > 0)} style={{ flex: 2 }} />
                </View>
              </View>
            )}
          </View>
          {!isStaff && (
            <View style={ui.card}>
              <Text style={ui.h2}>End of day</Text>
              <Text style={ui.muted}>Written automatically{merchant.closeTime ? ` at ${merchant.closeTime}` : ' at closing time'}</Text>
              {reports.data?.[0] ? (
                <>
                  {reports.data[0].date !== summary.data?.summary.date && <Text style={ui.muted}>{formatDay(reports.data[0].date)}</Text>}
                  {reports.data[0].narrative && <Text style={ui.body}>{reports.data[0].narrative}</Text>}
                  <Text style={reports.data[0].narrative ? ui.muted : ui.body}>{reports.data[0].text}</Text>
                </>
              ) : (
                <Text style={ui.muted}>No report yet today.</Text>
              )}
              <View style={ui.row}>
                <Button title="Write report" variant="secondary" onPress={writeReport} loading={reportBusy} style={{ flex: 1 }} />
                <Button title="Export CSV" variant="secondary" onPress={exportMonth} style={{ flex: 1 }} />
              </View>
            </View>
          )}
          {(payments.data?.length ?? 0) > 0 && <Text style={[ui.h2, { marginTop: 8 }]}>Sales</Text>}
        </View>
      }
      ListFooterComponent={<View style={{ height: 8 }} />}
      ListEmptyComponent={<Text style={ui.muted}>No sales yet. Take one from the Charge tab.</Text>}
      renderItem={({ item }) => (
        <View style={[ui.card, ui.row, { justifyContent: 'space-between' }]}>
          <View style={{ gap: 2, flexShrink: 1 }}>
            <Text style={ui.h2}>{formatMoney(item.amount, item.decimals, item.currency)}</Text>
            <Text style={ui.muted}>
              {new Date(item.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              {item.rail === 'paypal' ? ' · PayPal' : item.payer ? ` · ${shortAddress(item.payer)}` : ''}
              {item.points && item.points !== '0' ? ` · ${item.points} pts` : ''}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text style={{ color: STATUS_COLOUR[item.status], fontFamily: fonts.semibold, textTransform: 'capitalize' }}>{item.status}</Text>
            {!isStaff && item.rail === 'paypal' && item.status === 'paid' && (
              <Pressable accessibilityRole="button" onPress={() => startRefund(item)}>
                <Text style={{ color: colors.sea, fontFamily: fonts.semibold }}>Refund</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    />
  )
}

/** Today's takings split by how customers paid, as a two-tone bar with a legend. */
function RailSplit({ paypal, wallet, symbol }: { paypal: number; wallet: number; symbol: string }) {
  const total = paypal + wallet
  if (total <= 0) return null
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      <View style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.line }}>
        <View style={{ flex: paypal, backgroundColor: colors.sea }} />
        <View style={{ flex: wallet, backgroundColor: colors.seaLight }} />
      </View>
      <View style={[ui.row, { justifyContent: 'space-between' }]}>
        <Legend colour={colors.sea} label={`PayPal ${symbol}${paypal.toFixed(2)}`} />
        <Legend colour={colors.seaLight} label={`Wallet ${symbol}${wallet.toFixed(2)}`} />
      </View>
    </View>
  )
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <View style={[ui.row, { gap: 6 }]}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colour }} />
      <Text style={ui.muted}>{label}</Text>
    </View>
  )
}
