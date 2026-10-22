// Round trip against a stand-in wallet that follows Phantom's deeplink spec: connect, then an
// encrypted signMessage request and reply. Run: pnpm --filter @tilltide/seeker-app test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import nacl from 'tweetnacl'
import { connectUrl, DEEPLINK_WALLETS, fromB58, newEncryptionKeypair, readConnect, readReply, requestUrl, signMessagePayload, toB58, WalletRejected } from './deeplink-protocol'

const phantom = DEEPLINK_WALLETS[0]!

/** What Phantom does on its side. */
function fakeWallet() {
  const enc = nacl.box.keyPair()
  const account = nacl.sign.keyPair()
  const session = 'session-token-123'
  const seal = (dappKey: Uint8Array, body: unknown) => {
    const nonce = nacl.randomBytes(24)
    const data = nacl.box(new TextEncoder().encode(JSON.stringify(body)), nonce, dappKey, enc.secretKey)
    return { nonce: toB58(nonce), data: toB58(data) }
  }
  return {
    address: toB58(account.publicKey),
    connect(url: string) {
      const q = new URL(url).searchParams
      assert.equal(new URL(url).pathname, '/ul/v1/connect')
      assert.equal(q.get('cluster'), 'devnet')
      const reply = seal(fromB58(q.get('dapp_encryption_public_key')!), { public_key: toB58(account.publicKey), session })
      return new URLSearchParams({ phantom_encryption_public_key: toB58(enc.publicKey), ...reply })
    },
    signMessage(url: string) {
      const q = new URL(url).searchParams
      const dappKey = fromB58(q.get('dapp_encryption_public_key')!)
      const plain = nacl.box.open(fromB58(q.get('payload')!), fromB58(q.get('nonce')!), dappKey, enc.secretKey)
      assert.ok(plain, 'wallet could not decrypt the request')
      const body = JSON.parse(new TextDecoder().decode(plain))
      assert.equal(body.session, session)
      const message = fromB58(body.message)
      return { message, reply: new URLSearchParams(seal(dappKey, { signature: toB58(nacl.sign.detached(message, account.secretKey)) })) }
    },
  }
}

test('connect, then sign a message, end to end', () => {
  const wallet = fakeWallet()
  const keys = newEncryptionKeypair()
  const url = connectUrl(phantom, { dappPublicKey: keys.publicKey, appUrl: 'https://tilltide.bytez3.com', redirect: 'tilltide://wallet-callback/connect', cluster: 'devnet' })
  const session = readConnect(phantom, keys.secretKey, wallet.connect(url))
  assert.equal(session.address, wallet.address)

  const text = new TextEncoder().encode('tilltide.bytez3.com wants you to sign in with your Solana account')
  const { message, reply } = wallet.signMessage(requestUrl(session, 'signMessage', signMessagePayload(text), 'tilltide://wallet-callback/signMessage'))
  assert.deepEqual(message, text)
  const { signature } = readReply<{ signature: string }>(session, reply)
  assert.ok(nacl.sign.detached.verify(text, fromB58(signature), fromB58(wallet.address)))
})

test('a refusal from the wallet becomes a clear error', () => {
  const keys = newEncryptionKeypair()
  assert.throws(() => readConnect(phantom, keys.secretKey, new URLSearchParams({ errorCode: '4001', errorMessage: 'User rejected the request' })), WalletRejected)
})

test('a reply sealed for someone else is refused', () => {
  const wallet = fakeWallet()
  const keys = newEncryptionKeypair()
  const reply = wallet.connect(connectUrl(phantom, { dappPublicKey: nacl.box.keyPair().publicKey, appUrl: 'https://x', redirect: 'tilltide://x', cluster: 'devnet' }))
  assert.throws(() => readConnect(phantom, keys.secretKey, reply), /Could not read/)
})
