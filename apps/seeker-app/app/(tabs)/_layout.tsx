import { Ionicons } from '@expo/vector-icons'
import { router, Tabs } from 'expo-router'
import { useEffect } from 'react'
import { Text } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BrandTitle } from '@/components/brand'
import { colors, fonts } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'

type IconName = keyof typeof Ionicons.glyphMap

const tab = (title: string, icon: IconName) => ({
  title,
  tabBarIcon: ({ color, size }: { color: string; size: number }) => <Ionicons name={icon} color={color} size={size} />,
})

export default function TabsLayout() {
  // Staff devices take payments only: no agent (it can propose moving money).
  const { merchant, loading, isStaff } = useMerchant()
  // Signed out (or the session ended) on any tab: back to the welcome screen, since the tabs are hidden.
  useEffect(() => {
    if (!loading && !merchant) router.replace('/')
  }, [loading, merchant])
  const insets = useSafeAreaInsets()
  return (
    // Keyed on the shop: signing out (or into another shop) remounts every tab, so no sale, basket,
    // chat or approval card from the last session survives.
    <Tabs
      key={merchant?.id ?? 'signed-out'}
      screenOptions={{
        tabBarActiveTintColor: colors.sea,
        tabBarInactiveTintColor: colors.muted,
        // The default bar squeezes the label box below its line height, which clips descenders (g, y).
        // Signed out, the phone shows only the welcome screen: no tabs, no header.
        headerShown: !!merchant,
        tabBarStyle: merchant
          ? { height: 64 + insets.bottom, paddingTop: 4, paddingBottom: 4 + insets.bottom, backgroundColor: colors.card, borderTopColor: colors.line }
          : { display: 'none' },
        tabBarLabelStyle: { fontSize: 11, lineHeight: 14, fontFamily: fonts.medium },
        headerStyle: { backgroundColor: colors.bg },
        headerTitleAlign: 'left',
        headerTitle: ({ children }) => <BrandTitle title={children} />,
        headerRight: () =>
          merchant ? (
            <Text numberOfLines={1} style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.muted, marginRight: 16, maxWidth: 160 }}>
              {merchant.name}
            </Text>
          ) : null,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      {/* Harbour: the till's header is the top of the teal band that holds the total. */}
      <Tabs.Screen
        name="index"
        options={{
          ...tab('Charge', 'qr-code-outline'),
          headerStyle: { backgroundColor: colors.band },
          headerTitle: ({ children }) => <BrandTitle title={children} onBand />,
          headerRight: () =>
            merchant ? (
              <Text numberOfLines={1} style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.bandMuted, marginRight: 16, maxWidth: 160 }}>
                {merchant.name}
              </Text>
            ) : null,
        }}
      />
      <Tabs.Screen name="activity" options={tab('Activity', 'receipt-outline')} />
      <Tabs.Screen name="agent" options={{ ...tab('Assistant', 'sparkles-outline'), href: isStaff ? null : undefined }} />
      <Tabs.Screen name="settings" options={tab('Settings', 'settings-outline')} />
    </Tabs>
  )
}
