import { address, type Address } from '@solana/kit'
import { TOKENS, type Cluster } from '@tilltide/agent-pay-kit'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env var ${name}`)
  return value
}

const cluster = (process.env.SOLANA_CLUSTER ?? 'devnet') as Cluster
if (cluster !== 'devnet' && cluster !== 'mainnet') throw new Error(`Unknown SOLANA_CLUSTER ${cluster}`)
const feeBps = Number(process.env.SWEEP_FEE_BPS ?? 50)
if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 500) throw new Error('SWEEP_FEE_BPS must be a whole number from 0 to 500')

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
  agent: {
    model: process.env.AGENT_MODEL ?? 'claude-opus-5',
    /** Chat questions are short lookups; low effort keeps answers fast and cheap. */
    effort: (process.env.AGENT_EFFORT ?? 'low') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    dailyLimit: Number(process.env.AGENT_DAILY_LIMIT ?? 50),
  },
  /** Tilltide's fee on sweeps. Off unless a treasury wallet is set. */
  sweepFee: {
    treasury: process.env.TREASURY_WALLET ? (address(process.env.TREASURY_WALLET) as Address) : null,
    bps: feeBps,
  },
  /** Shared secret Cloudflare adds as x-tilltide-origin. When set, requests without it are refused. */
  originSecret: process.env.ORIGIN_SECRET || null,
  rateLimits: {
    /** Requests per minute per IP, and sign-in attempts per minute per IP. */
    perIp: Number(process.env.RATE_LIMIT_PER_IP ?? 300),
    auth: Number(process.env.RATE_LIMIT_AUTH ?? 20),
  },
  /** SHA-256 fingerprints of the Android signing certs, for /.well-known/assetlinks.json. */
  androidCertSha256: (process.env.ANDROID_CERT_SHA256 ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Unpaid requests stop being watched after this long. */
  paymentTtlMs: 30 * 60 * 1000,
  watchIntervalMs: 3000,
}
