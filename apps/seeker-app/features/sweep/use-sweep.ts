import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
} from '@solana/kit'
import { getSweepInstructions, TOKENS } from '@tilltide/agent-pay-kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useCallback } from 'react'
import { api, Merchant, Sweep } from '@/lib/api'

/**
 * Signs an agent-proposed sweep with the merchant's wallet (MWA), then reports the signature
 * so the backend can verify it. The only path by which funds leave the till.
 */
export function useSignSweep(merchant: Merchant | null) {
  const { account, client, getTransactionSigner } = useMobileWallet()

  return useCallback(
    async (sweep: Sweep): Promise<Sweep> => {
      if (!account || !merchant) throw new Error('Connect the till wallet first')
      if (account.address !== merchant.wallet) throw new Error('Connected wallet is not this shop’s till wallet')

      const {
        context: { slot },
        value: blockhash,
      } = await client.rpc.getLatestBlockhash().send()
      // One signer object for both fee payer and transfer authority, so the wallet signs once.
      const signer = getTransactionSigner(account.address, slot)
      const instructions = await getSweepInstructions({
        from: signer,
        to: address(sweep.toWallet),
        token: TOKENS[merchant.cluster][sweep.token],
        amount: BigInt(sweep.amount),
      })
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => appendTransactionMessageInstructions(instructions, m),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      )
      const signature = getBase58Decoder().decode(await signAndSendTransactionMessageWithSigners(message))

      // The backend checks the transfer landed before marking the sweep confirmed.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          return await api.confirmSweep(sweep.id, signature)
        } catch (e) {
          if (attempt === 9) throw e
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
      throw new Error('Unreachable')
    },
    [account, client, getTransactionSigner, merchant],
  )
}
