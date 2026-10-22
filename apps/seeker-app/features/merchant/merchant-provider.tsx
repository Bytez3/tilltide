import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'
import { fromUint8Array } from 'js-base64'
import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api, ApiError, Merchant, setSession } from '@/lib/api'
import { useWallet } from '@/features/wallet/wallet'
import { AppConfig } from '@/constants/app-config'
import { useOnline } from '@/lib/connectivity'

const sessionKey = (wallet: string) => `tilltide:session:${wallet}`
/** A staff device has no wallet; its session is stored on its own. */
const STAFF_KEY = 'tilltide:staff-session'

interface MerchantContextValue {
  merchant: Merchant | null
  loading: boolean
  /** Sign In With Solana over MWA, then register the shop if it's new. */
  signInAndSetUp: (shopName: string) => Promise<void>
  /** Points the takings at a new owner wallet; the till wallet signs to approve it. */
  setOwnerWallet: (wallet: string) => Promise<Merchant>
  /** Saves settings and returns the shop as the server stored them. */
  update: (patch: Parameters<typeof api.updateShop>[0]) => Promise<Merchant>
  /** Replace the cached shop (e.g. after re-checking PayPal). */
  replace: (merchant: Merchant) => void
  signOut: () => Promise<void>
  /** Staff device: pair with the owner's one-time code. */
  pairStaff: (code: string) => Promise<void>
  isStaff: boolean
  /** The saved session couldn't be checked because the server was unreachable. Retries on its own. */
  unreachable: boolean
}

const MerchantContext = createContext<MerchantContextValue | null>(null)

export function MerchantProvider({ children }: PropsWithChildren) {
  const { account, signIn, disconnect, isTestWallet } = useWallet()
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [loading, setLoading] = useState(true)
  const [unreachable, setUnreachable] = useState(false)
  const [retry, setRetry] = useState(0)
  const online = useOnline()
  // The wallet connects partway through sign-in. Restoring then would swap the setup card for a spinner
  // and lose any error from the rest of sign-in, so sign-in finishes the job itself.
  const signingIn = useRef(false)

  // Back online after a failed restore: try again, so a till opened on bad wifi recovers by itself.
  useEffect(() => {
    if (online && unreachable) setRetry((n) => n + 1)
  }, [online, unreachable])

  const clearSession = useCallback(async (wallet?: string) => {
    setSession(null)
    setMerchant(null)
    if (wallet) await AsyncStorage.removeItem(sessionKey(wallet)).catch(() => {})
    else await AsyncStorage.removeItem(STAFF_KEY).catch(() => {})
  }, [])

  // Restore the session for the connected wallet.
  useEffect(() => {
    let cancelled = false
    async function restore() {
      if (signingIn.current) return
      setLoading(true)
      try {
        if (!account) {
          // No wallet: maybe this is a paired staff device.
          const staffToken = await AsyncStorage.getItem(STAFF_KEY)
          if (!staffToken) {
            setSession(null)
            setMerchant(null)
            return
          }
          setSession(staffToken, () => clearSession())
          const shop = await api.getShop()
          if (!cancelled) (setMerchant(shop), setUnreachable(false))
          return
        }
        const token = await AsyncStorage.getItem(sessionKey(account.address))
        // Not signed in with this wallet yet. Leave any saved staff pairing alone.
        if (!token) return (setSession(null), setMerchant(null))
        setSession(token, () => clearSession(account.address))
        const shop = await api.getShop().catch((e) => {
          if (e instanceof ApiError && e.status === 404) return null
          throw e
        })
        if (!cancelled) setMerchant(shop)
        if (!cancelled) setUnreachable(false)
      } catch (e) {
        if (cancelled) return
        // Only the server saying "no" signs the till out. A network error keeps the saved
        // session and shows "can't reach Tilltide" until the connection is back.
        if (e instanceof ApiError && e.status === 0) setUnreachable(true)
        else setMerchant(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    restore()
    return () => {
      cancelled = true
    }
  }, [account, clearSession, retry])

  // Keep the shop's settings fresh: the owner may change the currency or connect PayPal on another phone,
  // and a staff till should follow without a restart.
  const signedIn = !!merchant
  useEffect(() => {
    if (!signedIn) return
    const refreshShop = () => api.getShop().then(setMerchant).catch(() => {})
    const sub = AppState.addEventListener('change', (state) => state === 'active' && refreshShop())
    const timer = setInterval(refreshShop, 5 * 60_000)
    return () => (sub.remove(), clearInterval(timer))
  }, [signedIn])

  const approveOwnerWallet = useCallback(
    async (wallet: string) => {
      const { nonce, domain, statement } = await api.ownerWalletChallenge(wallet)
      const signed = await signIn({ domain, statement, nonce })
      return api.approveOwnerWallet(fromUint8Array(signed.signedMessage), fromUint8Array(signed.signature))
    },
    [signIn],
  )

  const setOwnerWallet = useCallback(
    async (wallet: string) => {
      const saved = await approveOwnerWallet(wallet)
      setMerchant(saved)
      return saved
    },
    [approveOwnerWallet],
  )

  const signInAndSetUp = useCallback(
    async (shopName: string) => {
      signingIn.current = true
      try {
        const { nonce, domain, statement } = await api.nonce()
        const result = await signIn({ domain, statement, nonce })
        const wallet = result.address
        const { token } = await api.verifySignIn(wallet, fromUint8Array(result.signedMessage), fromUint8Array(result.signature))
        await AsyncStorage.setItem(sessionKey(wallet), token)
        setSession(token, () => clearSession(wallet))

        // Browser sandbox: give the test wallet SOL for fees.
        if (isTestWallet && AppConfig.sandbox) await api.sandbox.airdrop(wallet).catch(() => {})

        const existing = await api.getShop().catch((e) => {
          if (e instanceof ApiError && e.status === 404) return null
          throw e
        })
        if (existing) return setMerchant(existing)
        if (!shopName.trim()) throw new Error('Enter your shop name to set up a new till')
        let shop = await api.registerShop(shopName.trim())
        // Sandbox: preset the test owner wallet so sweeps work straight away.
        if (isTestWallet && AppConfig.sandbox) {
          const info = await api.sandbox.info().catch(() => null)
          if (info) shop = await approveOwnerWallet(info.owner)
        }
        setMerchant(shop)
      } finally {
        signingIn.current = false
      }
    },
    [approveOwnerWallet, clearSession, isTestWallet, signIn],
  )

  const update = useCallback(async (patch: Parameters<typeof api.updateShop>[0]) => {
    const saved = await api.updateShop(patch)
    setMerchant(saved)
    return saved
  }, [])

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {})
    if (merchant?.role === 'staff') return clearSession()
    await clearSession(account?.address)
    await disconnect().catch(() => {})
  }, [account?.address, clearSession, disconnect, merchant?.role])

  const pairStaff = useCallback(
    async (code: string) => {
      const { token } = await api.pairStaff(code)
      await AsyncStorage.setItem(STAFF_KEY, token)
      setSession(token, () => clearSession())
      setMerchant(await api.getShop())
    },
    [clearSession],
  )

  return (
    <MerchantContext.Provider
      value={{ merchant, loading, signInAndSetUp, setOwnerWallet, update, signOut, replace: setMerchant, pairStaff, isStaff: merchant?.role === 'staff', unreachable: unreachable && !merchant }}
    >
      {children}
    </MerchantContext.Provider>
  )
}

export function useMerchant() {
  const ctx = useContext(MerchantContext)
  if (!ctx) throw new Error('useMerchant must be used inside MerchantProvider')
  return ctx
}
