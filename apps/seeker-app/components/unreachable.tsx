import { Ionicons } from '@expo/vector-icons'
import { ActivityIndicator, Text, View } from 'react-native'
import { colors, ui } from '@/constants/theme'

/** Shown instead of sign-in when a saved session couldn't be checked because the server is unreachable. */
export function Unreachable() {
  return (
    <View style={[ui.screen, { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 }]}>
      <Ionicons name="cloud-offline-outline" size={44} color={colors.muted} />
      <Text style={[ui.h2, { textAlign: 'center' }]}>Can&apos;t reach Tilltide</Text>
      <Text style={[ui.muted, { textAlign: 'center', maxWidth: 300 }]}>
        You&apos;re still signed in. The till will open by itself as soon as the connection is back. Use your card reader meanwhile.
      </Text>
      <ActivityIndicator color={colors.sea} />
    </View>
  )
}
