import { AppIdentity, createSolanaDevnet, SolanaCluster } from '@wallet-ui/react-native-kit'

export class AppConfig {
  // Wallets verify `uri` against the app's Digital Asset Links. Point it at the real site before mainnet.
  // Its host must equal the API's AUTH_DOMAIN, or Sign In With Solana is rejected.
  static identity: AppIdentity = {
    name: 'Tilltide',
    uri: process.env.EXPO_PUBLIC_APP_URI ?? 'https://github.com/Bytez3/tilltide',
    icon: 'favicon.png',
  }
  // Devnet until M4.
  static networks: SolanaCluster[] = [
    createSolanaDevnet({ url: process.env.EXPO_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com' }),
  ]
  // 10.0.2.2 is the host machine from the Android emulator. Use your LAN IP on a real device.
  static apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8787'
}
