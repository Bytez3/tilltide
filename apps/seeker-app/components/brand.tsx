import { Image, Text, View } from 'react-native'
import { colors, fonts } from '@/constants/theme'

const MARK = require('@/assets/images/icon.png')

/** The screen title beside the Tilltide mark. */
export function BrandTitle({ title }: { title: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Image source={MARK} style={{ width: 28, height: 28, borderRadius: 8 }} accessibilityIgnoresInvertColors />
      <Text style={{ fontFamily: fonts.bold, fontSize: 20, color: colors.ink, letterSpacing: -0.3 }}>{title}</Text>
    </View>
  )
}
