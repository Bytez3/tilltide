/**
 * Phantom's and Solflare's deeplink protocol, which is how an iPhone app talks to a wallet app
 * (Mobile Wallet Adapter is Android-only). Each request opens the wallet with a link; the wallet
 * answers by opening our redirect link. Everything after `connect` is encrypted with a NaCl box
 * between a keypair we make and the wallet's, so other apps can't read or forge the replies.
 *
 * Pure functions with no React Native imports, so the round trip can be tested in Node.
 */
import { getBase58Decoder, getBase58Encoder } from '@solana/kit'
import nacl from 'tweetnacl'

export interface DeeplinkWallet {
  name: 'Phantom' | 'Solflare'
  /** Base of the wallet's universal links; works whether or not the app is installed. */
  base: string
  /** The query parameter the wallet's encryption key comes back in. */
  keyParam: string
}

export const DEEPLINK_WALLETS: DeeplinkWallet[] = [
  { name: 'Phantom', base: 'https://phantom.app/ul/v1', keyParam: 'phantom_encryption_public_key' },
  { name: 'Solflare', base: 'https://solflare.com/ul/v1', keyParam: 'solflare_encryption_public_key' },
]

// Use the platform's secure random source (react-native-quick-crypto on phones, Web Crypto in Node).
nacl.setPRNG((out, n) => out.set(crypto.getRandomValues(new Uint8Array(n))))

const toB58 = (b: Uint8Array) => getBase58Decoder().decode(b)
const fromB58 = (s: string) => new Uint8Array(getBase58Encoder().encode(s))

/** Our side of an encrypted session with one wallet. Saved so the till stays connected across launches. */
export interface DeeplinkSession {
  wallet: DeeplinkWallet['name']
  /** Our encryption secret key (base58). Only protects this channel; it can't move money. */
  dappSecret: string
  /** The wallet's encryption public key (base58). */
  walletKey: string
  /** The wallet's session token, sent back with every request. */
  session: string
  /** The connected account. */
  address: string
}

export function newEncryptionKeypair() {
  return nacl.box.keyPair()
}

export class WalletRejected extends Error {
  /** The wallet's error code, e.g. '4001' when the owner said no. */
  constructor(message: string, readonly code?: string) {
    super(message)
  }
}

function check(params: URLSearchParams) {
  const code = params.get('errorCode')
  if (code) throw new WalletRejected(params.get('errorMessage') || `The wallet refused (error ${code})`, code)
}

export function connectUrl(wallet: DeeplinkWallet, opts: { dappPublicKey: Uint8Array; appUrl: string; redirect: string; cluster: string }) {
  const q = new URLSearchParams({
    app_url: opts.appUrl,
    dapp_encryption_public_key: toB58(opts.dappPublicKey),
    redirect_link: opts.redirect,
    cluster: opts.cluster,
  })
  return `${wallet.base}/connect?${q}`
}

/** Reads the wallet's reply to `connect` into a session. */
export function readConnect(wallet: DeeplinkWallet, dappSecret: Uint8Array, reply: URLSearchParams): DeeplinkSession {
  check(reply)
  const walletKey = reply.get(wallet.keyParam)
  if (!walletKey) throw new Error(`${wallet.name} did not return an encryption key`)
  const data = open(dappSecret, walletKey, reply) as { public_key: string; session: string }
  return { wallet: wallet.name, dappSecret: toB58(dappSecret), walletKey, session: data.session, address: data.public_key }
}

function open(dappSecret: Uint8Array, walletKey: string, reply: URLSearchParams): unknown {
  const nonce = reply.get('nonce')
  const data = reply.get('data')
  if (!nonce || !data) throw new Error('The wallet reply was incomplete')
  const shared = nacl.box.before(fromB58(walletKey), dappSecret)
  const plain = nacl.box.open.after(fromB58(data), fromB58(nonce), shared)
  if (!plain) throw new Error('Could not read the wallet reply')
  return JSON.parse(new TextDecoder().decode(plain))
}

/** An encrypted request (signMessage, signAndSendTransaction, signTransaction, disconnect). */
export function requestUrl(s: DeeplinkSession, method: string, payload: Record<string, unknown>, redirect: string) {
  const wallet = DEEPLINK_WALLETS.find((w) => w.name === s.wallet)!
  const secret = fromB58(s.dappSecret)
  const nonce = nacl.randomBytes(24)
  const shared = nacl.box.before(fromB58(s.walletKey), secret)
  const sealed = nacl.box.after(new TextEncoder().encode(JSON.stringify({ ...payload, session: s.session })), nonce, shared)
  const q = new URLSearchParams({
    dapp_encryption_public_key: toB58(nacl.box.keyPair.fromSecretKey(secret).publicKey),
    nonce: toB58(nonce),
    redirect_link: redirect,
    payload: toB58(sealed),
  })
  return `${wallet.base}/${method}?${q}`
}

/** Reads the wallet's encrypted reply to a request. */
export function readReply<T>(s: DeeplinkSession, reply: URLSearchParams): T {
  check(reply)
  return open(fromB58(s.dappSecret), s.walletKey, reply) as T
}

export const signMessagePayload = (message: Uint8Array) => ({ message: toB58(message), display: 'utf8' })
export const transactionPayload = (wireTransaction: Uint8Array) => ({ transaction: toB58(wireTransaction) })
export { fromB58, toB58 }
