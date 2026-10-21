import { Ionicons } from '@expo/vector-icons'
import { Tabs } from 'expo-router'
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
  const { merchant, isStaff } = useMerchant()
  const insets = useSafeAreaInsets()
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.sea,
        // The default bar squeezes the label box below its line height, which clips descenders (g, y).
        tabBarStyle: { height: 64 + insets.bottom, paddingTop: 4, paddingBottom: 4 + insets.bottom },
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
      <Tabs.Screen name="index" options={tab('Charge', 'qr-code-outline')} />
      <Tabs.Screen name="activity" options={tab('Activity', 'receipt-outline')} />
      <Tabs.Screen name="agent" options={{ ...tab('Agent', 'chatbubble-ellipses-outline'), href: isStaff ? null : undefined }} />
      <Tabs.Screen name="settings" options={tab('Settings', 'settings-outline')} />
    </Tabs>
  )
}
