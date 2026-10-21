import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/plus-jakarta-sans'
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import 'react-native-reanimated'
import { AppProviders } from '@/components/app-providers'
import { OfflineBanner } from '@/components/offline-banner'
import { colors, scheme } from '@/constants/theme'

/** Navigation chrome in the app's own colours, light or dark. */
const navTheme = {
  ...(scheme === 'dark' ? DarkTheme : DefaultTheme),
  colors: {
    ...(scheme === 'dark' ? DarkTheme : DefaultTheme).colors,
    primary: colors.sea,
    background: colors.bg,
    card: colors.card,
    text: colors.ink,
    border: colors.line,
  },
}

SplashScreen.preventAutoHideAsync().catch(() => {})

export default function RootLayout() {
  const [loaded, error] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  })
  // If the fonts fail to load, carry on with the system font rather than hang on the splash.
  const ready = loaded || !!error

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {})
  }, [ready])

  if (!ready) return null
  return (
    <ThemeProvider value={navTheme}>
      <AppProviders>
        <OfflineBanner />
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        </Stack>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      </AppProviders>
    </ThemeProvider>
  )
}
