import { useState } from 'react'
import { Text, TextInput, View } from 'react-native'
import { Button } from '@/components/ui'
import { ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'

/** First-run: name the shop and connect the till wallet over Mobile Wallet Adapter. */
export function SetupCard() {
  const { signInAndSetUp } = useMerchant()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await signInAndSetUp(name)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(
        /no installed wallet/i.test(message)
          ? 'No Solana wallet found on this phone. Install Phantom or Solflare (or use a Seeker), then try again.'
          : message,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={ui.card}>
      <Text style={ui.h2}>Sign in to your till</Text>
      <Text style={ui.muted}>
        Sign in with the wallet that receives payments. Your keys stay in your wallet app; Tilltide never sees them.
      </Text>
      <TextInput style={ui.input} placeholder="Shop name (new shops only)" value={name} onChangeText={setName} maxLength={80} />
      <Button title="Sign in with wallet" onPress={submit} loading={busy} />
      {error && <Text style={[ui.muted, { color: '#B42318' }]}>{error}</Text>}
    </View>
  )
}
