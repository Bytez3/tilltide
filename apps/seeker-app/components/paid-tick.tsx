import { Ionicons } from '@expo/vector-icons'
import { useEffect, useRef } from 'react'
import { Animated, Easing, Platform } from 'react-native'
import { colors } from '@/constants/theme'

// Web has no native animation driver; the JS driver is smooth enough there.
const NATIVE_DRIVER = Platform.OS !== 'web'

/** The "Paid" moment: a green disc springs in and the tick pops in on top. */
export function PaidTick({ size = 112, onBand = false }: { size?: number; onBand?: boolean }) {
  const disc = useRef(new Animated.Value(0)).current
  const tick = useRef(new Animated.Value(0)).current

  useEffect(() => {
    // The tick starts while the disc is still settling, so the whole moment lands in about 0.4s.
    Animated.parallel([
      Animated.spring(disc, { toValue: 1, friction: 6, tension: 140, useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(tick, { toValue: 1, delay: 150, duration: 220, easing: Easing.out(Easing.back(2)), useNativeDriver: NATIVE_DRIVER }),
    ]).start()
  }, [disc, tick])

  return (
    <Animated.View
      accessibilityLabel="Paid"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        // On the teal band the disc is white with a green tick; elsewhere green with a white tick.
        backgroundColor: onBand ? '#FFFFFF' : colors.paid,
        alignItems: 'center',
        justifyContent: 'center',
        transform: [{ scale: disc }],
      }}
    >
      <Animated.View style={{ opacity: tick, transform: [{ scale: tick }] }}>
        <Ionicons name="checkmark" size={size * 0.62} color={onBand ? colors.paid : '#FFFFFF'} />
      </Animated.View>
    </Animated.View>
  )
}
