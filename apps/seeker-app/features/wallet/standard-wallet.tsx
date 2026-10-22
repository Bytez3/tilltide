/**
 * Real wallets in a phone or desktop browser, through the Wallet Standard. That covers:
 * - wallet extensions on a computer (Phantom, Solflare, Backpack, …)
 * - a wallet app's own browser, which is how iPhones connect (Mobile Wallet Adapter is Android-only)
 * - Android Chrome, through Mobile Wallet Adapter, which opens the wallet app on the phone
 * Keys stay in the wallet. The server only ever sees signatures.
 */
import {
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
  registerMwa,
} from '@solana-mobile/wallet-standard-mobile'
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
} from '@solana/kit'
import {
  SolanaSignAndSendTransaction,
  SolanaSignIn,
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignInFeature,
  type SolanaSignMessageFeature,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features'
import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from '@wallet-standard/features'
import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Linking, Modal, Pressable, Text, View } from 'react-native'
import { Button } from '@/components/ui'
import { AppConfig } from '@/constants/app-config'
import { colors, fonts, ui } from '@/constants/theme'
import { api } from '@/lib/api'
import type { TilltideWallet } from './types'

const CHAIN = 'solana:devnet' as const
/** The wallet the owner last used, so a reload reconnects to it without asking. */
const LAST_WALLET = 'tilltide:wallet'

type Features = Partial<
  StandardConnectFeature &
    StandardDisconnectFeature &
    StandardEventsFeature &
    SolanaSignInFeature &
    SolanaSignMessageFeature &
    SolanaSignAndSendTransactionFeature &
    SolanaSignTransactionFeature
>
const features = (w: Wallet) => w.features as Features

/** Wallets that can sign the owner in and sign transactions on Solana. */
function usable(w: Wallet) {
  const f = features(w)
  return (
    w.chains.some((c) => c.startsWith('solana:')) &&
    !!f[StandardConnect] &&
    !!(f[SolanaSignIn] || f[SolanaSignMessage]) &&
    !!(f[SolanaSignAndSendTransaction] || f[SolanaSignTransaction])
  )
}

if (typeof window !== 'undefined') {
  // Android Chrome only (it does nothing elsewhere): offers the phone's wallet apps as one "wallet".
  registerMwa({
    appIdentity: { name: AppConfig.identity.name, uri: window.location.origin, icon: AppConfig.identity.icon },
    authorizationCache: createDefaultAuthorizationCache(),
    chains: [CHAIN],
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  })
}

function storage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

interface Ctx {
  wallets: Wallet[]
  wallet: Wallet | null
  account: WalletAccount | null
  /** Asks the owner which wallet to use (skipped when there's only one), then connects to it. */
  choose: () => Promise<Wallet>
  setConnected: (wallet: Wallet, account: WalletAccount) => void
  disconnect: () => Promise<void>
}
const WalletCtx = createContext<Ctx | null>(null)

