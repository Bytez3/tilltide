import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PropsWithChildren } from 'react'
import { AppState, Platform } from 'react-native'
import { MerchantProvider } from '@/features/merchant/merchant-provider'
import { WalletProvider } from '@/features/wallet/wallet'

const queryClient = new QueryClient()

// React Query only knows about browser focus. On a phone, coming back to the app counts as focus,
// so menus, sales and summaries refresh when the till is picked up again.
if (Platform.OS !== 'web') {
  focusManager.setEventListener((handleFocus) => {
    const sub = AppState.addEventListener('change', (state) => handleFocus(state === 'active'))
    return () => sub.remove()
  })
}

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <MerchantProvider>{children}</MerchantProvider>
      </WalletProvider>
    </QueryClientProvider>
  )
}
