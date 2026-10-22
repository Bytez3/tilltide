/**
 * Everything in EXPO_PUBLIC_* is built into the app, and anyone can read an app's files. Refuse to start
 * with anything that looks like a secret in it, rather than quietly shipping a paid RPC key.
 */
function publicOnly(url: string): string {
  if (/api[-_]?key|apikey|token=|secret|auth=/i.test(url)) {
    throw new Error('EXPO_PUBLIC_SOLANA_RPC_URL contains a key. Keys must stay on the server (SOLANA_RPC_URL in the API), never in the app.')
  }
  return url
}


export class AppConfig {
  // Wallets verify `uri` against the app's Digital Asset Links. Point it at the real site before mainnet.
  // Its host must equal the API's AUTH_DOMAIN, or Sign In With Solana is rejected.
  static identity: { name: string; uri: string; icon: string } = {
    name: 'Tilltide',
    uri: process.env.EXPO_PUBLIC_APP_URI ?? 'https://tilltide.bytez3.com',
    icon: 'favicon.png',
  }
  /** Must match the API's SOLANA_CLUSTER: wallets sign for this chain and the server checks it. */
  static cluster: 'devnet' | 'mainnet' = process.env.EXPO_PUBLIC_SOLANA_CLUSTER === 'mainnet' ? 'mainnet' : 'devnet'
  static chain = `solana:${AppConfig.cluster}` as const
  // Devnet until M4. The browser sandbox points this at a local validator. The phone app itself no longer
  // calls an RPC (blockhashes come from the Tilltide server); this is only the wallet adapter's cluster.
  static rpcUrl = publicOnly(
    process.env.EXPO_PUBLIC_SOLANA_RPC_URL ?? (AppConfig.cluster === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com'),
  )
  static sandbox = process.env.EXPO_PUBLIC_SANDBOX === '1'
  // The live API. For local development set EXPO_PUBLIC_API_URL (10.0.2.2 reaches your computer from the emulator).
  static apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'https://tilltide.bytez3.com'
}
