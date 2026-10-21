import { Ionicons } from '@expo/vector-icons'
import { Tabs } from 'expo-router'
import { colors } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'

type IconName = keyof typeof Ionicons.glyphMap

const tab = (title: string, icon: IconName) => ({
  title,
  tabBarIcon: ({ color, size }: { color: string; size: number }) => <Ionicons name={icon} color={color} size={size} />,
})

export default function TabsLayout() {
  // Staff devices take payments only: no agent (it can propose moving money).
  const { isStaff } = useMerchant()
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.sea,
        headerStyle: { backgroundColor: colors.bg },
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
