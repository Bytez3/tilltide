import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import * as Haptics from 'expo-haptics'
import { GettingStarted } from '@/components/getting-started'
import { ItemIcon } from '@/components/item-icon'
import { PaidTick } from '@/components/paid-tick'
import { Unreachable } from '@/components/unreachable'
import { Welcome } from '@/components/welcome'
import { Button, Chip, Input, Segmented } from '@/components/ui'
import { colors, fonts, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api, ApiError, Payment, Rail } from '@/lib/api'
import { currencySymbol, formatAmount, formatMoney } from '@/lib/format'
import { AppConfig } from '@/constants/app-config'

/** Secondary text on the Harbour band. */
const BAND_TEXT = { color: colors.bandMuted }
const BAND = {
  backgroundColor: colors.band,
  paddingHorizontal: 16,
  borderBottomLeftRadius: 28,
  borderBottomRightRadius: 28,
}

const RAIL_LABEL: Record<Rail, string> = { paypal: 'PayPal', solana: 'Wallet', cash: 'Cash', card: 'Card' }

/** Pence from a typed or stored price. Accepts a comma as the decimal point ("20,50"). */
function toPence(value: string): number {
  const n = Number(value.trim().replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']

export default function ChargeScreen() {
  const { merchant, loading, isStaff, unreachable } = useMerchant()
  const [amount, setAmount] = useState('')
  // PayPal first: most customers have PayPal or a card; wallets are the second option.
  const [rail, setRail] = useState<Rail>('paypal')
  const [loyaltyCode, setLoyaltyCode] = useState('')
  const [showLoyalty, setShowLoyalty] = useState(false)
  const [usePoints, setUsePoints] = useState(false)
  const [payment, setPayment] = useState<(Payment & { url: string }) | null>(null)
  const [creating, setCreating] = useState(false)
  // Set synchronously, so two taps in the same frame can't create two sales.
  const charging = useRef(false)
  const queryClient = useQueryClient()
  // Activity and Getting Started read these; refresh them when a sale is made or settles.
  const refreshLists = () => {
    queryClient.invalidateQueries({ queryKey: ['payments'] })
    queryClient.invalidateQueries({ queryKey: ['summary'] })
  }
  const [error, setError] = useState<string | null>(null)
  // The basket: item id → quantity. Prices come from the server's menu; the server re-prices at charge time.
  const [basket, setBasket] = useState<Record<string, number>>({})
  const [mode, setMode] = useState<'menu' | 'keypad' | null>(null)
  const [cashGiven, setCashGiven] = useState('')
  const [showGiven, setShowGiven] = useState(false)
  const givenPence = toPence(cashGiven)
  const items = useQuery({
    queryKey: ['items', merchant?.id],
    queryFn: () => api.listItems(),
    enabled: !!merchant,
    // Staff tills pick up the owner's menu changes within a minute, and at once when the app is reopened.
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  // The sale the screen is showing. Poll responses for any other sale are ignored.
  const current = useRef<string | null>(null)

  useEffect(
    () => () => {
      current.current = null
    },
    [],
  )

  if (loading) return <ActivityIndicator style={{ marginTop: 48 }} color={colors.sea} />
  if (!merchant) return unreachable ? <Unreachable /> : <Welcome />

  function press(key: string) {
    setError(null)
    setAmount((current) => {
      if (key === '⌫') return current.slice(0, -1)
      if (key === '.' && current.includes('.')) return current
      if (key === '.' && current === '') return '0.'
      if (current.includes('.') && current.split('.')[1]!.length >= 2) return current
      if (current === '0' && key !== '.') return key
      // Up to 9,999,999.99: the server refuses anything over a million anyway.
      if (key !== '.' && !current.includes('.') && current.length >= 7) return current
      return current + key
    })
  }

  /** Polls one sale until it settles. Waits for each response before asking again, so requests never pile up. */
  async function watch(created: Payment & { url: string }) {
    let paidAt: number | null = null
    while (current.current === created.id) {
      await new Promise((r) => setTimeout(r, 2000))
      if (current.current !== created.id) return
      const latest = await api.getPayment(created.id).catch(() => null)
      if (current.current !== created.id) return
      if (!latest) continue
      setPayment({ ...latest, url: created.url })
      if (latest.status === 'paid') {
        // Buzz once, when it first turns paid; polling carries on briefly for the points line.
        if (paidAt === null) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
          refreshLists()
        }
        paidAt ??= Date.now()
        if (latest.pointsIssued || latest.rail === 'paypal' || latest.points === '0' || Date.now() - paidAt > 30_000)
          return
      } else if (latest.status !== 'pending') {
        return
      }
    }
  }

  async function charge() {
    if (!merchant || charging.current) return
    charging.current = true
    setCreating(true)
    setError(null)
    try {
      // Only what's on screen: an item removed from the menu since it was tapped is dropped, not sent.
      const lines = basketLines.map(({ item, qty }) => ({ id: item.id, qty }))
      const typed = typedPence > 0 ? (typedPence / 100).toFixed(2) : undefined
      const created = await api.createPayment(
        typed,
        activeRail,
        activeRail === 'solana' && usePoints,
        activeRail === 'paypal' && loyaltyCode.trim() ? loyaltyCode.trim() : undefined,
        lines,
      )
      current.current = created.id
      setPayment({ ...created, url: created.url ?? '' })
      refreshLists()
      if (created.status === 'paid') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      else watch({ ...created, url: created.url ?? '' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // The server refused an item (changed or removed elsewhere): fetch the current menu.
      if (e instanceof ApiError && e.status === 400) items.refetch()
    } finally {
      charging.current = false
      setCreating(false)
    }
  }

  async function simulate(action: () => Promise<unknown>) {
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** Cancel closes the request on the server too, so the customer can't still pay the QR. */
  async function cancel() {
    if (!payment) return reset()
    try {
      const latest = await api.cancelPayment(payment.id)
      // It was paid a moment ago: show that instead of clearing it.
      if (latest.status === 'paid') return setPayment({ ...latest, url: payment.url })
    } catch {
      // Offline: clear the screen anyway; the request still expires by itself.
    }
    reset()
  }

  function reset() {
    current.current = null
    setPayment(null)
    setAmount('')
    setBasket({})
    setCashGiven('')
    setShowGiven(false)
    setLoyaltyCode('')
    setUsePoints(false)
    setShowLoyalty(false)
  }

  if (payment?.status === 'paid') {
    const display = formatMoney(payment.amount, payment.decimals, payment.currency)
    const receiptUrl = `${AppConfig.apiUrl}/r/${payment.id}`
    return (
      <ScrollView style={ui.screen} contentContainerStyle={{ paddingBottom: 16 }}>
        <View style={[BAND, { alignItems: 'center', paddingTop: 20, paddingBottom: 28, gap: 4 }]}>
          <PaidTick onBand />
          <Text style={[ui.h1, { fontSize: 22, color: colors.bandInk, marginTop: 10 }]}>Paid</Text>
          <Text style={[ui.money, { fontSize: 48, color: colors.bandInk }]}>{display}</Text>
          <Text style={[ui.muted, BAND_TEXT]}>
            {
              {
                paypal: 'with PayPal',
                cash: 'in cash',
                card: 'on the card reader',
                solana: `in ${payment.token} from a wallet`,
              }[payment.rail]
            }
          </Text>
          {payment.items && payment.label && (
            <Text style={[ui.body, { textAlign: 'center', color: colors.bandInk, marginTop: 4 }]}>{payment.label}</Text>
          )}
        </View>
        <View style={[ui.content, { alignItems: 'center' }]}>
          {payment.rail === 'cash' &&
            givenPence > 0 &&
            (() => {
              const change = givenPence - Math.round(Number(payment.amount) / 10 ** (payment.decimals - 2))
              return change >= 0 ? (
                <Text style={ui.h2}>
                  Change: {currencySymbol(payment.currency)}
                  {(change / 100).toFixed(2)}
                </Text>
              ) : null
            })()}
          {payment.pointsRedeemed !== '0' && payment.pointsRedeemed !== undefined && (
            <Text style={ui.body}>
              Used {payment.pointsRedeemed} points ({formatMoney(payment.discount, payment.decimals, payment.currency)}{' '}
              off)
            </Text>
          )}
          {payment.rail === 'solana' && payment.points && payment.points !== '0' && (
            <Text style={ui.body}>
              {payment.pointsIssued
                ? `${payment.points} points sent to the customer${payment.seekerBonus ? ' (Seeker bonus)' : ''}`
                : `${payment.points} points on their way to the customer`}
            </Text>
          )}
          <View style={[ui.card, ui.row, { alignSelf: 'stretch', marginTop: 4, gap: 16 }]}>
            <QRCode value={receiptUrl} size={96} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={ui.h2}>Receipt and points</Text>
              <Text style={ui.muted}>Customer scans this with their phone camera.</Text>
              {AppConfig.sandbox && (
                <Text
                  style={{ color: colors.sea, fontFamily: fonts.semibold }}
                  onPress={() => Linking.openURL(receiptUrl)}
                >
                  Open receipt
                </Text>
              )}
            </View>
          </View>
          <Button title="New sale" onPress={reset} style={{ alignSelf: 'stretch' }} />
        </View>
      </ScrollView>
    )
  }

  if (payment) {
    const display = formatMoney(payment.amount, payment.decimals, payment.currency)
    return (
      <ScrollView style={ui.screen} contentContainerStyle={{ paddingBottom: 16 }}>
        <View style={[BAND, { alignItems: 'center', paddingTop: 12, paddingBottom: 26, gap: 2 }]}>
          <Text style={[ui.muted, BAND_TEXT]}>
            {payment.status === 'pending'
              ? payment.rail === 'paypal'
                ? 'PayPal or card'
                : `${payment.token} from a wallet`
              : 'Sale'}
          </Text>
          <Text style={[ui.money, { fontSize: 48, color: colors.bandInk }]}>{display}</Text>
          {payment.rail === 'solana' &&
            payment.tokenAmount &&
            payment.status === 'pending' &&
            !payment.allowPoints &&
            payment.currency !== 'USD' && (
              <Text style={[ui.muted, BAND_TEXT]}>
                = {formatAmount(payment.tokenAmount, payment.decimals, payment.token)} at today&apos;s rate
              </Text>
            )}
          {payment.label && <Text style={[ui.body, { color: colors.bandInk }]}>{payment.label}</Text>}
        </View>
        <View style={[ui.content, { alignItems: 'center' }]}>
          {payment.status === 'pending' && (
            <>
              <View style={[ui.card, { padding: 20, backgroundColor: '#FFFFFF' }]}>
                <QRCode value={payment.url} size={260} />
              </View>
              {payment.failureReason && (
                <Text style={[ui.body, { color: colors.warn, textAlign: 'center' }]}>
                  {payment.rail === 'paypal'
                    ? payment.failureReason
                    : `Something arrived but it isn't right: ${payment.failureReason}`}
                </Text>
              )}
              {AppConfig.sandbox && (
                <View style={[ui.card, { alignSelf: 'stretch', borderColor: colors.warn }]}>
                  <Text style={ui.muted}>Sandbox: act as the customer</Text>
                  {payment.rail === 'paypal' ? (
                    <Button
                      title="Customer approves in PayPal"
                      variant="secondary"
                      onPress={() => simulate(() => api.sandbox.approvePayPal(payment.url))}
                    />
                  ) : payment.allowPoints ? (
                    <Button
                      title="Customer pays, using their points"
                      variant="secondary"
                      onPress={() => simulate(() => api.sandbox.pay(payment.url))}
                    />
                  ) : (
                    <>
                      <Button
                        title="Customer pays in full"
                        variant="secondary"
                        onPress={() => simulate(() => api.sandbox.pay(payment.url))}
                      />
                      <Button
                        title="Customer underpays by half"
                        variant="secondary"
                        onPress={() =>
                          simulate(() => api.sandbox.pay(payment.url, (Number(payment.amount) / 2e6).toFixed(2)))
                        }
                      />
                    </>
                  )}
                </View>
              )}
              <View style={ui.row}>
                <ActivityIndicator color={colors.sea} />
                <Text style={ui.muted}>
                  {payment.rail === 'paypal'
                    ? 'Waiting for payment. Scan with the phone camera to pay with PayPal or card.'
                    : 'Waiting for payment. Scan with any Solana wallet.'}
                </Text>
              </View>
            </>
          )}
          {(payment.status === 'failed' || payment.status === 'expired') && (
            <View style={[ui.card, { alignSelf: 'stretch' }]}>
              <Text style={[ui.h2, { color: colors.danger }]}>
                {payment.status === 'expired' ? 'Request expired' : 'Payment problem'}
              </Text>
              {payment.failureReason && <Text style={ui.muted}>{payment.failureReason}</Text>}
            </View>
          )}
          {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
          <Button
            title={payment.status === 'pending' ? 'Cancel' : 'New sale'}
            variant={payment.status === 'pending' ? 'secondary' : 'primary'}
            onPress={payment.status === 'pending' ? cancel : reset}
            style={{ alignSelf: 'stretch' }}
          />
        </View>
      </ScrollView>
    )
  }

  const menu = items.data ?? []
  const activeMode = mode ?? (menu.length > 0 ? 'menu' : 'keypad')
  const pence = (price: string) => toPence(price)
  const basketLines = menu.filter((i) => basket[i.id]).map((i) => ({ item: i, qty: basket[i.id]! }))
  const typedPence = Number(amount) > 0 ? pence(amount) : 0
  const totalPence = basketLines.reduce((sum, l) => sum + pence(l.item.price) * l.qty, 0) + typedPence
  const total = (totalPence / 100).toFixed(2)
  const valid = totalPence > 0
  const add = (id: string) => setBasket((b) => ({ ...b, [id]: Math.min((b[id] ?? 0) + 1, 99) }))
  const removeOne = (id: string) =>
    setBasket((b) => {
      const next = { ...b }
      if ((next[id] ?? 0) > 1) next[id]! -= 1
      else delete next[id]
      return next
    })
  // Without PayPal on the server the till falls back to wallet payments.
  const activeRail: Rail = !merchant.paypalEnabled && rail === 'paypal' ? 'solana' : rail
  const recorded = activeRail === 'cash' || activeRail === 'card'
  const railOptions: Rail[] = merchant.paypalEnabled ? ['paypal', 'solana', 'cash', 'card'] : ['solana', 'cash', 'card']
  const currency = merchant.currency
  const paypalNotConnected =
    activeRail === 'paypal' &&
    merchant.paypal.required &&
    merchant.paypal.status !== 'connected' &&
    !merchant.paypal.email
  return (
    <ScrollView style={ui.screen} contentContainerStyle={{ paddingBottom: 16 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      {/* Harbour band: how they're paying, the total, and what's in the sale. */}
      <View style={[BAND, { paddingTop: 4, paddingBottom: 22, gap: 12 }]}>
        <Segmented
          tone="band"
          options={railOptions}
          value={activeRail}
          onChange={setRail}
          label={(r) => RAIL_LABEL[r]}
        />
        <Text
          style={[ui.money, { fontSize: 64, textAlign: 'center', color: valid ? colors.bandInk : colors.bandMuted }]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {currencySymbol(currency)}
          {valid ? total : '0.00'}
        </Text>
        {basketLines.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
            {basketLines.map(({ item, qty }) => (
              <Chip tone="band" key={item.id} label={`${qty}× ${item.name}  −`} onPress={() => removeOne(item.id)} />
            ))}
            {typedPence > 0 && (
              <Chip
                tone="band"
                label={`Other ${currencySymbol(currency)}${(typedPence / 100).toFixed(2)}  ✕`}
                onPress={() => setAmount('')}
              />
            )}
          </View>
        )}
        <View style={{ alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          {activeRail === 'paypal' &&
            (showLoyalty || loyaltyCode ? (
              <Input
                placeholder="Code from their receipt"
                autoFocus={!loyaltyCode}
                autoCapitalize="characters"
                autoCorrect={false}
                value={loyaltyCode}
                onChangeText={setLoyaltyCode}
                onBlur={() => !loyaltyCode && setShowLoyalty(false)}
                maxLength={11}
                style={{ width: 240, textAlign: 'center', letterSpacing: 1, paddingVertical: 8 }}
              />
            ) : (
              <Chip tone="band" selected label="+ Loyalty code" onPress={() => setShowLoyalty(true)} />
            ))}
          {activeRail === 'solana' && (
            <Text style={[ui.muted, BAND_TEXT]}>Paid in {merchant.token} at today&apos;s rate</Text>
          )}
          {activeRail === 'card' && (
            <Text style={[ui.muted, BAND_TEXT]}>Take it on your card reader, then record it here</Text>
          )}
          {activeRail === 'cash' &&
            (showGiven || cashGiven ? (
              <View style={{ alignItems: 'center', gap: 6 }}>
                <Input
                  placeholder={`Cash given, e.g. ${currencySymbol(currency)}20`}
                  autoFocus={!cashGiven}
                  keyboardType="decimal-pad"
                  value={cashGiven}
                  onChangeText={setCashGiven}
                  onBlur={() => !cashGiven && setShowGiven(false)}
                  maxLength={8}
                  style={{ width: 240, textAlign: 'center', paddingVertical: 8 }}
                />
                {givenPence > 0 && valid && (
                  <Text style={[ui.h2, { color: colors.bandInk }]}>
                    {givenPence >= totalPence
                      ? `Change: ${currencySymbol(currency)}${((givenPence - totalPence) / 100).toFixed(2)}`
                      : `${currencySymbol(currency)}${((totalPence - givenPence) / 100).toFixed(2)} short`}
                  </Text>
                )}
              </View>
            ) : (
              <Chip tone="band" selected label="+ Work out change" onPress={() => setShowGiven(true)} />
            ))}
          {activeRail === 'solana' && merchant.pointsMint && (
            <Chip
              tone="band"
              selected={!usePoints}
              label={
                usePoints
                  ? `✓ Customer can use points (up to ${merchant.redeemMaxPercent}% off)`
                  : '+ Let them use points'
              }
              onPress={() => setUsePoints((v) => !v)}
            />
          )}
        </View>
      </View>

      <View style={ui.content}>
        {paypalNotConnected && (
          <Text style={[ui.muted, { color: colors.warn }]}>
            {isStaff
              ? 'PayPal is not set up yet. Ask the owner to connect PayPal, or take a wallet payment.'
              : 'Connect your PayPal in Settings to take PayPal payments.'}
          </Text>
        )}
        <GettingStarted />
        {menu.length > 0 && (
          <Segmented
            options={['menu', 'keypad'] as const}
            value={activeMode}
            onChange={setMode}
            label={(m) => (m === 'menu' ? 'Menu' : 'Keypad')}
          />
        )}
        {activeMode === 'menu' ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {menu.map((item) => {
              const qty = basket[item.id] ?? 0
              return (
                <Pressable
                  key={item.id}
                  onPress={() => add(item.id)}
                  onLongPress={() => qty && removeOne(item.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.name}, ${currencySymbol(currency)}${Number(item.price).toFixed(2)}${qty ? `, ${qty} in the sale` : ''}`}
                  style={({ pressed }) => [
                    ui.card,
                    {
                      width: '48.6%',
                      minHeight: 96,
                      borderRadius: 18,
                      gap: 2,
                      padding: 12,
                      borderColor: qty ? colors.sea : colors.line,
                      borderWidth: qty ? 2 : 1,
                      backgroundColor: pressed ? colors.line : colors.card,
                    },
                  ]}
                >
                  <ItemIcon icon={item.icon} />
                  <Text style={[ui.h2, { fontSize: 15, marginTop: 6 }]} numberOfLines={2}>
                    {item.name}
                  </Text>
                  <Text style={[ui.muted, { fontFamily: fonts.semibold }]}>
                    {currencySymbol(currency)}
                    {Number(item.price).toFixed(2)}
                  </Text>
                  {qty > 0 && (
                    <View
                      style={{
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        minWidth: 26,
                        height: 26,
                        borderRadius: 13,
                        backgroundColor: colors.sea,
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingHorizontal: 6,
                      }}
                    >
                      <Text style={{ color: colors.seaInk, fontFamily: fonts.bold, fontSize: 13 }}>{qty}</Text>
                    </View>
                  )}
                </Pressable>
              )
            })}
          </View>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
            {KEYS.map((key) => (
              <Pressable
                key={key}
                onPress={() => press(key)}
                accessibilityLabel={key === '⌫' ? 'Delete' : key}
                style={({ pressed }) => [
                  ui.card,
                  {
                    width: '31.5%',
                    alignItems: 'center',
                    paddingVertical: 16,
                    borderRadius: 16,
                    backgroundColor: pressed ? colors.line : colors.card,
                  },
                ]}
              >
                <Text style={{ fontSize: 28, fontFamily: fonts.medium, color: colors.ink }}>{key}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
        <Button
          title={
            valid
              ? `${recorded ? `Record ${activeRail === 'cash' ? 'cash' : 'card'} sale` : 'Charge'} ${currencySymbol(currency)}${total}`
              : activeMode === 'menu'
                ? 'Tap items to add them'
                : 'Enter an amount'
          }
          onPress={charge}
          disabled={!valid || paypalNotConnected}
          loading={creating}
        />
      </View>
    </ScrollView>
  )
}
