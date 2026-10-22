import { Ionicons } from '@expo/vector-icons'
import { isAddress } from '@solana/kit'
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Keyboard, Platform, ScrollView, Text, View } from 'react-native'
import { MenuEditor } from '@/components/menu-editor'
import { Button, Input, Segmented } from '@/components/ui'
import { colors, fonts, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api, Merchant } from '@/lib/api'
import { openLinkAfterRequest } from '@/lib/open-link'
import { AppConfig } from '@/constants/app-config'
import { currencySymbol, shortAddress } from '@/lib/format'

type IconName = keyof typeof Ionicons.glyphMap

export default function SettingsScreen() {
  const { merchant, update, setOwnerWallet, signOut, replace, isStaff } = useMerchant()
  const [staffLabel, setStaffLabel] = useState('')
  const [staffCode, setStaffCode] = useState<string | null>(null)
  const [staffMinutes, setStaffMinutes] = useState(15)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const [staffList, setStaffList] = useState<{ id: string; label: string; since: string }[]>([])
  const [staffMessage, setStaffMessage] = useState<string | null>(null)
  const [paypalEmail, setPaypalEmail] = useState('')
  const [paypalBusy, setPaypalBusy] = useState(false)
  const [paypalMessage, setPaypalMessage] = useState<string | null>(null)
  const [rate, setRate] = useState('')
  const [owner, setOwner] = useState('')
  const [token, setToken] = useState<'USDC' | 'PYUSD'>('USDC')
  const [currency, setCurrency] = useState<'GBP' | 'USD' | 'EUR'>('GBP')
  const [closeTime, setCloseTime] = useState('17:30')
  const [seekerBonus, setSeekerBonus] = useState(1)
  const [pointValue, setPointValue] = useState('')
  const [maxPercent, setMaxPercent] = useState('')
  const [saving, setSaving] = useState(false)
  // iPhone: lift the "Save changes" bar above the keyboard (Android resizes the screen by itself).
  const [keyboard, setKeyboard] = useState(0)
  const tabBar = useBottomTabBarHeight()
  useEffect(() => {
    if (Platform.OS !== 'ios') return
    const show = Keyboard.addListener('keyboardWillShow', (e) => setKeyboard(e.endCoordinates.height))
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboard(0))
    return () => (show.remove(), hide.remove())
  }, [])
  const [message, setMessage] = useState<string | null>(null)
  const [lookup, setLookup] = useState('')
  const [points, setPoints] = useState<string | null>(null)

  /** Fill the form from the shop as the server has it. */
  function seed(m: Merchant) {
    setRate(String(m.pointsPerUnit))
    setOwner(m.ownerWallet ?? '')
    setToken(m.token)
    setCurrency(m.currency)
    setCloseTime(m.closeTime)
    setSeekerBonus(m.seekerBonus)
    setPointValue(m.pointValue)
    setPaypalEmail(m.paypal.email ?? '')
    setMaxPercent(String(m.redeemMaxPercent))
  }

  // Seed when a different shop loads, and after each save (below). Not on every `merchant` change:
  // saving the PayPal email or re-checking PayPal also replaces it, and must not wipe unsaved edits.
  useEffect(() => {
    if (merchant) seed(merchant)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchant?.id])

  // "Saved" is a confirmation, not a state: let it go after a moment. Errors stay until the next save.
  useEffect(() => {
    if (message !== 'Saved') return
    const timer = setTimeout(() => setMessage(null), 2500)
    return () => clearTimeout(timer)
  }, [message])

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const pointsPerUnit = Number(rate)
      if (!rate.trim() || !Number.isFinite(pointsPerUnit) || pointsPerUnit < 0 || pointsPerUnit > 100) {
        throw new Error('Points rate must be a number from 0 to 100')
      }
      const percent = Number(maxPercent)
      if (!/^\d+(\.\d{1,6})?$/.test(pointValue.trim())) throw new Error('Point value must be a number like 0.01')
      if (!Number.isInteger(percent) || percent < 0 || percent > 90)
        throw new Error('Points can cover 0 to 90% of a bill')
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(closeTime.trim())) throw new Error('Closing time must look like 17:30')
      const ownerWallet = owner.trim()
      if (ownerWallet && !isAddress(ownerWallet)) throw new Error('Owner wallet is not a Solana address')
      // A new owner wallet (where takings go) is approved by the till wallet, so it opens the wallet first.
      if (ownerWallet && ownerWallet !== merchant!.ownerWallet) await setOwnerWallet(ownerWallet)
      const saved = await update({
        pointsPerUnit,
        ...(ownerWallet ? {} : { ownerWallet: null }),
        token,
        currency,
        pointValue: pointValue.trim(),
        redeemMaxPercent: percent,
        closeTime: closeTime.trim(),
        seekerBonus,
      })
      // The server tidies values (0.10 is stored as 0.1); show what it saved, so nothing looks unsaved.
      seed(saved)
      setMessage('Saved')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function connectPayPal() {
    setPaypalBusy(true)
    setPaypalMessage(null)
    try {
      const { url } = await api.connectPayPal()
      if (AppConfig.sandbox) {
        // Sandbox: there's no real paypal.com; finish onboarding as if the owner did.
        await api.sandbox.finishPayPalOnboarding(url)
        replace(await api.refreshPayPal())
      } else {
        await openLinkAfterRequest(url)
        // The server now marks the shop as connecting, which shows the "Check PayPal" button.
        replace(await api.refreshPayPal())
        setPaypalMessage('Finish connecting on PayPal, then come back and tap "Check PayPal".')
      }
    } catch (e) {
      setPaypalMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setPaypalBusy(false)
    }
  }

  async function checkPayPal() {
    setPaypalBusy(true)
    try {
      const updated = await api.refreshPayPal()
      replace(updated)
      setPaypalMessage(updated.paypal.status === 'connected' ? null : 'Not connected yet.')
    } catch (e) {
      setPaypalMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setPaypalBusy(false)
    }
  }

  async function savePaypalEmail() {
    setPaypalMessage(null)
    try {
      const email = paypalEmail.trim()
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That is not an email address')
      await update({ paypalEmail: email || null })
      setPaypalMessage('Saved')
    } catch (e) {
      setPaypalMessage(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (merchant && !isStaff)
      api
        .listStaff()
        .then(setStaffList)
        .catch(() => {})
  }, [merchant, isStaff])

  async function addStaff() {
    setStaffMessage(null)
    try {
      const invite = await api.createStaffInvite(staffLabel.trim() || 'Staff till')
      setStaffCode(invite.code)
      setStaffMinutes(invite.expiresInMinutes)
      setStaffLabel('')
      queryClient.invalidateQueries({ queryKey: ['staff'] })
      // Hide the code once it has expired, so nobody types a dead one.
      setTimeout(() => setStaffCode((c) => (c === invite.code ? null : c)), invite.expiresInMinutes * 60_000)
    } catch (e) {
      setStaffMessage(e instanceof Error ? e.message : String(e))
    }
  }

  async function removeStaff(id: string) {
    // Two taps, so a stray tap doesn't sign a staff phone out mid-shift.
    if (confirmRemove !== id) {
      setConfirmRemove(id)
      setTimeout(() => setConfirmRemove((c) => (c === id ? null : c)), 4000)
      return
    }
    setConfirmRemove(null)
    try {
      await api.removeStaff(id)
      setStaffList(await api.listStaff())
      queryClient.invalidateQueries({ queryKey: ['staff'] })
    } catch (e) {
      setStaffMessage(e instanceof Error ? e.message : String(e))
    }
  }

  async function checkPoints() {
    setPoints(null)
    if (!isAddress(lookup.trim())) return setPoints('Not a Solana address')
    try {
      const result = await api.getPoints(lookup.trim())
      setPoints(result.configured ? `${result.points} points` : 'Points are not set up on the server yet')
    } catch (e) {
      setPoints(e instanceof Error ? e.message : String(e))
    }
  }

  if (!merchant) return null

  if (isStaff) {
    return (
      <ScrollView style={ui.screen} contentContainerStyle={ui.content} automaticallyAdjustKeyboardInsets>
        <ShopCard name={merchant.name} detail={`Staff till${merchant.staffLabel ? `: ${merchant.staffLabel}` : ''}`} />
        <Text style={ui.muted}>This phone takes payments. The owner manages money, refunds and settings.</Text>
        <Button title="Sign out" variant="secondary" onPress={signOut} />
      </ScrollView>
    )
  }

  // Unsaved edits to the shop settings, so "Save changes" only shows when there's something to save.
  const dirty =
    rate !== String(merchant.pointsPerUnit) ||
    owner !== (merchant.ownerWallet ?? '') ||
    token !== merchant.token ||
    currency !== merchant.currency ||
    closeTime !== merchant.closeTime ||
    seekerBonus !== merchant.seekerBonus ||
    pointValue !== merchant.pointValue ||
    maxPercent !== String(merchant.redeemMaxPercent)
  const paypalConnected = merchant.paypal.status === 'connected'
  const sym = currencySymbol(currency)

  return (
    <View style={ui.screen}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[ui.content, { paddingBottom: dirty ? 110 : 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <ShopCard
          name={merchant.name}
          detail={`Till wallet ${shortAddress(merchant.wallet)} · ${merchant.cluster}`}
          pills={[
            merchant.paypalEnabled ? (paypalConnected ? 'PayPal connected' : 'PayPal not connected') : null,
            `Prices in ${merchant.currency}`,
            `Wallet sales in ${merchant.token}`,
          ]}
        />

        <Section icon="card-outline" title="Payments">
          {merchant.paypalEnabled && (
            <View style={{ gap: 6 }}>
              <View style={[ui.row, { justifyContent: 'space-between' }]}>
                <Text style={FIELD_LABEL}>PayPal</Text>
                {paypalConnected && (
                  <Text style={{ color: colors.paid, fontFamily: fonts.bold, fontSize: 14 }}>Connected ✓</Text>
                )}
              </View>
              <Text style={ui.muted}>
                {paypalConnected
                  ? `PayPal and card sales go straight to your PayPal account. Tilltide's fee: ${merchant.paypal.feePercent}%, taken by PayPal.`
                  : `Connect your PayPal so PayPal and card payments go straight to your account.${merchant.paypal.required ? ' PayPal sales are off until you do.' : ''}`}
              </Text>
              {merchant.paypal.onboardingAvailable && !paypalConnected && (
                <View style={ui.row}>
                  <Button title="Connect PayPal" onPress={connectPayPal} loading={paypalBusy} style={{ flex: 2 }} />
                  {merchant.paypal.status === 'pending' && (
                    <Button title="Check PayPal" variant="secondary" onPress={checkPayPal} style={{ flex: 1 }} />
                  )}
                </View>
              )}
              {!merchant.paypal.onboardingAvailable && (
                <>
                  <Input
                    autoCapitalize="none"
                    keyboardType="email-address"
                    placeholder="you@yourshop.co.uk"
                    value={paypalEmail}
                    onChangeText={setPaypalEmail}
                  />
                  <Button title="Save PayPal email" variant="secondary" onPress={savePaypalEmail} />
                </>
              )}
              {paypalMessage && <Text style={ui.muted}>{paypalMessage}</Text>}
            </View>
          )}
          <Field label="Prices in" hint="Choose before your first sale: it can't change once you've taken money.">
            <Segmented options={['GBP', 'EUR', 'USD']} value={currency} onChange={setCurrency} />
          </Field>
          <Field
            label="Wallet payments in"
            hint="The stablecoin wallet customers pay with, priced from your currency at the day's rate."
          >
            <Segmented options={['USDC', 'PYUSD']} value={token} onChange={setToken} />
          </Field>
        </Section>

        <Section
          icon="grid-outline"
          title="Menu"
          description="Items the till can tap into a sale. Prices are checked by the server, so a till can't change them."
        >
          <MenuEditor />
        </Section>

        <Section
          icon="heart-outline"
          title="Loyalty"
          description="Every customer earns points automatically and spends them at the till."
        >
          <View style={[ui.row, { alignItems: 'flex-start' }]}>
            <Field label={`Points per ${sym}1`} style={{ flex: 1 }}>
              <Input keyboardType="decimal-pad" value={rate} onChangeText={setRate} style={{ minWidth: 0 }} />
            </Field>
            <Field label={`1 point is worth`} style={{ flex: 1 }}>
              <Input
                keyboardType="decimal-pad"
                value={pointValue}
                onChangeText={setPointValue}
                style={{ minWidth: 0 }}
              />
            </Field>
          </View>
          <Field label="Points can pay up to" hint="Percent of a bill.">
            <Input keyboardType="number-pad" value={maxPercent} onChangeText={setMaxPercent} />
          </Field>
          <Field label="Seeker owners earn" hint="Extra points for customers paying from a Solana Seeker phone.">
            <Segmented
              options={[1, 1.5, 2, 3]}
              value={seekerBonus}
              onChange={setSeekerBonus}
              label={(m) => (m === 1 ? 'Off' : `×${m}`)}
            />
          </Field>
        </Section>

        <Section icon="wallet-outline" title="Takings and reports">
          <Field
            label="Owner wallet"
            hint="Where wallet takings go when you send them from the till. You approve every transfer."
          >
            <Input
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Solana address"
              value={owner}
              onChangeText={setOwner}
            />
          </Field>
          <Field label="Closing time" hint="Your end-of-day report is written at this time.">
            <Input value={closeTime} onChangeText={setCloseTime} placeholder="17:30" maxLength={5} />
          </Field>
        </Section>

        <Section
          icon="people-outline"
          title="Staff devices"
          description="Staff take payments on their own phone. They can't move money, refund or change settings."
        >
          {staffList.map((d) => (
            <View
              key={d.id}
              style={[
                ui.row,
                { justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
              ]}
            >
              <View style={[ui.row, { gap: 10 }]}>
                <Ionicons name="phone-portrait-outline" size={18} color={colors.muted} />
                <Text style={ui.body}>{d.label}</Text>
              </View>
              <Text
                style={{ color: colors.danger, fontFamily: fonts.semibold }}
                accessibilityRole="button"
                onPress={() => removeStaff(d.id)}
              >
                {confirmRemove === d.id ? 'Tap to confirm' : 'Remove'}
              </Text>
            </View>
          ))}
          <Input
            placeholder="Name, e.g. Saturday till"
            value={staffLabel}
            onChangeText={setStaffLabel}
            maxLength={40}
          />
          <Button title="Add staff device" variant="secondary" onPress={addStaff} />
          {staffCode && (
            <View style={{ backgroundColor: colors.bg, borderRadius: 12, padding: 14, alignItems: 'center', gap: 4 }}>
              <Text style={ui.label}>Pairing code</Text>
              <Text style={[ui.money, { fontSize: 32, color: colors.link, letterSpacing: 2 }]} selectable>
                {staffCode}
              </Text>
              <Text style={[ui.muted, { textAlign: 'center' }]}>
                Enter it on the staff phone. Works once, for {staffMinutes} minutes.
              </Text>
            </View>
          )}
          {staffMessage && <Text style={ui.muted}>{staffMessage}</Text>}
        </Section>

        <Section
          icon="search-outline"
          title="Customer points"
          description="Look up the points balance for a customer's wallet."
        >
          <Input
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Customer wallet address"
            value={lookup}
            onChangeText={setLookup}
          />
          <Button title="Check balance" variant="secondary" onPress={checkPoints} disabled={!lookup.trim()} />
          {points && <Text style={[ui.h2, { color: colors.link }]}>{points}</Text>}
        </Section>

        <Button title="Sign out" variant="secondary" onPress={signOut} />
      </ScrollView>

      {(dirty || message) && (
        <View
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: keyboard ? keyboard - tabBar + 12 : 12,
            backgroundColor: colors.card,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: colors.line,
            padding: 10,
            gap: 6,
            shadowColor: '#000',
            shadowOpacity: 0.12,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 4 },
            elevation: 6,
          }}
        >
          {message && (
            <Text style={[ui.muted, { textAlign: 'center', color: message === 'Saved' ? colors.paid : colors.danger }]}>
              {message}
            </Text>
          )}
          {dirty && <Button title="Save changes" onPress={save} loading={saving} />}
        </View>
      )}
    </View>
  )
}

