import AsyncStorage from '@react-native-async-storage/async-storage'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { fromUint8Array } from 'js-base64'
import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useState } from 'react'
import { api, ApiError, Merchant, setSession } from '@/lib/api'

const sessionKey = (wallet: string) => `tilltide:session:${wallet}`

interface MerchantContextValue {
  merchant: Merchant | null
  loading: boolean
  /** Sign In With Solana over MWA, then register the shop if it's new. */
  signInAndSetUp: (shopName: string) => Promise<void>
  update: (patch: Parameters<typeof api.updateShop>[0]) => Promise<void>
  signOut: () => Promise<void>
}

const MerchantContext = createContext<MerchantContextValue | null>(null)

export function MerchantProvider({ children }: PropsWithChildren) {
  const { account, chain, identity, signIn, disconnect } = useMobileWallet()
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [loading, setLoading] = useState(true)

  const clearSession = useCallback(async (wallet?: string) => {
    setSession(null)
    setMerchant(null)
    if (wallet) await AsyncStorage.removeItem(sessionKey(wallet)).catch(() => {})
  }, [])

  // Restore the session for the connected wallet.
  useEffect(() => {
    let cancelled = false
    async function restore() {
      setLoading(true)
      try {
        if (!account) return clearSession()
        const token = await AsyncStorage.getItem(sessionKey(account.address))
        if (!token) return clearSession()
        setSession(token, () => clearSession(account.address))
        const shop = await api.getShop().catch((e) => {
          if (e instanceof ApiError && e.status === 404) return null
          throw e
        })
        if (!cancelled) setMerchant(shop)
      } catch {
        if (!cancelled) setMerchant(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    restore()
    return () => {
      cancelled = true
    }
  }, [account, clearSession])

  const signInAndSetUp = useCallback(
    async (shopName: string) => {
      const { nonce, domain, statement } = await api.nonce()
      const result = await signIn({
        domain,
        statement,
        uri: identity.uri,
        version: '1',
        chainId: chain,
        nonce,
        issuedAt: new Date().toISOString(),
      })
      const wallet = result.account.address
      const { token } = await api.verifySignIn(wallet, fromUint8Array(result.signedMessage), fromUint8Array(result.signature))
      await AsyncStorage.setItem(sessionKey(wallet), token)
      setSession(token, () => clearSession(wallet))

      const existing = await api.getShop().catch((e) => {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      })
      if (existing) return setMerchant(existing)
      if (!shopName.trim()) throw new Error('Enter your shop name to set up a new till')
      setMerchant(await api.registerShop(shopName.trim()))
    },
    [chain, clearSession, identity.uri, signIn],
  )

  const update = useCallback(async (patch: Parameters<typeof api.updateShop>[0]) => {
    setMerchant(await api.updateShop(patch))
  }, [])

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {})
    await clearSession(account?.address)
    await disconnect().catch(() => {})
  }, [account?.address, clearSession, disconnect])

  return (
    <MerchantContext.Provider value={{ merchant, loading, signInAndSetUp, update, signOut }}>{children}</MerchantContext.Provider>
  )
}

export function useMerchant() {
  const ctx = useContext(MerchantContext)
  if (!ctx) throw new Error('useMerchant must be used inside MerchantProvider')
  return ctx
}
