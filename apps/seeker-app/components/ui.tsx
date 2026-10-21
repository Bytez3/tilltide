import { ActivityIndicator, Pressable, StyleProp, Text, TextInput, TextInputProps, ViewStyle } from 'react-native'
import { colors, ui } from '@/constants/theme'

/** A text field with a clearly lighter placeholder, so hints never look like typed values. */
export function Input({ style, ...props }: TextInputProps) {
  return <TextInput placeholderTextColor={colors.placeholder} {...props} style={[ui.input, style]} />
}

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
          paddingHorizontal: 12,
          alignItems: 'center',
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={primary ? colors.seaInk : colors.sea} />
      ) : (
        <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: primary ? colors.seaInk : colors.ink, fontSize: 16, fontWeight: '600' }}>{title}</Text>
      )}
    </Pressable>
  )
}
