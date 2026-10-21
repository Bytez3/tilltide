import { address, type Address } from '@solana/kit'
import { TOKENS, type Cluster } from '@tilltide/agent-pay-kit'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env var ${name}`)
  return value
}

const cluster = (process.env.SOLANA_CLUSTER ?? 'devnet') as Cluster
if (cluster !== 'devnet' && cluster !== 'mainnet') throw new Error(`Unknown SOLANA_CLUSTER ${cluster}`)

export const config = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl: required('DATABASE_URL'),
  cluster,
  rpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
  tokens: TOKENS[cluster],
  pointsMint: process.env.POINTS_MINT ? (address(process.env.POINTS_MINT) as Address) : null,
  pointsAuthoritySecret: process.env.POINTS_AUTHORITY_SECRET ?? null,
  /** Must match the host of the app's MWA identity URI; wallets show it on the sign-in prompt. */
  authDomain: required('AUTH_DOMAIN'),
  /** Public base URL of this API, for PayPal return links. */
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  paypal:
    process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
      ? {
          clientId: process.env.PAYPAL_CLIENT_ID,
          clientSecret: process.env.PAYPAL_CLIENT_SECRET,
          env: (process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox') as 'sandbox' | 'live',
          apiBase: process.env.PAYPAL_API_BASE,
        }
      : null,
  /** Currency PayPal orders are taken in. USD keeps the ledger 1:1 with USDC/PYUSD. */
  paypalCurrency: process.env.PAYPAL_CURRENCY ?? 'USD',
  /** Unpaid requests stop being watched after this long. */
  paymentTtlMs: 30 * 60 * 1000,
  watchIntervalMs: 3000,
}
