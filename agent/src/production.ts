import { config } from './config'

export interface ConfigProblem {
  level: 'fatal' | 'warn'
  message: string
}

/**
 * Settings that matter once real money is involved. Fatal problems stop the API from starting on
 * mainnet; warnings are logged on every start.
 */
export function checkProductionConfig(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  if (config.cluster !== 'mainnet') return []
  const problems: ConfigProblem[] = []
  const fatal = (message: string) => problems.push({ level: 'fatal', message })
  const warn = (message: string) => problems.push({ level: 'warn', message })

  if (/api\.mainnet-beta\.solana\.com/.test(config.rpcUrl)) {
    fatal('SOLANA_RPC_URL is the public mainnet endpoint, which is rate-limited; use a provider (e.g. Helius, Triton, QuickNode)')
  }
  if (/up\.railway\.app$|github\.com$|localhost|\.test$/.test(config.authDomain)) {
    fatal(`AUTH_DOMAIN ${config.authDomain} isn't a domain you control; wallets show it on every sign-in`)
  }
  if (!config.publicUrl.startsWith('https://')) fatal('PUBLIC_URL must be https on mainnet (PayPal returns customers there)')
  if (config.corsOrigins.length) warn('CORS_ORIGINS is set; the mobile app does not need it (it is for the browser sandbox)')
  if (!config.originSecret) warn('ORIGIN_SECRET is not set, so the API can be reached directly, bypassing Cloudflare')
  if (!env.ALERT_WEBHOOK_URL) warn('ALERT_WEBHOOK_URL is not set: nobody hears about sweeps or refunds that need attention')
  if (!config.sweepFee.treasury) warn('TREASURY_WALLET is not set: no Tilltide fee is taken on sweeps')
  if (config.paypal && config.paypal.env !== 'live') warn('PAYPAL_ENV is not live: PayPal sales go to the sandbox')
  if (config.paypal && !config.paypalPlatform.requireConnected) {
    fatal('PAYPAL_REQUIRE_CONNECTED is false on mainnet: PayPal sales would go to the account that owns the API keys, not the shop')
  }
  if (!config.pointsMint || !config.pointsAuthoritySecret) warn('Loyalty points are not configured (POINTS_MINT / POINTS_AUTHORITY_SECRET)')
  if (config.seeker.testWallets.length) fatal('SEEKER_TEST_WALLETS gives the Seeker bonus to listed wallets; it is for tests and the sandbox only')
  if (env.FX_RATES) fatal('FX_RATES fixes exchange rates; it is for tests and the sandbox only')
  return problems
}
