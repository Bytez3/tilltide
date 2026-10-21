import { Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from '@/constants/theme'
import { useOnline } from '@/lib/connectivity'

/** Shown on every screen while the server can't be reached. Disappears by itself when it can. */
export function OfflineBanner() {
  const online = useOnline()
  const insets = useSafeAreaInsets()
  if (online) return null
  return (
    <View
      accessibilityRole="alert"
      style={{ backgroundColor: colors.warn, paddingTop: insets.top + 6, paddingBottom: 8, paddingHorizontal: 16 }}
    >
      <Text style={{ color: '#fff', fontWeight: '600' }}>No connection to Tilltide. Reconnecting…</Text>
      <Text style={{ color: '#fff', fontSize: 13 }}>
        Payments already on screen will still show as paid once the connection is back. Use your card reader for new sales meanwhile.
      </Text>
    </View>
  )
}
