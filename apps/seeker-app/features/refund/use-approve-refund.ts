import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { fromUint8Array } from 'js-base64'
import { useCallback } from 'react'
import { api, ApiError, Refund } from '@/lib/api'

/**
 * Approves a PayPal refund by having the till wallet sign the refund's exact wording (Sign In With
 * Solana format, single-use nonce). The server refunds through PayPal only after checking it.
 */
export function useApproveRefund() {
  const { chain, identity, signIn } = useMobileWallet()

  return useCallback(
    async (refund: Refund): Promise<Refund> => {
      // Always start from the server's view: the card may be stale.
      const latest = await api.getRefund(refund.id)
      // A refund interrupted mid-call is retried without a new signature (PayPal dedupes it).
      if (latest.status === 'processing') return api.approveRefund(latest.id)
      if (latest.status !== 'proposed') return latest
      const { nonce, domain, statement } = await api.refundChallenge(latest.id)
      const signed = await signIn({ domain, statement, uri: identity.uri, version: '1', chainId: chain, nonce })
      const signedMessage = fromUint8Array(signed.signedMessage)
      const signature = fromUint8Array(signed.signature)
      for (let attempt = 0; ; attempt++) {
        try {
          return await api.approveRefund(refund.id, signedMessage, signature)
        } catch (e) {
          const retryable = e instanceof ApiError && (e.status === 0 || e.status >= 500)
          if (!retryable || attempt >= 3) {
            // The server may have taken the approval before the connection dropped.
            const now = await api.getRefund(refund.id).catch(() => null)
            if (now && now.status !== 'proposed') return now
            throw e
          }
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    },
    [chain, identity.uri, signIn],
  )
}
