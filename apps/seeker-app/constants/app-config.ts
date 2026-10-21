
export class AppConfig {
  // Wallets verify `uri` against the app's Digital Asset Links. Point it at the real site before mainnet.
  // Its host must equal the API's AUTH_DOMAIN, or Sign In With Solana is rejected.
  static identity: { name: string; uri: string; icon: string } = {
    name: 'Tilltide',
    uri: process.env.EXPO_PUBLIC_APP_URI ?? 'https://api-production-83900.up.railway.app',
    icon: 'favicon.png',
  }
  // Devnet until M4. The browser sandbox points this at a local validator.
  static rpcUrl = process.env.EXPO_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
  static sandbox = process.env.EXPO_PUBLIC_SANDBOX === '1'
  // The live API. For local development set EXPO_PUBLIC_API_URL (10.0.2.2 reaches your computer from the emulator).
  static apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'https://api-production-83900.up.railway.app'
}
