import { isAddress } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useEffect, useState } from 'react'
import { ScrollView, Text, TextInput, View } from 'react-native'
import { SetupCard } from '@/components/setup-card'
import { Button } from '@/components/ui'
import { colors, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api } from '@/lib/api'
import { shortAddress } from '@/lib/format'

export default function SettingsScreen() {
  const { merchant, update } = useMerchant()
  const { disconnect } = useMobileWallet()
  const [rate, setRate] = useState('')
  const [owner, setOwner] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [lookup, setLookup] = useState('')
  const [points, setPoints] = useState<string | null>(null)

  useEffect(() => {
    if (!merchant) return
    setRate(String(merchant.pointsPerUnit))
    setOwner(merchant.ownerWallet ?? '')
  }, [merchant])

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const pointsPerUnit = Number(rate)
      if (!Number.isFinite(pointsPerUnit) || pointsPerUnit < 0) throw new Error('Points rate must be a number')
      if (owner && !isAddress(owner)) throw new Error('Owner wallet is not a Solana address')
      await update({ pointsPerUnit, ownerWallet: owner || null })
      setMessage('Saved')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
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

          <Text style={[ui.body, { marginTop: 8 }]}>Points per 1 {merchant.token}</Text>
          <TextInput style={ui.input} keyboardType="decimal-pad" value={rate} onChangeText={setRate} />

          <Text style={[ui.body, { marginTop: 8 }]}>Owner wallet (where sweeps go)</Text>
          <TextInput style={ui.input} autoCapitalize="none" autoCorrect={false} placeholder="Solana address" value={owner} onChangeText={setOwner} />

          <Button title="Save" onPress={save} loading={saving} />
          {message && <Text style={ui.muted}>{message}</Text>}
        </View>
      ) : (
        <SetupCard />
      )}

      <View style={ui.card}>
        <Text style={ui.h2}>Customer points</Text>
        <Text style={ui.muted}>Look up the points balance for any customer wallet.</Text>
        <TextInput style={ui.input} autoCapitalize="none" autoCorrect={false} placeholder="Customer wallet address" value={lookup} onChangeText={setLookup} />
        <Button title="Check balance" variant="secondary" onPress={checkPoints} disabled={!lookup.trim()} />
        {points && <Text style={[ui.h2, { color: colors.sea }]}>{points}</Text>}
      </View>

      {merchant && <Button title="Disconnect wallet" variant="secondary" onPress={disconnect} />}
    </ScrollView>
  )
}
