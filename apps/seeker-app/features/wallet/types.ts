import type { Address, Blockhash, Instruction, TransactionSigner } from '@solana/kit'

export interface SignedIn {
  /** The account that signed (read from the signed message itself). */
  address: string
  signedMessage: Uint8Array
  signature: Uint8Array
}

export interface LatestBlockhash {
  blockhash: Blockhash
  lastValidBlockHeight: bigint
  slot: bigint
}

/** What the app needs from a wallet. Android: Mobile Wallet Adapter. Browser sandbox: a local test wallet. */
export interface TilltideWallet {
  account: { address: Address } | undefined
  /** e.g. 'solana:devnet' */
  chain: string
  identityUri: string
  /** True for the browser test wallet, so the UI can say so. */
  isTestWallet: boolean
  /** Sign In With Solana (also used to approve refunds). */
  signIn(input: { domain: string; statement: string; nonce: string }): Promise<SignedIn>
  disconnect(): Promise<void>
  getLatestBlockhash(): Promise<LatestBlockhash>
  /** Builds instructions with the wallet's signer, then signs and sends; returns the base58 signature. */
  signAndSend(build: (signer: TransactionSigner) => Promise<Instruction[]>, latest: LatestBlockhash): Promise<string>
}
