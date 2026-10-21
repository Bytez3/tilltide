import { isAddress } from '@solana/kit'
import { useEffect, useState } from 'react'
import { Linking, ScrollView, Text, View } from 'react-native'
import { SetupCard } from '@/components/setup-card'
import { MenuEditor } from '@/components/menu-editor'
import { Button, Input, Segmented } from '@/components/ui'
import { colors, fonts, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api } from '@/lib/api'
import { AppConfig } from '@/constants/app-config'
import { currencySymbol, shortAddress } from '@/lib/format'

export default function SettingsScreen() {
  const { merchant, update, signOut, replace, isStaff } = useMerchant()
  const [staffLabel, setStaffLabel] = useState('')
  const [staffCode, setStaffCode] = useState<string | null>(null)
  const [staffMinutes, setStaffMinutes] = useState(15)
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
  const [message, setMessage] = useState<string | null>(null)
  const [lookup, setLookup] = useState('')
  const [points, setPoints] = useState<string | null>(null)

  useEffect(() => {
    if (!merchant) return
    setRate(String(merchant.pointsPerUnit))
    setOwner(merchant.ownerWallet ?? '')
    setToken(merchant.token)
    setCurrency(merchant.currency)
    setCloseTime(merchant.closeTime)
    setSeekerBonus(merchant.seekerBonus)
    setPointValue(merchant.pointValue)
    setPaypalEmail(merchant.paypal.email ?? '')
    setMaxPercent(String(merchant.redeemMaxPercent))
  }, [merchant])

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const pointsPerUnit = Number(rate)
      if (!rate.trim() || !Number.isFinite(pointsPerUnit) || pointsPerUnit < 0 || pointsPerUnit > 1000) {
        throw new Error('Points rate must be a number from 0 to 1000')
      }
      const percent = Number(maxPercent)
      if (!/^\d+(\.\d{1,6})?$/.test(pointValue.trim())) throw new Error('Point value must be a number like 0.01')
      if (!Number.isInteger(percent) || percent < 0 || percent > 90) throw new Error('Points can cover 0 to 90% of a bill')
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(closeTime.trim())) throw new Error('Closing time must look like 17:30')
      const ownerWallet = owner.trim()
      if (ownerWallet && !isAddress(ownerWallet)) throw new Error('Owner wallet is not a Solana address')
      await update({
        pointsPerUnit,
        ownerWallet: ownerWallet || null,
        token,
        currency,
        pointValue: pointValue.trim(),
        redeemMaxPercent: percent,
        closeTime: closeTime.trim(),
        seekerBonus,
      })
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
        await Linking.openURL(url)
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
    if (merchant && !isStaff) api.listStaff().then(setStaffList).catch(() => {})
  }, [merchant, isStaff])

  async function addStaff() {
    setStaffMessage(null)
    try {
      const invite = await api.createStaffInvite(staffLabel.trim() || 'Staff till')
      setStaffCode(invite.code)
      setStaffMinutes(invite.expiresInMinutes)
      setStaffLabel('')
    } catch (e) {
      setStaffMessage(e instanceof Error ? e.message : String(e))
    }
  }

  async function removeStaff(id: string) {
    try {
      await api.removeStaff(id)
      setStaffList(await api.listStaff())
    } catch (e) {
      setStaffMessage(e instanceof Error ? e.message : String(e))
    }
  }

  async function checkPoints() {
    setPoints(null)
    if (!isAddress(lookup.trim())) return setPoints('Not a Solana address')
    const result = await api.getPoints(lookup.trim()).catch((e: Error) => ({ points: e.message, configured: true }))
    setPoints(result.configured ? `${result.points} points` : 'Points are not set up on the server yet')
  }

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.content}>
      {merchant && isStaff ? (
        <View style={ui.card}>
          <Text style={ui.h2}>{merchant.name}</Text>
          <Text style={ui.muted}>Staff till{merchant.staffLabel ? `: ${merchant.staffLabel}` : ''}. Takes payments; the owner manages money and settings.</Text>
        </View>
      ) : merchant ? (
        <View style={ui.card}>
          <Text style={ui.h2}>{merchant.name}</Text>
          <Text style={ui.muted}>
            Till wallet {shortAddress(merchant.wallet)} · {merchant.token} · {merchant.cluster}
          </Text>

          <Text style={[ui.body, { marginTop: 8 }]}>Prices in</Text>
          <Segmented options={(['GBP', 'EUR', 'USD'])} value={currency} onChange={setCurrency} />

          <Text style={[ui.body, { marginTop: 8 }]}>Wallet payments in</Text>
          <Segmented options={(['USDC', 'PYUSD'])} value={token} onChange={setToken} />

          <Text style={[ui.body, { marginTop: 8 }]}>Points per {currencySymbol(currency)}1 spent</Text>
          <Input keyboardType="decimal-pad" value={rate} onChangeText={setRate} />

          <Text style={[ui.body, { marginTop: 8 }]}>When spent, each point is worth ({currencySymbol(currency)})</Text>
          <Input keyboardType="decimal-pad" value={pointValue} onChangeText={setPointValue} />
          <Text style={[ui.body, { marginTop: 8 }]}>Points can pay up to (% of a bill)</Text>
          <Input keyboardType="number-pad" value={maxPercent} onChangeText={setMaxPercent} />

          <Text style={[ui.body, { marginTop: 8 }]}>Seeker owners earn</Text>
          <Segmented options={[1, 1.5, 2, 3]} value={seekerBonus} onChange={setSeekerBonus} label={(m) => (m === 1 ? 'Off' : `×${m}`)} />
          <Text style={ui.muted}>Extra points for customers paying from a Solana Seeker phone (Seeker Genesis Token or SKR).</Text>

          <Text style={[ui.body, { marginTop: 8 }]}>Closing time (end-of-day report)</Text>
          <Input value={closeTime} onChangeText={setCloseTime} placeholder="17:30" maxLength={5} />

          <Text style={[ui.body, { marginTop: 8 }]}>Owner wallet (where sweeps go)</Text>
          <Input autoCapitalize="none" autoCorrect={false} placeholder="Solana address" value={owner} onChangeText={setOwner} />

          <Button title="Save" onPress={save} loading={saving} />
          {message && <Text style={ui.muted}>{message}</Text>}
        </View>
      ) : (
        <SetupCard />
      )}

      {merchant && !isStaff && <MenuEditor />}

      {merchant && !isStaff && (
        <View style={ui.card}>
          <Text style={ui.h2}>Staff devices</Text>
          <Text style={ui.muted}>Let staff take payments on their own phone. They can&apos;t move money, refund or change settings.</Text>
          {staffList.map((d) => (
            <View key={d.id} style={[ui.row, { justifyContent: 'space-between' }]}>
              <Text style={ui.body}>{d.label}</Text>
              <Text style={{ color: colors.danger, fontFamily: fonts.semibold }} onPress={() => removeStaff(d.id)}>
                Remove
              </Text>
            </View>
          ))}
          <Input placeholder="Name, e.g. Saturday till" value={staffLabel} onChangeText={setStaffLabel} maxLength={40} />
          <Button title="Add staff device" variant="secondary" onPress={addStaff} />
          {staffCode && (
            <View style={{ backgroundColor: colors.bg, borderRadius: 10, padding: 12, alignItems: 'center', gap: 4 }}>
              <Text style={ui.muted}>Pairing code</Text>
              <Text style={[ui.h1, { color: colors.sea, letterSpacing: 2 }]} selectable>
                {staffCode}
              </Text>
              <Text style={ui.muted}>Enter it on the staff phone. Works once, for {staffMinutes} minutes.</Text>
            </View>
          )}
          {staffMessage && <Text style={ui.muted}>{staffMessage}</Text>}
        </View>
      )}

      {merchant && !isStaff && merchant.paypalEnabled && (
        <View style={ui.card}>
          <Text style={ui.h2}>PayPal</Text>
          {merchant.paypal.status === 'connected' ? (
            <>
              <Text style={{ color: colors.paid, fontFamily: fonts.bold, fontSize: 15 }}>Connected ✓</Text>
              <Text style={ui.muted}>PayPal sales go straight to your PayPal account.</Text>
            </>
          ) : (
            <Text style={ui.muted}>
              Connect your PayPal so PayPal and card payments go straight to your account.
              {merchant.paypal.required ? ' PayPal sales are off until you do.' : ''}
            </Text>
          )}
          {merchant.paypal.onboardingAvailable && merchant.paypal.status !== 'connected' && (
            <View style={ui.row}>
              <Button title="Connect PayPal" onPress={connectPayPal} loading={paypalBusy} style={{ flex: 2 }} />
              {merchant.paypal.status === 'pending' && <Button title="Check PayPal" variant="secondary" onPress={checkPayPal} style={{ flex: 1 }} />}
            </View>
          )}
          {merchant.paypal.onboardingAvailable && (
            <Text style={ui.muted}>Tilltide fee on PayPal sales: {merchant.paypal.feePercent}%, taken by PayPal.</Text>
          )}
          {!merchant.paypal.onboardingAvailable && (
            <>
              <Text style={ui.body}>PayPal email to be paid to</Text>
              <Input autoCapitalize="none" keyboardType="email-address" value={paypalEmail} onChangeText={setPaypalEmail} />
              <Button title="Save PayPal email" variant="secondary" onPress={savePaypalEmail} />
            </>
          )}
          {paypalMessage && <Text style={ui.muted}>{paypalMessage}</Text>}
        </View>
      )}

      <View style={ui.card}>
        <Text style={ui.h2}>Customer points</Text>
        <Text style={ui.muted}>Look up the points balance for any customer wallet.</Text>
        <Input autoCapitalize="none" autoCorrect={false} placeholder="Customer wallet address" value={lookup} onChangeText={setLookup} />
        <Button title="Check balance" variant="secondary" onPress={checkPoints} disabled={!lookup.trim()} />
        {points && <Text style={[ui.h2, { color: colors.sea }]}>{points}</Text>}
      </View>

      {merchant && <Button title="Sign out" variant="secondary" onPress={signOut} />}
    </ScrollView>
  )
}
