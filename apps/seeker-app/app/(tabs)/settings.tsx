import { isAddress } from '@solana/kit'
import { useEffect, useState } from 'react'
import { Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { SetupCard } from '@/components/setup-card'
import { Button } from '@/components/ui'
import { colors, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api } from '@/lib/api'
import { AppConfig } from '@/constants/app-config'
import { shortAddress } from '@/lib/format'

export default function SettingsScreen() {
  const { merchant, update, signOut, replace } = useMerchant()
  const [paypalEmail, setPaypalEmail] = useState('')
  const [paypalBusy, setPaypalBusy] = useState(false)
  const [paypalMessage, setPaypalMessage] = useState<string | null>(null)
  const [rate, setRate] = useState('')
  const [owner, setOwner] = useState('')
  const [token, setToken] = useState<'USDC' | 'PYUSD'>('USDC')
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
      const ownerWallet = owner.trim()
      if (ownerWallet && !isAddress(ownerWallet)) throw new Error('Owner wallet is not a Solana address')
      await update({ pointsPerUnit, ownerWallet: ownerWallet || null, token, pointValue: pointValue.trim(), redeemMaxPercent: percent })
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

  async function checkPoints() {
    setPoints(null)
    if (!isAddress(lookup.trim())) return setPoints('Not a Solana address')
    const result = await api.getPoints(lookup.trim()).catch((e: Error) => ({ points: e.message, configured: true }))
    setPoints(result.configured ? `${result.points} points` : 'Points are not set up on the server yet')
  }

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.content}>
      {merchant ? (
        <View style={ui.card}>
          <Text style={ui.h2}>{merchant.name}</Text>
          <Text style={ui.muted}>
            Till wallet {shortAddress(merchant.wallet)} · {merchant.token} · {merchant.cluster}
          </Text>

          <Text style={[ui.body, { marginTop: 8 }]}>Take payments in</Text>
          <View style={ui.row}>
            {(['USDC', 'PYUSD'] as const).map((t) => (
              <Pressable
                key={t}
                onPress={() => setToken(t)}
                accessibilityRole="button"
                accessibilityState={{ selected: token === t }}
                style={[ui.input, { flex: 1, alignItems: 'center' }, token === t && { borderColor: colors.sea, borderWidth: 2 }]}
              >
                <Text style={[ui.body, { fontWeight: '600' }]}>{t}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={[ui.body, { marginTop: 8 }]}>Points per 1 {token}</Text>
          <TextInput style={ui.input} keyboardType="decimal-pad" value={rate} onChangeText={setRate} />

          <Text style={[ui.body, { marginTop: 8 }]}>When spent, each point is worth ({token})</Text>
          <TextInput style={ui.input} keyboardType="decimal-pad" value={pointValue} onChangeText={setPointValue} />
          <Text style={[ui.body, { marginTop: 8 }]}>Points can pay up to (% of a bill)</Text>
          <TextInput style={ui.input} keyboardType="number-pad" value={maxPercent} onChangeText={setMaxPercent} />

          <Text style={[ui.body, { marginTop: 8 }]}>Owner wallet (where sweeps go)</Text>
          <TextInput style={ui.input} autoCapitalize="none" autoCorrect={false} placeholder="Solana address" value={owner} onChangeText={setOwner} />

          <Button title="Save" onPress={save} loading={saving} />
          {message && <Text style={ui.muted}>{message}</Text>}
        </View>
      ) : (
        <SetupCard />
      )}

      {merchant && merchant.paypalEnabled && (
        <View style={ui.card}>
          <Text style={ui.h2}>PayPal</Text>
          {merchant.paypal.status === 'connected' ? (
            <Text style={[ui.body, { color: colors.paid, fontWeight: '600' }]}>Connected ✓ PayPal sales go to your PayPal account.</Text>
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
              <TextInput style={ui.input} autoCapitalize="none" keyboardType="email-address" value={paypalEmail} onChangeText={setPaypalEmail} />
              <Button title="Save PayPal email" variant="secondary" onPress={savePaypalEmail} />
            </>
          )}
          {paypalMessage && <Text style={ui.muted}>{paypalMessage}</Text>}
        </View>
      )}

      <View style={ui.card}>
        <Text style={ui.h2}>Customer points</Text>
        <Text style={ui.muted}>Look up the points balance for any customer wallet.</Text>
        <TextInput style={ui.input} autoCapitalize="none" autoCorrect={false} placeholder="Customer wallet address" value={lookup} onChangeText={setLookup} />
        <Button title="Check balance" variant="secondary" onPress={checkPoints} disabled={!lookup.trim()} />
        {points && <Text style={[ui.h2, { color: colors.sea }]}>{points}</Text>}
      </View>

      {merchant && <Button title="Sign out" variant="secondary" onPress={signOut} />}
    </ScrollView>
  )
}
