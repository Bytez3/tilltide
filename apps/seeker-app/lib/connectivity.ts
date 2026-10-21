import { useEffect, useSyncExternalStore } from 'react'
import { AppConfig } from '@/constants/app-config'

/**
 * Whether the app can reach the Tilltide server. Every API call reports in; while offline we
 * check /health every few seconds so the till recovers on its own when the connection comes back.
 */
let online = true
const listeners = new Set<() => void>()

export function reportReachable(reachable: boolean) {
  if (reachable === online) return
  online = reachable
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useOnline(): boolean {
  const value = useSyncExternalStore(subscribe, () => online, () => true)
  useEffect(() => {
    if (value) return
    const timer = setInterval(() => {
      fetch(`${AppConfig.apiUrl}/health`)
        .then((r) => reportReachable(r.ok))
        .catch(() => reportReachable(false))
    }, 4000)
    return () => clearInterval(timer)
  }, [value])
  return value
}
