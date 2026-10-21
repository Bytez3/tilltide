import { ActivityIndicator, Pressable, StyleProp, Text, ViewStyle } from 'react-native'
import { colors } from '@/constants/theme'

export function Button({
  title,
  onPress,
  disabled,
  loading,
  variant = 'primary',
  style,
}: {
  title: string
  onPress: () => void
  disabled?: boolean
  loading?: boolean
  variant?: 'primary' | 'secondary'
  style?: StyleProp<ViewStyle>
}) {
  const primary = variant === 'primary'
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          backgroundColor: primary ? colors.sea : colors.card,
          borderColor: primary ? colors.sea : colors.line,
          borderWidth: 1,
          borderRadius: 12,
          paddingVertical: 14,
          alignItems: 'center',
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={primary ? colors.seaInk : colors.sea} />
      ) : (
        <Text style={{ color: primary ? colors.seaInk : colors.ink, fontSize: 16, fontWeight: '600' }}>{title}</Text>
      )}
    </Pressable>
  )
}
