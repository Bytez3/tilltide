import { useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { Button } from '@/components/ui'
import { colors, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { useSignSweep } from '@/features/sweep/use-sweep'
import { api, Sweep } from '@/lib/api'
import { shortAddress } from '@/lib/format'

/** A proposed sweep: shown exactly as it will be signed, with sign / check / cancel. */
export function SweepCard({
  sweep,
  onChange,
  onBusyChange,
}: {
  sweep: Sweep
  onChange: (sweep: Sweep | null) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const { merchant } = useMerchant()
  const signSweep = useSignSweep(merchant)
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

  async function confirm() {
    setSigning(true)
    onBusyChange?.(true)
    setError(null)
    try {
      onChange(await signSweep(sweep))
    } catch (e) {
      setError(message(e))
      // Show the server's view (it may have been submitted before the error).
      onChange(await api.checkSweep(sweep.id).catch(() => sweep))
    } finally {
      setSigning(false)
      onBusyChange?.(false)
    }
  }

  async function checkAgain() {
    onChange(await api.checkSweep(sweep.id).catch((e) => (setError(message(e)), sweep)))
  }

  async function cancel() {
    try {
      await api.cancelSweep(sweep.id)
      onChange(null)
    } catch (e) {
      // It may already be on its way; show the real state instead of hiding it.
      setError(message(e))
      onChange(await api.checkSweep(sweep.id).catch(() => sweep))
    }
  }

  return (
    <View style={[ui.card, { borderColor: colors.sea, borderWidth: 1 }]}>
      <Text style={ui.muted}>Send takings to owner</Text>
      {/* Shown exactly as it will be signed. */}
      <Text style={ui.h1}>
        {sweep.toOwner} {sweep.token}
      </Text>
      <Text style={ui.body}>To owner wallet {shortAddress(sweep.toWallet)}</Text>
      {sweep.feeWallet && sweep.feeAmount !== '0' && (
        <Text style={ui.muted}>
          Tilltide fee {sweep.feeDisplay} {sweep.token} · {sweep.display} {sweep.token} leaves the till
        </Text>
      )}
      <Text style={[ui.muted, { fontFamily: 'monospace' }]} selectable>
        {sweep.toWallet}
      </Text>
      {sweep.reason && <Text style={ui.muted}>{sweep.reason}</Text>}
      {sweep.error && <Text style={[ui.muted, { color: colors.warn }]}>{sweep.error}</Text>}
      {sweep.status === 'signing' && !signing ? (
        <View style={{ gap: 8 }}>
          <Text style={ui.muted}>Waiting to hear whether the wallet sent it. This takes up to a minute.</Text>
          <Button title="Check again" variant="secondary" onPress={checkAgain} />
        </View>
      ) : sweep.status === 'submitted' || sweep.status === 'signing' ? (
        <View style={{ gap: 8 }}>
          <View style={ui.row}>
            {signing && <ActivityIndicator color={colors.sea} />}
            <Text style={ui.muted}>Sent. Confirming on the chain…</Text>
          </View>
          {!signing && <Button title="Check again" variant="secondary" onPress={checkAgain} />}
        </View>
      ) : sweep.status === 'failed' ? (
        <Text style={{ color: colors.danger, fontWeight: '600' }}>Needs checking. Do not sign again; contact support.</Text>
      ) : sweep.status === 'proposed' ? (
        <View style={ui.row}>
          <Button title="Cancel" variant="secondary" onPress={cancel} style={{ flex: 1 }} />
          <Button title="Confirm & sign" onPress={confirm} loading={signing} style={{ flex: 2 }} />
        </View>
      ) : (
        <Text style={{ color: sweep.status === 'confirmed' ? colors.paid : colors.muted, fontWeight: '600' }}>
          {sweep.status === 'confirmed' ? 'Sent ✓' : 'Cancelled'}
        </Text>
      )}
      {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
    </View>
  )
}
