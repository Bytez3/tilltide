import { ActivityIndicator, Pressable, StyleProp, Text, TextInput, TextInputProps, View, ViewStyle } from 'react-native'
import { colors, fonts, ui } from '@/constants/theme'

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
        <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: primary ? colors.seaInk : colors.ink, fontSize: 16, fontFamily: fonts.semibold }}>{title}</Text>
      )}
    </Pressable>
  )
}

/** A small rounded toggle or action, for optional extras under the main control. */
export function Chip({ label, onPress, selected }: { label: string; onPress: () => void; selected?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? colors.sea : colors.line,
        backgroundColor: selected ? colors.sea : colors.card,
        paddingHorizontal: 14,
        paddingVertical: 7,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ color: selected ? colors.seaInk : colors.sea, fontFamily: fonts.semibold, fontSize: 14 }}>{label}</Text>
    </Pressable>
  )
}

/** One choice from a few options, as a single rounded bar with the chosen option filled. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label = (o) => String(o),
  stretch = true,
}: {
  options: readonly T[]
  value: T
  onChange: (value: T) => void
  label?: (option: T) => string
  stretch?: boolean
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: colors.line,
        borderRadius: 12,
        padding: 3,
        gap: 3,
        alignSelf: stretch ? 'stretch' : 'flex-start',
      }}
    >
      {options.map((option) => {
        const selected = option === value
        return (
          <Pressable
            key={String(option)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(option)}
            style={{
              flex: stretch ? 1 : undefined,
              alignItems: 'center',
              paddingVertical: 9,
              paddingHorizontal: 16,
              borderRadius: 9,
              backgroundColor: selected ? colors.card : 'transparent',
              shadowColor: '#000',
              shadowOpacity: selected ? 0.08 : 0,
              shadowRadius: 3,
              shadowOffset: { width: 0, height: 1 },
              elevation: selected ? 1 : 0,
            }}
          >
            <Text style={{ fontFamily: selected ? fonts.bold : fonts.medium, fontSize: 15, color: selected ? colors.sea : colors.muted }}>
              {label(option)}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