export function StandardWalletProvider({ children }: PropsWithChildren) {
  const [wallets, setWallets] = useState<Wallet[]>(() => getWallets().get().filter(usable))
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [account, setAccount] = useState<WalletAccount | null>(null)
  const [picking, setPicking] = useState(false)
  const pick = useRef<{ resolve: (w: Wallet) => void; reject: (e: Error) => void } | null>(null)

  useEffect(() => {
    const { get, on } = getWallets()
    const refresh = () => setWallets(get().filter(usable))
    refresh()
    const offs = [on('register', refresh), on('unregister', refresh)]
    return () => offs.forEach((off) => off())
  }, [])

  // Reconnect quietly to the wallet used last time, so a reload keeps the till signed in.
  const reconnecting = useRef(false)
  useEffect(() => {
    if (wallet || reconnecting.current) return
    const last = storage()?.getItem(LAST_WALLET)
    const w = last && wallets.find((x) => x.name === last)
    if (!w) return
    reconnecting.current = true
    features(w)[StandardConnect]!
      .connect({ silent: true })
      .then(({ accounts }) => {
        // Skip it if the owner signed out (or chose another wallet) while this was in flight.
        if (accounts[0] && storage()?.getItem(LAST_WALLET) === w.name) (setWallet((cur) => cur ?? w), setAccount((cur) => cur ?? accounts[0]!))
      })
      .catch(() => {})
      .finally(() => (reconnecting.current = false))
  }, [wallet, wallets])

  // Follow account switches inside the wallet.
  useEffect(() => {
    const events = wallet && features(wallet)[StandardEvents]
    if (!events) return
    return events.on('change', ({ accounts }) => {
      if (accounts) setAccount(accounts[0] ?? null)
    })
  }, [wallet])

  const choose = useCallback(() => {
    if (wallets.length === 1) return Promise.resolve(wallets[0]!)
    pick.current?.reject(new Error('No wallet chosen'))
    setPicking(true)
    return new Promise<Wallet>((resolve, reject) => (pick.current = { resolve, reject }))
  }, [wallets])

  const finish = (w: Wallet | null) => {
    setPicking(false)
    if (w) pick.current?.resolve(w)
    else pick.current?.reject(new Error('No wallet chosen'))
    pick.current = null
  }

  const setConnected = useCallback((w: Wallet, a: WalletAccount) => {
    setWallet(w)
    setAccount(a)
    storage()?.setItem(LAST_WALLET, w.name)
  }, [])

  const disconnect = useCallback(async () => {
    await (wallet && features(wallet)[StandardDisconnect]?.disconnect().catch(() => {}))
    storage()?.removeItem(LAST_WALLET)
    setWallet(null)
    setAccount(null)
  }, [wallet])

  return (
    <WalletCtx.Provider value={{ wallets, wallet, account, choose, setConnected, disconnect }}>
      {children}
      <WalletPicker visible={picking} wallets={wallets} onPick={finish} />
    </WalletCtx.Provider>
  )
}

/** Opens this page inside a wallet app's own browser: how an iPhone (or any phone) without a wallet extension connects. */
function walletBrowserLinks() {
  const here = encodeURIComponent(window.location.href)
  const ref = encodeURIComponent(window.location.origin)
  return [
    { name: 'Phantom', url: `https://phantom.app/ul/browse/${here}?ref=${ref}` },
    { name: 'Solflare', url: `https://solflare.com/ul/v1/browse/${here}?ref=${ref}` },
  ]
}

function WalletPicker({ visible, wallets, onPick }: { visible: boolean; wallets: Wallet[]; onPick: (w: Wallet | null) => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => onPick(null)}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 16 }} onPress={() => onPick(null)}>
        <Pressable style={[ui.card, { maxWidth: 420, width: '100%', alignSelf: 'center' }]} onPress={() => {}}>
          <Text style={ui.h2}>{wallets.length ? 'Choose your wallet' : 'Open Tilltide in your wallet'}</Text>
          {wallets.map((w) => (
            <Pressable
              key={w.name}
              accessibilityRole="button"
              onPress={() => onPick(w)}
              style={({ pressed }) => [ui.row, { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.line, opacity: pressed ? 0.7 : 1 }]}
            >
              <Image source={{ uri: w.icon }} style={{ width: 28, height: 28, borderRadius: 6 }} />
              <Text style={[ui.body, { fontFamily: fonts.semibold }]}>{w.name}</Text>
            </Pressable>
          ))}
          {!wallets.length && (
            <>
              <Text style={ui.muted}>
                No wallet was found in this browser. If you have Phantom or Solflare on this phone, open Tilltide inside it and sign in there.
              </Text>
              {walletBrowserLinks().map((l) => (
                <Button key={l.name} title={`Open in ${l.name}`} variant="secondary" onPress={() => Linking.openURL(l.url)} />
              ))}
              <Text style={ui.muted}>No wallet yet? Install Phantom or Solflare from your phone&apos;s app store, then come back.</Text>
            </>
          )}
          <Text style={[ui.muted, { textAlign: 'center', color: colors.sea, fontFamily: fonts.semibold }]} accessibilityRole="button" onPress={() => onPick(null)}>
            Cancel
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const b58 = getBase58Decoder()
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

