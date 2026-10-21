import { Appearance, StyleSheet } from 'react-native'

const light = {
  bg: '#F6F3EE',
  card: '#FFFFFF',
  ink: '#14211F',
  muted: '#5E6B68',
  placeholder: '#98A29F',
  line: '#E2DDD4',
  sea: '#0E6E6B',
  seaInk: '#FFFFFF',
  seaLight: '#7FC4BC',
  /** Harbour header band behind the big numbers, and the text on it. */
  band: '#0E6E6B',
  bandInk: '#FFFFFF',
  bandMuted: '#BFE3DE',
  bandChip: 'rgba(255,255,255,0.16)',
  /** Cash, in the takings bar. */
  sand: '#D9A54A',
  paid: '#1F8A4C',
  paidBg: '#E6F2EA',
  warn: '#B4561C',
  danger: '#B42318',
}

const dark: typeof light = {
  bg: '#0F1716',
  card: '#172321',
  ink: '#EEF2F1',
  muted: '#9BA8A5',
  placeholder: '#62716E',
  line: '#26342F',
  sea: '#1F8A84',
  seaInk: '#FFFFFF',
  seaLight: '#4E9E97',
  band: '#123F3C',
  bandInk: '#EEF2F1',
  bandMuted: '#8FC9C2',
  bandChip: 'rgba(255,255,255,0.10)',
  sand: '#C99A45',
  paid: '#4CC27D',
  paidBg: '#12291D',
  warn: '#E08A4F',
  danger: '#F07167',
}

/** Light or dark, from the phone's setting when the app starts. */
export const scheme: 'light' | 'dark' = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light'
export const colors = scheme === 'dark' ? dark : light

/** Colour pairs for menu-item icons: a soft tile and a strong glyph, per family. */
const tintsLight = {
  amber: { bg: '#FBE7C6', fg: '#8A5410' },
  pink: { bg: '#F7DCE3', fg: '#8F2B47' },
  brown: { bg: '#EADFD2', fg: '#5B4632' },
  blue: { bg: '#D8ECF7', fg: '#0F4C6E' },
  purple: { bg: '#ECE3F7', fg: '#5B3A8C' },
  coral: { bg: '#FBDDD2', fg: '#8A3413' },
  green: { bg: '#DDEFD6', fg: '#2F5E1E' },
  gray: { bg: '#E7E4DE', fg: '#4A4A45' },
}
const tintsDark: typeof tintsLight = {
  amber: { bg: '#3A2C14', fg: '#F3C77A' },
  pink: { bg: '#3B1C26', fg: '#F2A7BC' },
  brown: { bg: '#33291F', fg: '#D9BFA3' },
  blue: { bg: '#132C3B', fg: '#8CC8EC' },
  purple: { bg: '#2A2140', fg: '#C7AEF0' },
  coral: { bg: '#3B1F15', fg: '#F4A98C' },
  green: { bg: '#1B2F17', fg: '#A6D98F' },
  gray: { bg: '#2A2B28', fg: '#C9C6BE' },
}
export const tints = scheme === 'dark' ? tintsDark : tintsLight
export type Tint = keyof typeof tintsLight


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
