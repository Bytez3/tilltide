import { useState } from 'react'
import { Text, View } from 'react-native'
import { Button, Input } from '@/components/ui'
import { colors, fonts, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { useWallet } from '@/features/wallet/wallet'

/** First-run: name the shop and connect the till wallet over Mobile Wallet Adapter. */
export function SetupCard() {
  const { signInAndSetUp, pairStaff } = useMerchant()
  const [staffMode, setStaffMode] = useState(false)
  const [code, setCode] = useState('')
  const { isTestWallet, account, disconnect } = useWallet()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      if (staffMode) await pairStaff(code)
      else await signInAndSetUp(name)
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

  if (staffMode) {
    return (
      <View style={ui.card}>
        <Text style={ui.h2}>Pair a staff till</Text>
        <Text style={ui.muted}>Ask the owner for a pairing code (Settings → Staff devices). Staff can take payments but can&apos;t move money.</Text>
        <Input placeholder="1234-5678" keyboardType="number-pad" value={code} onChangeText={setCode} maxLength={9} />
        <Button title="Pair this device" onPress={submit} disabled={code.replace(/\D/g, '').length !== 8} loading={busy} />
        {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
        <Text
          style={[ui.muted, { textAlign: 'center', marginTop: 4, color: colors.sea, fontFamily: fonts.semibold }]}
          accessibilityRole="button"
          onPress={() => (setStaffMode(false), setError(null))}
        >
          I&apos;m the owner
        </Text>
      </View>
    )
  }

  return (
    <View style={ui.card}>
      <Text style={ui.h2}>Set up your till</Text>
      <Text style={ui.muted}>
        Sign in with your shop&apos;s wallet app. Your keys stay in the wallet; Tilltide never sees them.
      </Text>
      {isTestWallet && (
        <Text style={[ui.muted, { color: colors.warn }]}>
          Browser sandbox: signing uses a local test wallet on a local test chain. No real money.
        </Text>
      )}
      <Input placeholder="Shop name (new shops only)" value={name} onChangeText={setName} maxLength={80} />
      <Button title="Sign in with wallet" onPress={submit} loading={busy} />
      {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
      {account && !isTestWallet && (
        <Text
          style={[ui.muted, { textAlign: 'center', color: colors.sea, fontFamily: fonts.semibold }]}
          accessibilityRole="button"
          onPress={() => (disconnect().catch(() => {}), setError(null))}
        >
          Use a different wallet or account
        </Text>
      )}
      <Text
        style={[ui.muted, { textAlign: 'center', marginTop: 4, color: colors.sea, fontFamily: fonts.semibold }]}
        accessibilityRole="button"
        onPress={() => (setStaffMode(true), setError(null))}
      >
        I work here: pair this phone as a staff till
      </Text>
    </View>
  )
}
