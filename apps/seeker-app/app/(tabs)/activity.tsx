import { Ionicons } from '@expo/vector-icons'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native'
import { RefundCard } from '@/components/refund-card'
import { SetupCard } from '@/components/setup-card'
import { SweepCard } from '@/components/sweep-card'
import { Button, Input } from '@/components/ui'
import { colors, fonts, Tint, tints, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api, Payment, Refund, Sweep } from '@/lib/api'
import { openLinkAfterRequest } from '@/lib/open-link'
import { currencySymbol, formatDay, formatMoney, shortAddress } from '@/lib/format'

const STATUS_COLOUR: Record<Payment['status'], string> = {
  paid: colors.paid,
  pending: colors.muted,
  failed: colors.danger,
  expired: colors.warn,
  void: colors.muted,
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
  // The pull-to-refresh spinner is for a pull by the owner, not the automatic refresh every few seconds.
  const [pulled, setPulled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reports = useQuery({
    queryKey: ['reports', merchant?.id],
    queryFn: () => api.reports(),
    enabled: !!merchant && !isStaff,
  })
  const [reportBusy, setReportBusy] = useState(false)
  const [confirmVoid, setConfirmVoid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
    if (!sweepAmount || busy) return
    setError(null)
    setBusy(true)
    try {
      setSweep(await api.proposeSweep(sweepAmount, 'Sent from the Activity tab'))
      setSweepAmount(null)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  async function startRefund(payment: Payment) {
    if (busy) return
    // One refund at a time, so a second one can't replace the first's card while it's being approved.
    if (refund && (refund.status === 'proposed' || refund.status === 'processing')) {
      return setError('Finish or cancel the refund that is open first')
    }
    setError(null)
    setBusy(true)
    try {
      setRefund(
        await api.proposeRefund(payment.id, undefined, payment.label ? `Refund for ${payment.label}` : 'Refund'),
      )
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  /** Two taps: the first arms it, the second (within 4s) voids. Avoids losing a sale to a stray tap. */
  async function voidSale(payment: Payment) {
    if (confirmVoid !== payment.id) {
      setConfirmVoid(payment.id)
      setTimeout(() => setConfirmVoid((id) => (id === payment.id ? null : id)), 4000)
      return
    }
    setConfirmVoid(null)
    setError(null)
    try {
      await api.voidSale(payment.id)
      refresh()
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
      // "This month" in the shop's own timezone, not UTC.
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: merchant!.timezone }).format(new Date())
      const { url } = await api.exportLink(`${today.slice(0, 8)}01`, today)
      await openLinkAfterRequest(url)
    } catch (e) {
      setError(message(e))
    }
  }

  const refresh = () => {
    setPulled(true)
    Promise.all([payments.refetch(), summary.refetch()]).finally(() => setPulled(false))
  }

  const s = summary.data?.summary
  return (
    <FlatList
      style={ui.screen}
      contentContainerStyle={ui.content}
      data={payments.data ?? []}
      keyExtractor={(p) => p.id}
      refreshControl={<RefreshControl refreshing={pulled} onRefresh={refresh} />}
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          {/* Anything waiting on the owner comes first. */}
          {sweep && <SweepCard sweep={sweep} onChange={(next) => (setSweep(next), refresh())} />}
          {refund && <RefundCard refund={refund} onChange={(next) => (setRefund(next), refresh())} />}
          {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
          {/* Harbour: today's takings on the teal band. */}
          <View
            style={[ui.card, { backgroundColor: colors.band, borderColor: colors.band, borderRadius: 22, padding: 20 }]}
          >
            <Text style={[ui.label, { color: colors.bandMuted }]}>Today</Text>
            <Text style={[ui.money, { fontSize: 44, color: colors.bandInk }]}>
              {s ? `${currencySymbol(s.token)}${Number(s.takings).toFixed(2)}` : '—'}
            </Text>
            {s && (
              <Text style={[ui.muted, { color: colors.bandMuted }]}>
                {[
                  `${s.paidCount} sale${s.paidCount === 1 ? '' : 's'}`,
                  s.uniqueCustomers > 0 ? `${s.uniqueCustomers} customer${s.uniqueCustomers === 1 ? '' : 's'}` : null,
                  Number(s.pointsIssued) > 0 ? `${s.pointsIssued} points issued` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            )}
            {s && s.refunds.count > 0 && (
              <Text style={[ui.muted, { color: colors.bandMuted }]}>
                {s.refunds.count} refund{s.refunds.count === 1 ? '' : 's'} · net {currencySymbol(s.token)}
                {Number(s.netTakings).toFixed(2)}
              </Text>
            )}
            {s && Number(s.takings) > 0 && (
              <RailSplit
                parts={[
                  { label: 'PayPal', value: Number(s.byRail.paypal), colour: '#FFFFFF' },
                  { label: 'Wallet', value: Number(s.byRail.solana), colour: '#8FD9CF' },
                  { label: 'Cash', value: Number(s.byRail.cash ?? 0), colour: '#F2C46D' },
                  { label: 'Card', value: Number(s.byRail.card ?? 0), colour: '#F29E8E' },
                ]}
                symbol={currencySymbol(s.token)}
                onBand
              />
            )}
            {!isStaff && sweepAmount === null && !sweep && (
              <Button title="Send takings to owner" variant="secondary" onPress={startSweep} />
            )}
            {sweepAmount !== null && (
              <View style={{ gap: 8 }}>
                <Text style={[ui.body, { color: colors.bandInk }]}>
                  Amount to move from the till ({merchant.token})
                </Text>
                <Input keyboardType="decimal-pad" value={sweepAmount} onChangeText={setSweepAmount} />
                <View style={ui.row}>
                  <Button title="Cancel" variant="secondary" onPress={() => setSweepAmount(null)} style={{ flex: 1 }} />
                  <Button
                    title="Review"
                    onPress={proposeSweep}
                    loading={busy}
                    disabled={!(Number(sweepAmount) > 0)}
                    style={{ flex: 2 }}
                  />
                </View>
              </View>
            )}
          </View>
          {!isStaff && (
            <View style={ui.card}>
              <Text style={ui.h2}>End of day</Text>
              <Text style={ui.muted}>
                Written automatically{merchant.closeTime ? ` at ${merchant.closeTime}` : ' at closing time'}
              </Text>
              {reports.data?.[0] ? (
                <>
                  {reports.data[0].date !== summary.data?.summary.date && (
                    <Text style={ui.muted}>{formatDay(reports.data[0].date)}</Text>
                  )}
                  {reports.data[0].narrative && <Text style={ui.body}>{reports.data[0].narrative}</Text>}
                  <Text style={reports.data[0].narrative ? ui.muted : ui.body}>{reports.data[0].text}</Text>
                </>
              ) : (
                <Text style={ui.muted}>No report yet today.</Text>
              )}
              <View style={ui.row}>
                <Button
                  title="Write report"
                  variant="secondary"
                  onPress={writeReport}
                  loading={reportBusy}
                  style={{ flex: 1 }}
                />
                <Button title="Export CSV" variant="secondary" onPress={exportMonth} style={{ flex: 1 }} />
              </View>
            </View>
          )}
          {(payments.data?.length ?? 0) > 0 && <Text style={[ui.h2, { marginTop: 8 }]}>Sales</Text>}
        </View>
      }
      ListFooterComponent={<View style={{ height: 8 }} />}
      ListEmptyComponent={
        <Text style={[ui.muted, payments.error && { color: colors.danger }]}>
          {payments.error
            ? `Couldn't load sales. ${message(payments.error)} Pull down to try again.`
            : 'No sales yet. Take one from the Charge tab.'}
        </Text>
      }
      renderItem={({ item }) => (
        <View style={[ui.card, ui.row, { justifyContent: 'space-between', borderRadius: 18 }]}>
          <View style={[ui.row, { gap: 12, flexShrink: 1, alignItems: 'flex-start' }]}>
            <RailIcon rail={item.rail} />
            <View style={{ gap: 2, flexShrink: 1 }}>
              <Text
                style={[ui.h2, item.status === 'void' && { textDecorationLine: 'line-through', color: colors.muted }]}
              >
                {formatMoney(item.amount, item.decimals, item.currency)}
              </Text>
              {item.label && (
                <Text style={ui.body} numberOfLines={1}>
                  {item.label}
                </Text>
              )}
              <Text style={ui.muted}>
                {new Date(item.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                {item.rail === 'paypal'
                  ? ' · PayPal'
                  : item.rail === 'cash'
                    ? ' · Cash'
                    : item.rail === 'card'
                      ? ' · Card reader'
                      : item.payer
                        ? ` · ${shortAddress(item.payer)}`
                        : ''}
                {item.points && item.points !== '0' ? ` · ${item.points} pts` : ''}
              </Text>
            </View>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text
              style={{ color: STATUS_COLOUR[item.status], fontFamily: fonts.semibold, textTransform: 'capitalize' }}
            >
              {item.status === 'void' ? 'Voided' : item.status}
            </Text>
            {!isStaff && item.rail === 'paypal' && item.status === 'paid' && (
              <Pressable accessibilityRole="button" onPress={() => startRefund(item)}>
                <Text style={{ color: colors.sea, fontFamily: fonts.semibold }}>Refund</Text>
              </Pressable>
            )}
            {!isStaff && (item.rail === 'cash' || item.rail === 'card') && item.status === 'paid' && (
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Cancel this sale if it was recorded by mistake"
                onPress={() => voidSale(item)}
              >
                <Text style={{ color: colors.danger, fontFamily: fonts.semibold }}>
                  {confirmVoid === item.id ? 'Tap to confirm' : 'Void'}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    />
  )
}

/** Today's takings split by how customers paid, as a segmented bar with a legend. Empty methods are left out. */
function RailSplit({
  parts,
  symbol,
  onBand = false,
}: {
  parts: { label: string; value: number; colour: string }[]
  symbol: string
  onBand?: boolean
}) {
  const shown = parts.filter((p) => p.value > 0)
  if (shown.length === 0) return null
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      <View
        style={{
          flexDirection: 'row',
          height: 8,
          borderRadius: 4,
          overflow: 'hidden',
          backgroundColor: onBand ? colors.bandChip : colors.line,
          gap: 2,
        }}
      >
        {shown.map((p) => (
          <View key={p.label} style={{ flex: p.value, backgroundColor: p.colour }} />
        ))}
      </View>
      <View style={[ui.row, { flexWrap: 'wrap', columnGap: 14, rowGap: 4 }]}>
        {shown.map((p) => (
          <Legend key={p.label} colour={p.colour} label={`${p.label} ${symbol}${p.value.toFixed(2)}`} onBand={onBand} />
        ))}
      </View>
    </View>
  )
}

function Legend({ colour, label, onBand = false }: { colour: string; label: string; onBand?: boolean }) {
  return (
    <View style={[ui.row, { gap: 6 }]}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colour }} />
      <Text style={[ui.muted, onBand && { color: colors.bandInk }]}>{label}</Text>
    </View>
  )
}

const RAIL_ICON: Record<Payment['rail'], { icon: keyof typeof Ionicons.glyphMap; tint: Tint }> = {
  paypal: { icon: 'logo-paypal', tint: 'blue' },
  solana: { icon: 'wallet-outline', tint: 'purple' },
  cash: { icon: 'cash-outline', tint: 'green' },
  card: { icon: 'card-outline', tint: 'amber' },
}

/** How a sale was paid, as a small coloured icon at the start of its row. */
function RailIcon({ rail }: { rail: Payment['rail'] }) {
  const { icon, tint } = RAIL_ICON[rail]
  return (
    <View
      style={{
        width: 38,
        height: 38,
        borderRadius: 12,
        backgroundColor: tints[tint].bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name={icon} size={19} color={tints[tint].fg} />
    </View>
  )
}
