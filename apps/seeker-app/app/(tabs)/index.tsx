import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import * as Haptics from 'expo-haptics'
import { GettingStarted } from '@/components/getting-started'
import { PaidTick } from '@/components/paid-tick'
import { SetupCard } from '@/components/setup-card'
import { Button, Chip, Input } from '@/components/ui'
import { colors, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api, Payment, Rail } from '@/lib/api'
import { currencySymbol, formatAmount, formatMoney } from '@/lib/format'
import { AppConfig } from '@/constants/app-config'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']

export default function ChargeScreen() {
  const { merchant, loading, isStaff } = useMerchant()
  const [amount, setAmount] = useState('')
  // PayPal first: most customers have PayPal or a card; wallets are the second option.
  const [rail, setRail] = useState<Rail>('paypal')
  const [loyaltyCode, setLoyaltyCode] = useState('')
  const [showLoyalty, setShowLoyalty] = useState(false)
  const [usePoints, setUsePoints] = useState(false)
  const [payment, setPayment] = useState<(Payment & { url: string }) | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The sale the screen is showing. Poll responses for any other sale are ignored.
  const current = useRef<string | null>(null)

  useEffect(() => () => {
    current.current = null
  }, [])

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
      if (key === '.' && current === '') return '0.'
      if (current.includes('.') && current.split('.')[1]!.length >= 2) return current
      if (current === '0' && key !== '.') return key
      return (current + key).slice(0, 9)
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
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        // Keep polling briefly (up to 30s) so the points line updates once they're minted.
        paidAt ??= Date.now()
        if (latest.pointsIssued || latest.rail === 'paypal' || latest.points === '0' || Date.now() - paidAt > 30_000) return
      } else if (latest.status !== 'pending') {
        return
      }
    }
  }

  async function charge() {
    if (!merchant) return
    setCreating(true)
    setError(null)
    try {
      const created = await api.createPayment(
        amount.replace(/\.$/, ''),
        activeRail,
        activeRail === 'solana' && usePoints,
        activeRail === 'paypal' && loyaltyCode.trim() ? loyaltyCode.trim() : undefined,
      )
      current.current = created.id
      setPayment(created)
      watch(created)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
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

  function reset() {
    current.current = null
    setPayment(null)
    setAmount('')
    setLoyaltyCode('')
    setShowLoyalty(false)
  }

  if (payment?.status === 'paid') {
    const display = formatMoney(payment.amount, payment.decimals, payment.currency)
    const receiptUrl = `${AppConfig.apiUrl}/r/${payment.id}`
    return (
      <ScrollView style={[ui.screen, { backgroundColor: colors.paidBg }]} contentContainerStyle={[ui.content, { alignItems: 'center', paddingTop: 32 }]}>
        <PaidTick />
        <Text style={[ui.h1, { fontSize: 44, color: colors.paid, marginTop: 8 }]}>Paid</Text>
        <Text style={[ui.h1, { fontSize: 32 }]}>{display}</Text>
        <Text style={ui.muted}>{payment.rail === 'paypal' ? 'with PayPal' : `in ${payment.token} from a wallet`}</Text>
        {payment.pointsRedeemed !== '0' && payment.pointsRedeemed !== undefined && (
          <Text style={ui.body}>
            Used {payment.pointsRedeemed} points ({formatMoney(payment.discount, payment.decimals, payment.currency)} off)
          </Text>
        )}
        {payment.rail === 'solana' && payment.points && payment.points !== '0' && (
          <Text style={ui.body}>
            {payment.pointsIssued
              ? `${payment.points} points sent to the customer${payment.seekerBonus ? ' (Seeker bonus)' : ''}`
              : `${payment.points} points on their way to the customer`}
          </Text>
        )}
        <View style={[ui.card, ui.row, { alignSelf: 'stretch', marginTop: 16, gap: 16 }]}>
          <QRCode value={receiptUrl} size={96} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={ui.h2}>Receipt and points</Text>
            <Text style={ui.muted}>Customer scans this with their phone camera.</Text>
            {AppConfig.sandbox && (
              <Text style={{ color: colors.sea, fontWeight: '600' }} onPress={() => Linking.openURL(receiptUrl)}>
                Open receipt
              </Text>
            )}
          </View>
        </View>
        <Button title="New sale" onPress={reset} style={{ alignSelf: 'stretch' }} />
      </ScrollView>
    )
  }

  if (payment) {
    const display = formatMoney(payment.amount, payment.decimals, payment.currency)
    return (
      <ScrollView style={ui.screen} contentContainerStyle={[ui.content, { alignItems: 'center' }]}>
        <Text style={[ui.h1, { fontSize: 40 }]}>{display}</Text>
        {payment.rail === 'solana' && payment.tokenAmount && payment.status === 'pending' && !payment.allowPoints && payment.currency !== 'USD' && (
          <Text style={ui.muted}>= {formatAmount(payment.tokenAmount, payment.decimals, payment.token)} at today&apos;s rate</Text>
        )}
        {payment.status === 'pending' && (
          <>
            <View style={[ui.card, { padding: 20 }]}>
              <QRCode value={payment.url} size={260} />
            </View>
            {payment.failureReason && (
              <Text style={[ui.body, { color: colors.warn, textAlign: 'center' }]}>
                {payment.rail === 'paypal' ? payment.failureReason : `Something arrived but it isn't right: ${payment.failureReason}`}
              </Text>
            )}
            {AppConfig.sandbox && (
              <View style={[ui.card, { alignSelf: 'stretch', borderColor: '#B4561C' }]}>
                <Text style={ui.muted}>Sandbox: act as the customer</Text>
                {payment.rail === 'paypal' ? (
                  <Button title="Customer approves in PayPal" variant="secondary" onPress={() => simulate(() => api.sandbox.approvePayPal(payment.url))} />
                ) : payment.allowPoints ? (
                  <Button title="Customer pays, using their points" variant="secondary" onPress={() => simulate(() => api.sandbox.pay(payment.url))} />
                ) : (
                  <>
                    <Button title="Customer pays in full" variant="secondary" onPress={() => simulate(() => api.sandbox.pay(payment.url))} />
                    <Button title="Customer underpays by half" variant="secondary" onPress={() => simulate(() => api.sandbox.pay(payment.url, (Number(payment.amount) / 2e6).toFixed(2)))} />
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
          onPress={reset}
          style={{ alignSelf: 'stretch' }}
        />
      </ScrollView>
    )
  }

  const valid = Number(amount) > 0
  // Without PayPal on the server the till falls back to wallet payments.
  const activeRail: Rail = merchant.paypalEnabled ? rail : 'solana'
  const currency = merchant.currency
  const paypalNotConnected = activeRail === 'paypal' && merchant.paypal.required && merchant.paypal.status !== 'connected' && !merchant.paypal.email
  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      <GettingStarted />
      <View style={[ui.row, { justifyContent: 'space-between' }]}>
        <Text style={ui.muted}>{merchant.name}</Text>
        {merchant.paypalEnabled && (
          <View style={[ui.row, { gap: 0, borderRadius: 10, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }]}>
            {(['paypal', 'solana'] as const).map((r) => (
              <Pressable
                key={r}
                onPress={() => setRail(r)}
                accessibilityRole="button"
                accessibilityState={{ selected: activeRail === r }}
                style={{ paddingHorizontal: 14, paddingVertical: 8, backgroundColor: activeRail === r ? colors.sea : colors.card }}
              >
                <Text style={{ color: activeRail === r ? colors.seaInk : colors.ink, fontWeight: '600' }}>
                  {r === 'solana' ? 'Wallet' : 'PayPal'}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
      {paypalNotConnected && (
        <Text style={[ui.muted, { color: colors.warn }]}>
          {isStaff ? 'PayPal is not set up yet. Ask the owner to connect PayPal, or take a wallet payment.' : 'Connect your PayPal in Settings to take PayPal payments.'}
        </Text>
      )}
      <Text
        style={[ui.h1, { fontSize: 60, textAlign: 'center', marginTop: 12, letterSpacing: -1 }, !amount && { color: colors.placeholder }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {currencySymbol(currency)}
        {amount || '0.00'}
      </Text>
      <View style={{ alignItems: 'center', minHeight: 40, justifyContent: 'center', gap: 6 }}>
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
            <Chip label="+ Loyalty code" onPress={() => setShowLoyalty(true)} />
          ))}
        {activeRail === 'solana' && <Text style={ui.muted}>Paid in {merchant.token} at today&apos;s rate</Text>}
        {activeRail === 'solana' && merchant.pointsMint && (
          <Chip
            label={usePoints ? `✓ Customer can use points (up to ${merchant.redeemMaxPercent}% off)` : '+ Let them use points'}
            selected={usePoints}
            onPress={() => setUsePoints((v) => !v)}
          />
        )}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
        {KEYS.map((key) => (
          <Pressable
            key={key}
            onPress={() => press(key)}
            accessibilityLabel={key === '⌫' ? 'Delete' : key}
            style={({ pressed }) => [
              ui.card,
              { width: '31.5%', alignItems: 'center', paddingVertical: 16, borderRadius: 16, backgroundColor: pressed ? colors.line : colors.card },
            ]}
          >
            <Text style={{ fontSize: 28, fontWeight: '500', color: colors.ink }}>{key}</Text>
          </Pressable>
        ))}
      </View>
      {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
      <Button title={valid ? `Charge ${currencySymbol(currency)}${amount}` : 'Enter an amount'} onPress={charge} disabled={!valid || paypalNotConnected} loading={creating} />
    </ScrollView>
  )
}
