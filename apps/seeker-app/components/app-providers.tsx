import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PropsWithChildren } from 'react'
import { MerchantProvider } from '@/features/merchant/merchant-provider'
import { WalletProvider } from '@/features/wallet/wallet'

const queryClient = new QueryClient()

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <MerchantProvider>{children}</MerchantProvider>
      </WalletProvider>
    </QueryClientProvider>
  )
}
