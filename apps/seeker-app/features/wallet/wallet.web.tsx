/**
 * Browser test wallet for the local sandbox. It keeps a throwaway devnet keypair in localStorage and
 * signs like a real wallet would. It refuses to run unless EXPO_PUBLIC_SANDBOX=1, so it can never be
 * used against real money.
 */
import {

  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  signTransactionMessageWithSigners,
  type KeyPairSigner,
} from '@solana/kit'
import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { AppConfig } from '@/constants/app-config'
import type { TilltideWallet } from './types'

const STORAGE_KEY = 'tilltide:sandbox-wallet'
const enabled = process.env.EXPO_PUBLIC_SANDBOX === '1'

async function loadSigner(create: boolean): Promise<KeyPairSigner | null> {
  let hex = localStorage.getItem(STORAGE_KEY)
  if (!hex) {
    if (!create) return null
    hex = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(STORAGE_KEY, hex)
  }
  const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)))
  return createKeyPairSignerFromPrivateKeyBytes(bytes)
}

const Ctx = createContext<{ signer: KeyPairSigner | null; connect: () => Promise<KeyPairSigner>; disconnect: () => Promise<void> } | null>(null)

export function WalletProvider({ children }: PropsWithChildren) {
  const [signer, setSigner] = useState<KeyPairSigner | null>(null)
  useEffect(() => {
    if (enabled) loadSigner(false).then(setSigner).catch(() => setSigner(null))
  }, [])
  const connect = useCallback(async () => {
    if (!enabled) throw new Error('The browser test wallet only works in the local sandbox (EXPO_PUBLIC_SANDBOX=1).')
    const s = (await loadSigner(true))!
    setSigner(s)
    return s
  }, [])
  const disconnect = useCallback(async () => {
    setSigner(null)
  }, [])
  return <Ctx.Provider value={{ signer, connect, disconnect }}>{children}</Ctx.Provider>
}

export function useWallet(): TilltideWallet {
  const ctx = useContext(Ctx)!
  const rpc = useMemo(() => createSolanaRpc(AppConfig.rpcUrl), [])
  return useMemo<TilltideWallet>(
    () => ({
      account: ctx.signer ? { address: ctx.signer.address } : undefined,
      chain: 'solana:devnet',
      identityUri: AppConfig.identity.uri ?? '',
      isTestWallet: true,
      async signIn({ domain, statement, nonce }) {
        const signer = ctx.signer ?? (await ctx.connect())
        const text =
          `${domain} wants you to sign in with your Solana account:\n${signer.address}\n\n${statement}\n\n` +
          `URI: https://${domain}\nVersion: 1\nChain ID: solana:devnet\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`
        const signedMessage = new TextEncoder().encode(text)
        const signature = await signBytes(signer.keyPair.privateKey, signedMessage)
        return { address: signer.address, signedMessage, signature: new Uint8Array(signature) }
      },
      disconnect: ctx.disconnect,
      async getLatestBlockhash() {
        const { context, value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
        return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight, slot: context.slot }
      },
      async signAndSend(build, latest) {
        if (!ctx.signer) throw new Error('Sign in first')
        const instructions = await build(ctx.signer)
        const message = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => appendTransactionMessageInstructions(instructions, m),
          (m) => setTransactionMessageFeePayerSigner(ctx.signer!, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
        )
        const signed = await signTransactionMessageWithSigners(message)
        await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
        return getSignatureFromTransaction(signed)
      },
    }),
    [ctx, rpc],
  )
}

