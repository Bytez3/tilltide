// Browser build. The sandbox uses a local test wallet; everywhere else, the owner's real wallet.
// Chosen once at build time, so the hooks below never change between renders.
import { AppConfig } from '@/constants/app-config'
import { StandardWalletProvider, useStandardWallet } from './standard-wallet'
import { TestWalletProvider, useTestWallet } from './test-wallet'

export const WalletProvider = AppConfig.sandbox ? TestWalletProvider : StandardWalletProvider
export const useWallet = AppConfig.sandbox ? useTestWallet : useStandardWallet
