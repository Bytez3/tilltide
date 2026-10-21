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
  paid: '#1F8A4C',
  warn: '#B4561C',
  danger: '#B42318',
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
  h1: { fontSize: 26, fontWeight: '700', color: colors.ink },
  h2: { fontSize: 17, fontWeight: '600', color: colors.ink },
  body: { fontSize: 15, color: colors.ink },
  muted: { fontSize: 13, color: colors.muted },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
})
