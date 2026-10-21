/**
 * Seeker bonus: customers who own a Solana Seeker phone earn extra loyalty points.
 *
 * A wallet counts if it holds a Seeker Genesis Token (one is minted per Seeker device; checked with
 * Solana Mobile's own package) or holds SKR, the Seeker ecosystem token. Both live on mainnet, so the
 * check always reads mainnet, even while payments run on devnet. Results are cached for an hour.
 */
import { address, createSolanaRpc, type Address } from '@solana/kit'
import { hasSeekerGenesisToken } from '@solana-mobile/skr-genesis-token'
import { config } from '../config'

/** SKR (Seeker) on mainnet, verified onchain: SPL Token, 6 decimals. */
export const SKR_MINT = address('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3')

const CACHE_MS = 60 * 60 * 1000
const cache = new Map<string, { seeker: boolean; at: number }>()

let mainnetRpc: ReturnType<typeof createSolanaRpc> | null = null
function rpc() {
  if (!config.seeker.rpcUrl) return null
  mainnetRpc ??= createSolanaRpc(config.seeker.rpcUrl)
  return mainnetRpc
}

async function holdsSkr(owner: Address): Promise<boolean> {
  const r = rpc()!
  const { value } = await r.getTokenAccountsByOwner(owner, { mint: SKR_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }).send()
  const min = config.seeker.skrMinimum
  return value.some((a) => {
    const amount = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount
    return amount !== undefined && BigInt(amount) >= min
  })
}

/** Whether this wallet belongs to a Seeker owner. Never throws: an RPC problem just means no bonus. */
export async function isSeekerCustomer(wallet: string): Promise<boolean> {
  if (config.seeker.testWallets.includes(wallet)) return true
  const r = rpc()
  if (!r) return false
  const cached = cache.get(wallet)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.seeker
  try {
    const owner = address(wallet)
    const seeker = (await hasSeekerGenesisToken(r, owner)) || (await holdsSkr(owner))
    cache.set(wallet, { seeker, at: Date.now() })
    return seeker
  } catch (err) {
    console.warn(`Seeker check for ${wallet} failed: ${err instanceof Error ? err.message : err}`)
    return false
  }
}
