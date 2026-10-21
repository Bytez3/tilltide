import { Ionicons } from '@expo/vector-icons'
import { useEffect, useRef } from 'react'
import { Animated, Easing } from 'react-native'
import { colors } from '@/constants/theme'

/** The "Paid" moment: a green disc springs in and the tick pops in on top. */
export function PaidTick({ size = 112 }: { size?: number }) {
  const disc = useRef(new Animated.Value(0)).current
  const tick = useRef(new Animated.Value(0)).current

  useEffect(() => {
    // The tick starts while the disc is still settling, so the whole moment lands in about 0.4s.
    Animated.parallel([
      Animated.spring(disc, { toValue: 1, friction: 6, tension: 140, useNativeDriver: true }),
      Animated.timing(tick, { toValue: 1, delay: 150, duration: 220, easing: Easing.out(Easing.back(2)), useNativeDriver: true }),
    ]).start()
  }, [disc, tick])

  return (
    <Animated.View
      accessibilityLabel="Paid"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.paid,
        alignItems: 'center',
        justifyContent: 'center',
        transform: [{ scale: disc }],
      }}
    >
      <Animated.View style={{ opacity: tick, transform: [{ scale: tick }] }}>
        <Ionicons name="checkmark" size={size * 0.62} color="#FFFFFF" />
      </Animated.View>
    </Animated.View>
  )
}
