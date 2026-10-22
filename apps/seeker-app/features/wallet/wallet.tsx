// Android / iOS: Mobile Wallet Adapter. The browser build uses wallet.web.tsx instead.
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type Blockhash,
} from '@solana/kit'
import { createSolanaDevnet, createSolanaMainnet, MobileWalletProvider, useMobileWallet } from '@wallet-ui/react-native-kit'
import { PropsWithChildren, useMemo } from 'react'
import { AppConfig } from '@/constants/app-config'
import { api } from '@/lib/api'
import type { TilltideWallet } from './types'

const cluster = (AppConfig.cluster === 'mainnet' ? createSolanaMainnet : createSolanaDevnet)({ url: AppConfig.rpcUrl })

export function WalletProvider({ children }: PropsWithChildren) {
  return (
    <MobileWalletProvider cluster={cluster} identity={AppConfig.identity}>
      {children}
    </MobileWalletProvider>
  )
}

export function useWallet(): TilltideWallet {
  const { account, chain, identity, signIn, disconnect, getTransactionSigner } = useMobileWallet()
  return useMemo<TilltideWallet>(
    () => ({
      account: account ? { address: account.address } : undefined,
      chain,
      identityUri: identity.uri ?? '',
      isTestWallet: false,
      async signIn({ domain, statement, nonce }) {
        const result = await signIn({ domain, statement, nonce, uri: identity.uri, version: '1', chainId: chain, issuedAt: new Date().toISOString() })
        // The signing account is line 2 of the SIWS message; the hook's account may be a different authorized one.
        const address = new TextDecoder().decode(result.signedMessage).split('\n')[1]?.trim() ?? result.account.address
        return { address, signedMessage: result.signedMessage, signature: result.signature }
      },
      disconnect,
      async getLatestBlockhash() {
        // From the Tilltide server's RPC, so the app never carries an RPC key.
        const latest = await api.blockhash()
        return {
          blockhash: latest.blockhash as Blockhash,
          lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
          slot: BigInt(latest.slot),
        }
      },
      async signAndSend(build, latest) {
        if (!account) throw new Error('Connect the till wallet first')
        // One signer object for fee payer and every instruction, so the wallet signs once.
        const signer = getTransactionSigner(account.address, latest.slot)
        const instructions = await build(signer)
        const message = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => appendTransactionMessageInstructions(instructions, m),
          (m) => setTransactionMessageFeePayerSigner(signer, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
        )
        return getBase58Decoder().decode(await signAndSendTransactionMessageWithSigners(message))
      },
    }),
    [account, chain, disconnect, getTransactionSigner, identity.uri, signIn],
  )
}
