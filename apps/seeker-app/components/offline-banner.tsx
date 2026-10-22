import { Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { fonts } from '@/constants/theme'
import { useOnline } from '@/lib/connectivity'

/** Deep amber in both modes, so the white text stays readable (dark mode's warn colour is too light). */
const OFFLINE_BG = '#8A3B0E'

/** Shown on every screen while the server can't be reached. Disappears by itself when it can. */
export function OfflineBanner() {
  const online = useOnline()
  const insets = useSafeAreaInsets()
  if (online) return null
  return (
    <View
      accessibilityRole="alert"
      style={{ backgroundColor: OFFLINE_BG, paddingTop: insets.top + 6, paddingBottom: 8, paddingHorizontal: 16 }}
    >
      <Text style={{ color: '#fff', fontFamily: fonts.semibold }}>No connection to Tilltide. Reconnecting…</Text>
      <Text style={{ color: '#fff', fontSize: 13, fontFamily: fonts.medium }}>
        Payments already on screen will still show as paid once the connection is back. Use your card reader for new sales meanwhile.
      </Text>
    </View>
  )
}