const FIELD_LABEL = { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink }

/** A titled group of settings, with an icon. */
function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: IconName
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <View style={{ gap: 8, marginTop: 8 }}>
      <View style={[ui.row, { gap: 10 }]}>
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: colors.line,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name={icon} size={16} color={colors.sea} />
        </View>
        <Text style={ui.h2}>{title}</Text>
      </View>
      {description && <Text style={ui.muted}>{description}</Text>}
      <View style={[ui.card, { gap: 14, borderRadius: 18 }]}>{children}</View>
    </View>
  )
}

/** One labelled setting, with an optional hint underneath the label. */
function Field({
  label,
  hint,
  children,
  style,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  style?: object
}) {
  return (
    <View style={[{ gap: 6 }, style]}>
      <Text style={FIELD_LABEL}>{label}</Text>
      {hint && <Text style={ui.muted}>{hint}</Text>}
      {children}
    </View>
  )
}

/** The shop at the top of Settings, on the Harbour band. */
function ShopCard({ name, detail, pills = [] }: { name: string; detail: string; pills?: (string | null)[] }) {
  return (
    <View style={{ backgroundColor: colors.band, borderRadius: 22, padding: 18, gap: 6 }}>
      <View style={[ui.row, { gap: 12 }]}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 14,
            backgroundColor: colors.bandChip,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="storefront-outline" size={22} color={colors.bandInk} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[ui.h1, { fontSize: 22, color: colors.bandInk }]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={[ui.muted, { color: colors.bandMuted }]}>{detail}</Text>
        </View>
      </View>
      {pills.some(Boolean) && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {pills.filter(Boolean).map((p) => (
            <Text
              key={p}
              style={{
                backgroundColor: colors.bandChip,
                color: colors.bandInk,
                fontFamily: fonts.semibold,
                fontSize: 12,
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 99,
                overflow: 'hidden',
              }}
            >
              {p}
            </Text>
          ))}
        </View>
      )}
    </View>
  )
}
