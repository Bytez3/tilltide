import { Ionicons } from '@expo/vector-icons'
import { Tabs } from 'expo-router'
import { colors } from '@/constants/theme'

type IconName = keyof typeof Ionicons.glyphMap

const tab = (title: string, icon: IconName) => ({
  title,
  tabBarIcon: ({ color, size }: { color: string; size: number }) => <Ionicons name={icon} color={color} size={size} />,
})

export default function TabsLayout() {
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
      <Tabs.Screen name="agent" options={tab('Agent', 'chatbubble-ellipses-outline')} />
      <Tabs.Screen name="settings" options={tab('Settings', 'settings-outline')} />
    </Tabs>
  )
}
