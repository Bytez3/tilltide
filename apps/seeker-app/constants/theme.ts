import { StyleSheet } from 'react-native'

export const colors = {
  bg: '#F6F3EE',
  card: '#FFFFFF',
  ink: '#14211F',
  muted: '#5E6B68',
  placeholder: '#98A29F',
  line: '#E2DDD4',
  sea: '#0E6E6B',
  seaInk: '#FFFFFF',
  seaLight: '#7FC4BC',
  /** Cash, in the takings bar. */
  sand: '#D9A54A',
  paid: '#1F8A4C',
  paidBg: '#E6F2EA',
  warn: '#B4561C',
  danger: '#B42318',
}

/** Plus Jakarta Sans, loaded in app/_layout.tsx. Custom fonts pick weight by family name, not fontWeight. */
export const fonts = {
  regular: 'PlusJakartaSans_400Regular',
  medium: 'PlusJakartaSans_500Medium',
  semibold: 'PlusJakartaSans_600SemiBold',
  bold: 'PlusJakartaSans_700Bold',
  extrabold: 'PlusJakartaSans_800ExtraBold',
}

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 16,
    gap: 8,
  },
  h1: { fontSize: 26, fontFamily: fonts.extrabold, color: colors.ink, letterSpacing: -0.5 },
  h2: { fontSize: 17, fontFamily: fonts.bold, color: colors.ink },
  body: { fontSize: 15, fontFamily: fonts.regular, color: colors.ink, lineHeight: 21 },
  muted: { fontSize: 13, fontFamily: fonts.regular, color: colors.muted, lineHeight: 18 },
  /** Small caps-style section label above a card's main figure. */
  label: { fontSize: 12, fontFamily: fonts.semibold, color: colors.muted, letterSpacing: 0.8, textTransform: 'uppercase' },
  /** Money: tabular figures so amounts don't jiggle as they change. */
  money: { fontFamily: fonts.extrabold, color: colors.ink, fontVariant: ['tabular-nums'], letterSpacing: -1 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: fonts.regular,
    color: colors.ink,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
})
