import { Ionicons } from '@expo/vector-icons'
import { Image, ScrollView, Text, View } from 'react-native'
import { SetupCard } from '@/components/setup-card'
import { colors, fonts, ui } from '@/constants/theme'

const MARK = require('@/assets/images/icon.png')

type IconName = keyof typeof Ionicons.glyphMap
const BENEFITS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'qr-code-outline', title: 'PayPal, card, wallet or cash', body: 'Customers scan and pay. Money goes straight to your account.' },
  { icon: 'heart-outline', title: 'Loyalty built in', body: 'Every customer earns points. No stamp cards, nothing to carry.' },
  { icon: 'sparkles-outline', title: 'Your books, done', body: 'An end-of-day report and a CSV for your bookkeeper. Ask it anything.' },
]

/** First screen for a phone that isn't signed in: what Tilltide is, then sign in or pair as staff. */
export function Welcome() {
  return (
    <ScrollView style={ui.screen} contentContainerStyle={[ui.content, { paddingTop: 56, paddingBottom: 32 }]} keyboardShouldPersistTaps="handled">
      <View style={{ alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <Image source={MARK} style={{ width: 72, height: 72, borderRadius: 20 }} accessibilityIgnoresInvertColors />
        <Text style={{ fontFamily: fonts.extrabold, fontSize: 34, color: colors.ink, letterSpacing: -1 }}>Tilltide</Text>
        <Text style={[ui.body, { textAlign: 'center', color: colors.muted, fontSize: 16, maxWidth: 300 }]}>
          The till that pays you more and does your books.
        </Text>
      </View>
      <View style={{ gap: 14, marginVertical: 12 }}>
        {BENEFITS.map((b) => (
          <View key={b.title} style={[ui.row, { alignItems: 'flex-start', gap: 14 }]}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line }}>
              <Ionicons name={b.icon} size={20} color={colors.sea} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={ui.h2}>{b.title}</Text>
              <Text style={ui.muted}>{b.body}</Text>
            </View>
          </View>
        ))}
      </View>
      <SetupCard />
    </ScrollView>
  )
}
