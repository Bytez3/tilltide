import { address } from '@solana/kit'
import { getSweepInstructions, TOKENS } from '@tilltide/agent-pay-kit'
import { useCallback } from 'react'
import { api, ApiError, Merchant, Sweep } from '@/lib/api'
import { useWallet } from '@/features/wallet/wallet'

/**
 * Signs an agent-proposed sweep with the merchant's wallet and reports it to the backend, which
 * verifies it onchain. The only path by which funds leave the till.
 *
 * Never signs twice: it asks the backend to settle the sweep first (which also finds a transfer the
 * wallet sent but the app lost), locks it on the server until the blockhash expires, and refuses
 * while an earlier signature is still confirming.
 */
export function useSignSweep(merchant: Merchant | null) {
  const wallet = useWallet()

  return useCallback(
    async (sweep: Sweep): Promise<Sweep> => {
      if (!wallet.account || !merchant) throw new Error('Connect the till wallet first')
      if (wallet.account.address !== merchant.wallet) throw new Error('Connected wallet is not this shop’s till wallet')

      const latest = await api.checkSweep(sweep.id)
      if (latest.status !== 'proposed' && latest.status !== 'cancelled') return latest

      const blockhash = await wallet.getLatestBlockhash()
      // Lock the sweep on the server until this blockhash expires: even if everything after this point
      // fails, the sweep can't be signed again until the chain shows whether this one landed.
      await api.beginSweep(latest.id, blockhash.lastValidBlockHeight)
      const signature = await wallet.signAndSend(
        (signer) =>
          getSweepInstructions({
            from: signer,
            to: address(latest.toWallet),
            token: TOKENS[merchant.cluster][latest.token],
            amount: BigInt(latest.amount),
            fee: latest.feeWallet ? { to: address(latest.feeWallet), amount: BigInt(latest.feeAmount) } : undefined,
            sweepId: latest.id,
          }),
        blockhash,
      )

      // Report straight away; from now on the backend won't let this sweep be signed again.
      let result = await submitWithRetry(sweep.id, signature)
      for (let i = 0; i < 30 && result.status === 'submitted'; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        result = await api.checkSweep(sweep.id).catch(() => result)
      }
      return result
    },
    [merchant, wallet],
  )
}

async function submitWithRetry(id: string, signature: string): Promise<Sweep> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.submitSweep(id, signature)
    } catch (e) {
      // Retry network and server errors (the wallet has already sent it); a 4xx means it was rejected.
      const retryable = e instanceof ApiError && (e.status === 0 || e.status >= 500)
      if (!retryable || attempt >= 5) throw e
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}
