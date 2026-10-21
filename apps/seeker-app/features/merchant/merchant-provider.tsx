import AsyncStorage from '@react-native-async-storage/async-storage'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useState } from 'react'
import { api, Merchant } from '@/lib/api'

const storageKey = (wallet: string) => `tilltide:merchant:${wallet}`

interface MerchantContextValue {
  merchant: Merchant | null
  loading: boolean
  /** Connects the till wallet over MWA and registers the shop. */
  setUp: (shopName: string) => Promise<void>
  update: (patch: Parameters<typeof api.updateMerchant>[1]) => Promise<void>
}

const MerchantContext = createContext<MerchantContextValue | null>(null)

export function MerchantProvider({ children }: PropsWithChildren) {
  const { account, connect } = useMobileWallet()
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!account) {
        setMerchant(null)
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const id = await AsyncStorage.getItem(storageKey(account.address))
        const found = id ? await api.getMerchant(id).catch(() => null) : null
        if (!cancelled) setMerchant(found)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [account])

  const setUp = useCallback(
    async (shopName: string) => {
      const connected = account ?? (await connect())
      const registered = await api.registerMerchant(shopName, connected.address)
      await AsyncStorage.setItem(storageKey(connected.address), registered.id)
      setMerchant(registered)
    },
    [account, connect],
  )

  const update = useCallback(
    async (patch: Parameters<typeof api.updateMerchant>[1]) => {
      if (!merchant) return
      setMerchant(await api.updateMerchant(merchant.id, patch))
    },
    [merchant],
  )

  return <MerchantContext.Provider value={{ merchant, loading, setUp, update }}>{children}</MerchantContext.Provider>
}

export function useMerchant() {
  const ctx = useContext(MerchantContext)
  if (!ctx) throw new Error('useMerchant must be used inside MerchantProvider')
  return ctx
}
