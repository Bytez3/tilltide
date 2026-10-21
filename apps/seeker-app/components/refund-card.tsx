import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { Button } from '@/components/ui'
import { colors, ui } from '@/constants/theme'
import { useApproveRefund } from '@/features/refund/use-approve-refund'
import { api, Refund } from '@/lib/api'
import { currencySymbol } from '@/lib/format'

/** A proposed PayPal refund: approve with the till wallet, or cancel. Follows PENDING refunds to the end. */
export function RefundCard({
  refund,
  onChange,
  onBusyChange,
}: {
  refund: Refund
  onChange: (refund: Refund | null) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const approveRefund = useApproveRefund()
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

  useEffect(() => {
    if ((refund.status !== 'pending' && refund.status !== 'processing') || signing) return
    const timer = setTimeout(async () => {
      const latest = await api.getRefund(refund.id).catch(() => null)
      if (latest) onChange(latest)
    }, 5000)
    return () => clearTimeout(timer)
  }, [refund, signing, onChange])

  async function approve() {
    setSigning(true)
    onBusyChange?.(true)
    setError(null)
    try {
      onChange(await approveRefund(refund))
    } catch (e) {
      setError(message(e))
      onChange(await api.getRefund(refund.id).catch(() => refund))
    } finally {
      setSigning(false)
      onBusyChange?.(false)
    }
  }

  async function cancel() {
    try {
      onChange(await api.cancelRefund(refund.id))
    } catch (e) {
      setError(message(e))
    }
  }

  return (
    <View style={[ui.card, { borderColor: colors.sea, borderWidth: 1 }]}>
      <Text style={ui.muted}>PayPal refund</Text>
      <Text style={ui.h1}>
        {currencySymbol(refund.currency)}{refund.display}
      </Text>
      {refund.reason && <Text style={ui.muted}>{refund.reason}</Text>}
      {refund.error && <Text style={[ui.muted, { color: colors.warn }]}>{refund.error}</Text>}
      {refund.status === 'proposed' || refund.status === 'processing' ? (
        <View style={ui.row}>
          {refund.status === 'proposed' && <Button title="Cancel" variant="secondary" onPress={cancel} style={{ flex: 1 }} />}
          <Button
            title={refund.status === 'processing' ? 'Retry refund' : 'Approve with wallet'}
            onPress={approve}
            loading={signing}
            style={{ flex: 2 }}
          />
        </View>
      ) : (
        <Text
          style={{
            color: refund.status === 'completed' ? colors.paid : refund.status === 'failed' ? colors.danger : colors.muted,
            fontWeight: '600',
          }}
        >
          {refund.status === 'completed'
            ? 'Refunded ✓'
            : refund.status === 'pending'
              ? 'PayPal is processing the refund'
              : refund.status === 'failed'
                ? 'Refund failed'
                : 'Cancelled'}
        </Text>
      )}
      {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
    </View>
  )
}
