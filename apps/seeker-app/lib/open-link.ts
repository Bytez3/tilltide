import { Linking, Platform } from 'react-native'

/**
 * Opens a link we only have after a network call. Browsers block a new tab that isn't opened straight
 * from the tap (iPhone Safari silently), so on the web this goes there in the same tab instead.
 */
export async function openLinkAfterRequest(url: string) {
  if (Platform.OS === 'web') window.location.assign(url)
  else await Linking.openURL(url)
}
