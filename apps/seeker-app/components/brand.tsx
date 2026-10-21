import { Image, Text, View } from 'react-native'
import { colors, fonts } from '@/constants/theme'

const MARK = require('@/assets/images/icon.png')

/** The screen title beside the Tilltide mark. `onBand` for the teal Harbour header. */
export function BrandTitle({ title, onBand = false }: { title: string; onBand?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Image
        source={MARK}
        // On the teal band the teal mark needs a light edge to stand out.
        style={{ width: 28, height: 28, borderRadius: 8, borderWidth: onBand ? 1.5 : 0, borderColor: 'rgba(255,255,255,0.55)' }}
        accessibilityIgnoresInvertColors
      />
      <Text style={{ fontFamily: fonts.bold, fontSize: 20, color: onBand ? colors.bandInk : colors.ink, letterSpacing: -0.3 }}>{title}</Text>
    </View>
  )
}
