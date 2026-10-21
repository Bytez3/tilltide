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
  type Base64EncodedWireTransaction,
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

/** Builds and signs a transaction. The signature is known before anything is sent. */
export async function signTransaction(feePayer: KeyPairSigner, instructions: Instruction[]) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  return { wire: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed) }
}

export class TransactionFailedError extends Error {}

/** Sends a signed transaction and waits for confirmation. Throws if it fails onchain or isn't confirmed in time. */
export async function sendAndConfirmWire(wire: Base64EncodedWireTransaction, signature: Signature): Promise<void> {
  await rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
  for (let i = 0; i < 30; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send()
    const status = value[0]
    if (status?.err) throw new TransactionFailedError(`Transaction ${signature} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Transaction ${signature} was not confirmed in time`)
}

export async function sendAndConfirm(feePayer: KeyPairSigner, instructions: Instruction[]): Promise<Signature> {
  const { wire, signature } = await signTransaction(feePayer, instructions)
  await sendAndConfirmWire(wire, signature)
  return signature
}
