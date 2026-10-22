// Landing spot for a wallet app sending the owner back (iPhone deeplinks). The wallet provider reads
// the reply from the link itself; this screen just returns to wherever the owner was.
import { router } from 'expo-router'
import { useEffect } from 'react'

export default function WalletCallback() {
  useEffect(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/')
  }, [])
  return null
}
