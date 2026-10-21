import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from '@solana/kit'
import { config } from './config'

export const rpc = createSolanaRpc(config.rpcUrl)

let pointsAuthority: Promise<KeyPairSigner> | null = null

/** The loyalty mint authority. Lives only in env, never leaves the server. */
export function getPointsAuthority(): Promise<KeyPairSigner> | null {
  if (!config.pointsAuthoritySecret) return null
  pointsAuthority ??= createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(config.pointsAuthoritySecret)))
  return pointsAuthority
}

/** Signs with `feePayer` (plus any signers embedded in the instructions), sends, and waits for confirmation. */
export async function sendAndConfirm(feePayer: KeyPairSigner, instructions: Instruction[]): Promise<Signature> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  const signature = getSignatureFromTransaction(signed)
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' }).send()

  for (let i = 0; i < 30; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send()
    const status = value[0]
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Transaction ${signature} was not confirmed in time`)
}