export function useStandardWallet(): TilltideWallet {
  const ctx = useContext(WalletCtx)!
  const { wallet, account } = ctx
  const rpc = useMemo(() => createSolanaRpc(AppConfig.rpcUrl), [])

  return useMemo<TilltideWallet>(
    () => ({
      account: account ? { address: account.address as Address } : undefined,
      chain: CHAIN,
      identityUri: AppConfig.identity.uri,
      isTestWallet: false,

      async signIn({ domain, statement, nonce }) {
        // Refund approvals reuse sign-in: keep the wallet that's already connected.
        const w = wallet ?? (await ctx.choose())
        const f = features(w)
        const issuedAt = new Date().toISOString()
        if (f[SolanaSignIn]) {
          const [out] = await f[SolanaSignIn].signIn({ domain, statement, nonce, uri: `https://${domain}`, version: '1', chainId: CHAIN, issuedAt })
          if (!out) throw new Error('The wallet did not sign in')
          const address = new TextDecoder().decode(out.signedMessage).split('\n')[1]?.trim() ?? out.account.address
          // Approving a refund: the wallet may let the owner pick another account. Refuse rather than
          // switch the till to it, which would sign the till out.
          if (account && address !== account.address) throw new Error(`Sign with the till's wallet account (${short(account.address)}). To use another account, sign out first.`)
          ctx.setConnected(w, out.account)
          return { address, signedMessage: out.signedMessage, signature: out.signature }
        }
        // Older wallets: connect, then sign the same Sign In With Solana text as a plain message.
        const acct = account ?? (await f[StandardConnect]!.connect()).accounts[0]
        if (!acct) throw new Error('The wallet did not share an account')
        ctx.setConnected(w, acct)
        const text =
          `${domain} wants you to sign in with your Solana account:\n${acct.address}\n\n${statement}\n\n` +
          `URI: https://${domain}\nVersion: 1\nChain ID: ${CHAIN}\nNonce: ${nonce}\nIssued At: ${issuedAt}`
        const signedMessage = new TextEncoder().encode(text)
        const [out] = await f[SolanaSignMessage]!.signMessage({ account: acct, message: signedMessage })
        if (!out) throw new Error('The wallet did not sign')
        return { address: acct.address, signedMessage, signature: out.signature }
      },

      disconnect: ctx.disconnect,

      async getLatestBlockhash() {
        // From the Tilltide server's RPC, as on the phone app.
        const latest = await api.blockhash()
        return { blockhash: latest.blockhash as Blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight), slot: BigInt(latest.slot) }
      },

      async signAndSend(build, latest) {
        if (!wallet || !account) throw new Error('Connect the till wallet first')
        // Build with a placeholder signer; the wallet adds the real signature.
        const signer = createNoopSigner(account.address as Address)
        const instructions = await build(signer)
        const message = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => appendTransactionMessageInstructions(instructions, m),
          (m) => setTransactionMessageFeePayer(signer.address, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
        )
        const transaction = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)))
        const f = features(wallet)
        if (f[SolanaSignAndSendTransaction]) {
          const [out] = await f[SolanaSignAndSendTransaction].signAndSendTransaction({ account, chain: CHAIN, transaction })
          if (!out) throw new Error('The wallet did not send the transaction')
          return b58.decode(out.signature)
        }
        // Sign-only wallets: send it ourselves. The fee payer's signature is the transaction's id.
        const [out] = await f[SolanaSignTransaction]!.signTransaction({ account, chain: CHAIN, transaction })
        if (!out) throw new Error('The wallet did not sign the transaction')
        const wire = getBase64Decoder().decode(out.signedTransaction) as Base64EncodedWireTransaction
        return rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
      },
    }),
    [account, ctx, rpc, wallet],
  )
}
