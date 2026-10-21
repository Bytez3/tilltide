import { useState } from 'react'
import { Text, TextInput, View } from 'react-native'
import { Button } from '@/components/ui'
import { ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'

/** First-run: name the shop and connect the till wallet over Mobile Wallet Adapter. */
export function SetupCard() {
  const { setUp } = useMerchant()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await setUp(name.trim())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={ui.card}>
      <Text style={ui.h2}>Set up your till</Text>
      <Text style={ui.muted}>
        Connect the wallet that receives payments. Your keys stay in your wallet app; Tilltide never sees them.
      </Text>
      <TextInput style={ui.input} placeholder="Shop name" value={name} onChangeText={setName} />
      <Button title="Connect wallet" onPress={submit} disabled={!name.trim()} loading={busy} />
      {error && <Text style={[ui.muted, { color: '#B42318' }]}>{error}</Text>}
    </View>
  )
}
