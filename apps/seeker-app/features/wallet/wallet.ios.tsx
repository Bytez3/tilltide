// iPhone: Phantom or Solflare through their deeplink protocol (see deeplink-protocol.ts). Android uses
// Mobile Wallet Adapter (wallet.tsx) and the browser uses the Wallet Standard (wallet.web.tsx).
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from '@solana/kit'
import * as Linking from 'expo-linking'
import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Modal, Pressable, Text } from 'react-native'
import { Button } from '@/components/ui'
import { AppConfig } from '@/constants/app-config'
import { colors, fonts, ui } from '@/constants/theme'
import { api } from '@/lib/api'
import {
  connectUrl,
  DEEPLINK_WALLETS,
  newEncryptionKeypair,
  readConnect,
  readReply,
  requestUrl,
  signMessagePayload,
  transactionPayload,
  WalletRejected,
  fromB58,
  type DeeplinkSession,
  type DeeplinkWallet,
} from './deeplink-protocol'
import type { TilltideWallet } from './types'

const CHAIN = 'solana:devnet'
const CLUSTER = 'devnet'
const STORAGE_KEY = 'tilltide:ios-wallet'

/** Where the wallet sends the owner back to; app/wallet-callback/[method].tsx returns them to where they were. */
const redirectFor = (method: string) => Linking.createURL(`wallet-callback/${method}`)

interface Ctx {
  session: DeeplinkSession | null
  /** Opens the wallet with `url` and waits for it to send the owner back. */
  call: (url: string, method: string) => Promise<URLSearchParams>
  choose: () => Promise<DeeplinkWallet>
  save: (s: DeeplinkSession | null) => Promise<void>
}
const WalletCtx = createContext<Ctx | null>(null)

export function WalletProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<DeeplinkSession | null>(null)
  const [picking, setPicking] = useState(false)
  const pending = useRef<{ method: string; resolve: (p: URLSearchParams) => void; reject: (e: Error) => void } | null>(null)
  const pick = useRef<{ resolve: (w: DeeplinkWallet) => void; reject: (e: Error) => void } | null>(null)

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => raw && setSession(JSON.parse(raw)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const onUrl = ({ url }: { url: string }) => {
      const m = url.match(/wallet-callback\/([A-Za-z]+)\??(.*)$/)
      if (!m || !pending.current || pending.current.method !== m[1]) return
      pending.current.resolve(new URLSearchParams(m[2]))
      pending.current = null
    }
    const sub = Linking.addEventListener('url', onUrl)
    // Back in the app with no reply: the owner closed the wallet instead of answering.
    let timer: ReturnType<typeof setTimeout> | undefined
    const appState = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !pending.current) return
      const waiting = pending.current
      timer = setTimeout(() => {
        if (pending.current !== waiting) return
        waiting.reject(new WalletRejected('The wallet was closed without answering'))
        pending.current = null
      }, 3000)
    })
    return () => (sub.remove(), appState.remove(), clearTimeout(timer))
  }, [])

  const call = useCallback(async (url: string, method: string) => {
    pending.current?.reject(new Error('Replaced by a newer wallet request'))
    const reply = new Promise<URLSearchParams>((resolve, reject) => (pending.current = { method, resolve, reject }))
    await Linking.openURL(url)
    return reply
  }, [])

  const choose = useCallback(() => {
    setPicking(true)
    return new Promise<DeeplinkWallet>((resolve, reject) => (pick.current = { resolve, reject }))
  }, [])

  const finish = (w: DeeplinkWallet | null) => {
    setPicking(false)
    if (w) pick.current?.resolve(w)
    else pick.current?.reject(new Error('No wallet chosen'))
    pick.current = null
  }

  const save = useCallback(async (s: DeeplinkSession | null) => {
    setSession(s)
    if (s) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    else await AsyncStorage.removeItem(STORAGE_KEY)
  }, [])

  return (
    <WalletCtx.Provider value={{ session, call, choose, save }}>
      {children}
      <Modal visible={picking} transparent animationType="fade" onRequestClose={() => finish(null)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 16 }} onPress={() => finish(null)}>
          <Pressable style={ui.card} onPress={() => {}}>
            <Text style={ui.h2}>Choose your wallet</Text>
            <Text style={ui.muted}>Tilltide opens your wallet app to sign in, then brings you back here.</Text>
            {DEEPLINK_WALLETS.map((w) => (
              <Button key={w.name} title={w.name} variant="secondary" onPress={() => finish(w)} />
            ))}
            <Text style={ui.muted}>No wallet yet? Install Phantom or Solflare from the App Store, then come back.</Text>
            <Text style={[ui.muted, { textAlign: 'center', color: colors.sea, fontFamily: fonts.semibold }]} accessibilityRole="button" onPress={() => finish(null)}>
              Cancel
            </Text>
          </Pressable>
        </Pressable>
      </Modal>
    </WalletCtx.Provider>
  )
}

export function useWallet(): TilltideWallet {
  const { session, call, choose, save } = useContext(WalletCtx)!

  return useMemo<TilltideWallet>(
    () => ({
      account: session ? { address: session.address as Address } : undefined,
      chain: CHAIN,
      identityUri: AppConfig.identity.uri,
      isTestWallet: false,

      async signIn({ domain, statement, nonce }) {
        let s = session
        if (!s) {
          const wallet = await choose()
          const keys = newEncryptionKeypair()
          const reply = await call(
            connectUrl(wallet, { dappPublicKey: keys.publicKey, appUrl: AppConfig.identity.uri, redirect: redirectFor('connect'), cluster: CLUSTER }),
            'connect',
          )
          s = readConnect(wallet, keys.secretKey, reply)
          await save(s)
        }
        // These wallets have no Sign In With Solana request over deeplinks, so sign the same text as a message.
        const text =
          `${domain} wants you to sign in with your Solana account:\n${s.address}\n\n${statement}\n\n` +
          `URI: https://${domain}\nVersion: 1\nChain ID: ${CHAIN}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`
        const signedMessage = new TextEncoder().encode(text)
        const reply = await call(requestUrl(s, 'signMessage', signMessagePayload(signedMessage), redirectFor('signMessage')), 'signMessage')
        const { signature } = readReply<{ signature: string }>(s, reply)
        return { address: s.address, signedMessage, signature: fromB58(signature) }
      },

      async disconnect() {
        if (session) {
          // Tell the wallet too, but don't make the owner wait for it.
          Linking.openURL(requestUrl(session, 'disconnect', {}, redirectFor('disconnect'))).catch(() => {})
        }
        await save(null)
      },

      async getLatestBlockhash() {
        const latest = await api.blockhash()
        return { blockhash: latest.blockhash as Blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight), slot: BigInt(latest.slot) }
      },

      async signAndSend(build, latest) {
        if (!session) throw new Error('Connect the till wallet first')
        const signer = createNoopSigner(session.address as Address)
        const instructions = await build(signer)
        const message = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => appendTransactionMessageInstructions(instructions, m),
          (m) => setTransactionMessageFeePayer(signer.address, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
        )
        const wire = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)))
        const reply = await call(requestUrl(session, 'signAndSendTransaction', transactionPayload(wire), redirectFor('signAndSendTransaction')), 'signAndSendTransaction')
        return readReply<{ signature: string }>(session, reply).signature
      },
    }),
    [call, choose, save, session],
  )
}
